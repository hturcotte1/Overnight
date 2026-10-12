// The night flow behind `overnight build` and `overnight build-now <id>`.
//
// Our own code drives everything. For each idea waiting for a build, one at a time: make a slug,
// make an empty workspace with the brief in it, move the idea to "building", run the primary
// backend, and if that fails or cannot start, try the other backend once in a fresh workspace.
// Then the idea becomes "built", or "build_failed" with a reason in plain words. The build agent
// never touches the database: every state change happens here, through the store's state machine.
//
// Being told to stop (Ctrl-C, launchd stopping the job, or `deps.signal` aborted by the command
// line): the build in progress is ended (the Kiro Crew run is cancelled and its job removed, Kiro
// CLI's process group is killed), its idea is recorded as build_failed with the reason "the
// build was stopped", no further build starts, and the function resolves. All within 10 seconds.
//
// A build that was stopped, or found cut off afterwards, is not the idea's fault. The nightly run
// tries it once more on a later night: such an idea waits in the same line as the approved ones.
// The rule is core's (isBuildAwaitingRetry): at most two starts, and never once the wearer has
// been told. A build that failed (the agent could not make the app) is never tried again by itself.
//
// A finished build does not stay where it was built. As soon as its idea is recorded as "built",
// the workspace is moved to <data>/built/<idea id>, which no build job can reach (seal.ts).
//
// What builds cost is counted: one row in the month's ledger for every try that started an agent,
// with the builder's own figure when it gave one and an estimate when it did not. Before each
// idea the month's ceiling is asked (MAX_BUILD_CREDITS_PER_MONTH, core's build-budget.ts); once it
// is reached nothing more is started until next month. It is never asked in the middle of a
// build. A ledger that cannot be written or read never stops a build: the ceiling fails open.
//
// Log lines carry ids, states, counts and our own reasons. Never a title or a pitch.
import { budgetReachedText, buildBudget, errorSummary, estimatedBuildCredits, formatLocal, HIGHEST_BUILD_CREDIT_LIMIT, isBuildAwaitingRetry, localDayBounds } from "@overnight/core";
import type { BuildBudget, Config, DataPaths, Idea, Logger, Store } from "@overnight/core";
import { renderBrief } from "./brief.ts";
import { isStopping, onStopSignal } from "./run.ts";
import { retireSealed, sealWorkspace } from "./seal.ts";
import { isSlug, slugFor } from "./slug.ts";
import type { RenewSignIn } from "./kiro-signin.ts";
import { INTERRUPTED_REASON, MINUTE_MS, STOPPED_REASON } from "./types.ts";
import type { BuildBackend, BuildJob, BuildOutcome } from "./types.ts";
import { prepareWorkspace } from "./workspace.ts";

export interface BuildDeps {
  store: Store;
  config: Config;
  paths: DataPaths;
  backends: { primary: BuildBackend; fallback: BuildBackend | null };
  logger: Logger;
  now?: () => Date;
  /**
   * Abort this to stop: the build in progress is ended and recorded as "the build was stopped",
   * nothing further is started, and runBuildNight / buildOne resolve within 10 seconds. The
   * same happens by itself when this process gets SIGINT, SIGTERM or SIGHUP during a run.
   */
  signal?: AbortSignal;
  /**
   * Called before every try on a builder, outside any sandbox: makes sure Kiro's hourly sign-in
   * is fresh, because a sandboxed build cannot renew it (kiro-signin.ts). When it answers
   * "signed out" the try is not started. Left out in tests that do not need it.
   */
  renewSignIn?: RenewSignIn;
}

export interface BuildNightResult {
  /** Ids of the ideas that are now "built". */
  built: string[];
  /** Ids of the ideas that are now "build_failed", including builds found interrupted. */
  failed: string[];
  /** Why nothing, or not everything, was built: "" when every waiting idea was tried. */
  skipped: string;
}

export const SKIPPED_PAUSED = "paused";
export const SKIPPED_NOTHING_APPROVED = "nothing approved";
/** This process was told to stop (a stop signal) before every waiting idea was tried. */
export const SKIPPED_STOPPED = "stopped";
export { INTERRUPTED_REASON, STOPPED_REASON };
/** A build still "building" this long after its time limit was cut off (a crash, a restart, a power cut). */
export const INTERRUPTED_GRACE_MS = 15 * MINUTE_MS;
const MAX_REASON_CHARS = 300;
const NOT_WAITING = "the idea was no longer waiting for a build";

/** How long after it started a build still marked "building" counts as cut off. */
function interruptedAfterMs(config: Pick<Config, "buildTimeoutMin">): number {
  return config.buildTimeoutMin * MINUTE_MS + INTERRUPTED_GRACE_MS;
}

const BACKEND_LABELS: Record<string, string> = { "kiro-crew": "Kiro Crew", "kiro-cli": "Kiro CLI" };
const label = (backend: string): string => BACKEND_LABELS[backend] ?? backend;

function clip(text: string): string {
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/** When the approval was recorded. Falls back to the timeline, which always has the entry. */
function approvedAt(idea: Idea, store: Pick<Store, "ideaEvents">): string {
  if (idea.answeredAt !== null) return idea.answeredAt;
  return store.ideaEvents(idea.id).findLast((event) => event.toState === "approved")?.at ?? idea.updatedAt;
}

/** Is this the second try of a build that was stopped or cut off (core's rule)? */
function awaitsRetry(idea: Idea, store: Pick<Store, "countBuildStarts">): boolean {
  return isBuildAwaitingRetry(idea, store.countBuildStarts(idea.id));
}

/**
 * The ideas waiting for a nightly build, the one approved longest ago first (ties keep the order
 * they were heard in): every approved idea, and every idea whose build was stopped or cut off and
 * is due its one more try. One line, one order: a retry does not jump ahead of an older approval.
 */
export function waitingOldestFirst(store: Pick<Store, "listIdeas" | "ideaEvents" | "countBuildStarts">): Idea[] {
  const retries = store.listIdeas({ states: ["build_failed"] }).filter((idea) => awaitsRetry(idea, store));
  return [...store.listIdeas({ states: ["approved"] }), ...retries]
    .map((idea) => ({ idea, at: approvedAt(idea, store) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((entry) => entry.idea);
}

/**
 * A process killed in the middle of a build leaves its idea "building". Any idea that has been
 * building for longer than the time limit plus 15 minutes is moved to "build_failed", so it is
 * never stuck. Returns the ids moved.
 */
export function failInterruptedBuilds(deps: Pick<BuildDeps, "store" | "config" | "logger">, now: Date): string[] {
  const { store, config, logger } = deps;
  const limitMs = interruptedAfterMs(config);
  const moved: string[] = [];
  for (const idea of store.listIdeas({ states: ["building"] })) {
    const since = Date.parse(idea.buildStartedAt ?? idea.updatedAt);
    if (!Number.isFinite(since) || now.getTime() - since <= limitMs) continue;
    try {
      store.transitionIdea(idea.id, "build_failed", { failureReason: INTERRUPTED_REASON, note: INTERRUPTED_REASON }, now.toISOString());
      logger.warn("a build was found interrupted and marked failed", { ideaId: idea.id, backend: idea.buildBackend });
      moved.push(idea.id);
    } catch (error) {
      logger.error("could not mark an interrupted build as failed", { ideaId: idea.id, error: errorSummary(error) });
    }
  }
  return moved;
}

/** The slug an idea keeps for good. Made from the title the first time; reused on a retry. */
function slugOf(idea: Idea, store: Pick<Store, "findIdeaBySlug">): string {
  if (idea.slug !== null && isSlug(idea.slug)) return idea.slug;
  return slugFor(idea.title, (candidate) => {
    const holder = store.findIdeaBySlug(candidate);
    return holder !== null && holder.id !== idea.id;
  });
}

/**
 * An empty workspace with the brief in it, or null. An earlier try's folder is moved aside, and
 * so is an older finished build of the same idea: the morning must never find yesterday's app
 * where it looks for today's.
 */
function freshWorkspace(idea: Idea, brief: string, deps: BuildDeps, now: () => Date): BuildJob | null {
  try {
    const retired = retireSealed({ paths: deps.paths, ideaId: idea.id, now: now() });
    if (!retired.ok) {
      deps.logger.error("could not move an older finished build aside, so the build was not started", { ideaId: idea.id, reason: retired.reason });
      return null;
    }
    const prepared = prepareWorkspace({ paths: deps.paths, ideaId: idea.id, brief, now: now() });
    return { ideaId: idea.id, workspace: prepared.workspace, briefPath: prepared.briefPath, timeoutMs: deps.config.buildTimeoutMin * MINUTE_MS };
  } catch (error) {
    deps.logger.error("could not prepare a workspace", { ideaId: idea.id, error: errorSummary(error) });
    return null;
  }
}

/**
 * One "stop" for a whole run: aborted by `deps.signal`, or by a stop signal to this process. While
 * it is listening, a stop signal does not end the process (see run.ts): the run winds down and
 * returns. `done()` stops listening.
 */
function stopWatch(deps: Pick<BuildDeps, "signal" | "logger">): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  const outer = deps.signal;
  if (outer?.aborted === true || isStopping()) stop();
  outer?.addEventListener("abort", stop, { once: true });
  const unlisten = onStopSignal(() => {
    deps.logger.warn("told to stop: ending the build in progress and starting nothing new");
    stop();
  });
  return {
    signal: controller.signal,
    done: () => {
      outer?.removeEventListener("abort", stop);
      unlisten();
    },
  };
}

/**
 * Count what one try cost, in the month's ledger. A try that started no agent cost nothing and
 * gets no row. Otherwise the row holds the builder's own figure when it gave one, and an estimate
 * from how long the agent ran when it did not. Never throws: a ledger that cannot be written is
 * logged, and the build's result stands.
 */
function recordCost(outcome: BuildOutcome, ideaId: string, deps: Pick<BuildDeps, "store" | "logger">, now: () => Date): void {
  const { credits, agentMs } = outcome;
  if (credits === undefined && agentMs === undefined) return;
  // The builder's figure comes from a file a build job can write. One that no build could have
  // used is not believed, and the ledger would refuse it: the estimate is counted in its place.
  const believed = credits !== undefined && Number.isFinite(credits) && credits >= 0 && credits <= HIGHEST_BUILD_CREDIT_LIMIT;
  if (credits !== undefined && !believed) deps.logger.warn("a builder's own credit figure was not one a build could have used; counting an estimate instead", { ideaId, backend: outcome.backend });
  const cost = believed ? { credits, measured: true } : agentMs === undefined ? null : { credits: estimatedBuildCredits(agentMs), measured: false };
  if (cost === null) {
    deps.logger.error("could not count what a build try cost: there was no figure to believe and no time to estimate from", { ideaId, backend: outcome.backend });
    return;
  }
  try {
    deps.store.recordBuildCost({ ideaId, at: now().toISOString(), backend: outcome.backend, ...cost });
    deps.logger.info("build try counted", { ideaId, backend: outcome.backend, credits: cost.credits, measured: cost.measured });
  } catch (error) {
    deps.logger.error("could not record what a build try cost; the build's result stands", { ideaId, backend: outcome.backend, error: errorSummary(error) });
  }
}

/**
 * Where this month's build credits stand, or null when that cannot be read. Then building goes
 * ahead: a fault in the ceiling must not cost a night.
 */
function readBudget(deps: Pick<BuildDeps, "store" | "config" | "logger">, now: Date): BuildBudget | null {
  try {
    return buildBudget(deps.store, deps.config, now);
  } catch (error) {
    deps.logger.error("could not read the build budget; building anyway", { error: errorSummary(error) });
    return null;
  }
}

/** Run one backend on a prepared workspace. Never throws. */
async function tryBackend(backend: BuildBackend, job: BuildJob | null, deps: BuildDeps, now: () => Date, stop: AbortSignal): Promise<BuildOutcome> {
  const startedMs = now().getTime();
  const stopped = (reason: string, couldNotStart: boolean): BuildOutcome => ({ ok: false, backend: backend.name, ms: now().getTime() - startedMs, reason, couldNotStart });
  if (stop.aborted) return stopped(STOPPED_REASON, false);
  if (job === null) return stopped("the workspace folder could not be prepared", true);
  try {
    if (deps.renewSignIn !== undefined) {
      // The step promises not to throw. If it does anyway, the build is still tried: it fails by
      // itself if Kiro really is signed out.
      const signIn = await deps.renewSignIn(stop).catch((error: unknown) => {
        deps.logger.warn("the sign-in step threw; trying the build anyway", { ideaId: job.ideaId, backend: backend.name, error: errorSummary(error) });
        return null;
      });
      if (stop.aborted) return stopped(STOPPED_REASON, false);
      if (signIn !== null && !signIn.ok) return stopped(signIn.reason, true);
    }
    const outcome = await backend.build(job, { signal: stop });
    recordCost(outcome, job.ideaId, deps, now);
    return outcome;
  } catch (error) {
    // Backends promise not to throw. If one does anyway, the night goes on.
    deps.logger.error("a build backend threw", { ideaId: job.ideaId, backend: backend.name, error: errorSummary(error) });
    return stopped("the builder stopped on an unexpected error", false);
  }
}

/** Which ideas a caller of buildIdea may build: asked again just before the build starts. */
type MayBuild = (idea: Idea) => boolean;
/** `build-now`: any approved idea, and any idea whose build failed, whatever the reason. */
const approvedOrFailed: MayBuild = (idea) => idea.state === "approved" || idea.state === "build_failed";

/**
 * Build one idea that `mayBuild` allows: primary backend, then the fallback once. Moves the idea
 * to "building" and then to "built" or "build_failed". Never throws.
 */
async function buildIdea(listed: Idea, deps: BuildDeps, now: () => Date, stop: AbortSignal, mayBuild: MayBuild): Promise<BuildOutcome> {
  const { store, backends, logger } = deps;
  const startedMs = now().getTime();
  const primary = backends.primary;
  const notStarted = (reason: string): BuildOutcome => ({ ok: false, backend: primary.name, ms: now().getTime() - startedMs, reason, couldNotStart: true });

  let brief: string;
  let job: BuildJob | null;
  let idea: Idea;
  try {
    // Read the idea again: the list it came from was made when the night began, and it may have
    // moved on since. Making a fresh workspace moves the old folder aside, so that must not
    // happen to an idea that is no longer waiting for a build (its finished app would be lost
    // to the deliver step).
    const current = store.getIdea(listed.id);
    if (current === null || !mayBuild(current)) {
      logger.warn("build not started: the idea is no longer waiting for one", { ideaId: listed.id, state: current?.state ?? "gone" });
      return notStarted(NOT_WAITING);
    }
    idea = current;
    // One line for a second try, so the log shows why a failed idea is being built again.
    if (awaitsRetry(idea, store)) logger.info("trying a build again: its earlier try was stopped or cut off", { ideaId: idea.id, earlierStarts: store.countBuildStarts(idea.id), earlierReason: idea.failureReason });
    const slug = slugOf(idea, store);
    brief = renderBrief({ id: idea.id, title: idea.title, pitch: idea.pitch });
    job = freshWorkspace(idea, brief, deps, now);
    const startedAt = now().toISOString();
    store.transitionIdea(
      idea.id,
      "building",
      { slug, buildBackend: primary.name, buildStartedAt: startedAt, builtAt: null, failureReason: null, note: `building with ${label(primary.name)}` },
      startedAt,
    );
  } catch (error) {
    logger.error("could not start a build", { ideaId: listed.id, error: errorSummary(error) });
    return notStarted("the build could not be recorded as started");
  }
  logger.info("build started", { ideaId: idea.id, backend: primary.name });

  let outcome = await tryBackend(primary, job, deps, now, stop);
  let reason = outcome.ok ? "" : `${label(primary.name)}: ${outcome.reason}`;
  // No second try while this process is being stopped: it would be cut off as well.
  if (!outcome.ok && backends.fallback !== null && !stop.aborted) {
    const fallback = backends.fallback;
    logger.warn("build failed; trying the other backend once", { ideaId: idea.id, backend: primary.name, couldNotStart: outcome.couldNotStart, reason: outcome.reason, next: fallback.name });
    try {
      // The clock for "interrupted" starts again with the second try.
      store.updateIdea(idea.id, { buildBackend: fallback.name, buildStartedAt: now().toISOString(), note: `building with ${label(fallback.name)}` }, now().toISOString());
    } catch (error) {
      logger.error("could not record the second try", { ideaId: idea.id, error: errorSummary(error) });
    }
    const first = outcome;
    outcome = await tryBackend(fallback, freshWorkspace(idea, brief, deps, now), deps, now, stop);
    if (!outcome.ok) {
      reason = clip(`${reason}. ${label(fallback.name)}: ${outcome.reason}`);
      outcome = { ...outcome, reason, couldNotStart: first.couldNotStart && outcome.couldNotStart };
    }
  }
  // Told to stop while this build was going: that, and nothing a backend said on its way down,
  // is why it did not finish. (A build that had finished anyway keeps its result.)
  if (!outcome.ok && stop.aborted) {
    reason = STOPPED_REASON;
    outcome = { ...outcome, reason, couldNotStart: false };
  }

  const totalMs = now().getTime() - startedMs;
  const at = now().toISOString();
  try {
    if (outcome.ok) {
      store.transitionIdea(idea.id, "built", { builtAt: at, buildBackend: outcome.backend, failureReason: null, note: `built with ${label(outcome.backend)} in ${seconds(totalMs)} s` }, at);
      logger.info("build finished", { ideaId: idea.id, backend: outcome.backend, seconds: seconds(totalMs), credits: outcome.credits });
    } else {
      store.transitionIdea(idea.id, "build_failed", { failureReason: clip(reason), note: "the build failed" }, at);
      logger.warn("build failed", { ideaId: idea.id, backend: outcome.backend, seconds: seconds(totalMs), reason: clip(reason) });
    }
  } catch (error) {
    // The idea stays "building"; the next run finds it and marks it interrupted.
    logger.error("could not record the result of a build", { ideaId: idea.id, error: errorSummary(error) });
    return { ok: false, backend: outcome.backend, ms: totalMs, reason: "the result of the build could not be recorded", couldNotStart: false };
  }
  if (outcome.ok) {
    // Recorded as built first, moved second: a crash between the two leaves a built app in
    // workspaces/, where the morning still looks. Whichever builder made it, it is moved: a later
    // Kiro Crew job could otherwise reach a Kiro CLI build too.
    const sealed = sealWorkspace({ paths: deps.paths, ideaId: idea.id, now: now() });
    if (!sealed.ok) logger.error("a finished build could not be moved out of the builders' reach; the morning uses it where it is", { ideaId: idea.id, reason: sealed.reason });
  }
  return outcome.ok ? { ...outcome, ms: totalMs } : { ...outcome, ms: totalMs, reason: clip(reason) };
}

/**
 * `overnight build`. Starts no build while paused. Otherwise builds the waiting ideas (approved
 * ones, and builds that were stopped or cut off and are due one more try), oldest approval first,
 * up to MAX_BUILDS_PER_NIGHT minus the builds already started in the current local day; a second
 * try counts as a start like any other. Starts nothing more once the month's build credits are
 * used up (`skipped` then says so, in core's words). One idea failing never stops the next one.
 * Never rejects on a stop (see the top of this file).
 */
export async function runBuildNight(deps: BuildDeps): Promise<BuildNightResult> {
  const stop = stopWatch(deps);
  try {
    return await buildNight(deps, stop.signal);
  } finally {
    stop.done();
  }
}

async function buildNight(deps: BuildDeps, stop: AbortSignal): Promise<BuildNightResult> {
  const { store, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  // First, and even while paused: a build that was cut off must not stay "building" for as long
  // as the pause lasts. This starts nothing; it only lets the morning tell the wearer.
  const failed = failInterruptedBuilds(deps, now());
  if (store.isPaused(config.pausedByDefault)) {
    logger.info("build night skipped: Overnight is paused", { failed: failed.length });
    return { built: [], failed, skipped: SKIPPED_PAUSED };
  }

  const built: string[] = [];
  // Made after the cut-off builds were failed above: one of those is due its second try tonight.
  const waiting = waitingOldestFirst(store);
  const retries = waiting.filter((idea) => idea.state === "build_failed").length;
  const day = localDayBounds(now(), config.timeZone);
  const alreadyStarted = store.countBuildsStartedBetween(day.start.toISOString(), day.end.toISOString());
  const room = Math.max(0, config.maxBuildsPerNight - alreadyStarted);
  const tonight = waiting.slice(0, room);
  let budget = readBudget(deps, now());
  logger.info("build night started", {
    approved: waiting.length - retries,
    retries,
    alreadyStartedToday: alreadyStarted,
    limit: config.maxBuildsPerNight,
    building: tonight.length,
    creditsThisMonth: budget?.counted,
    creditLimit: config.maxBuildCreditsPerMonth,
  });
  /** Still waiting when its turn comes? Approved, or still due its one more try (it may have been built, or told about, since). */
  const stillWaiting: MayBuild = (idea) => idea.state === "approved" || awaitsRetry(idea, store);

  for (const [turn, idea] of tonight.entries()) {
    // A long night: someone may have paused Overnight since the first build began.
    if (store.isPaused(config.pausedByDefault)) {
      logger.info("build night stopped early: Overnight was paused", { built: built.length, failed: failed.length });
      return { built, failed, skipped: SKIPPED_PAUSED };
    }
    if (stop.aborted) {
      logger.info("build night stopped early: this process was told to stop", { built: built.length, failed: failed.length });
      return { built, failed, skipped: SKIPPED_STOPPED };
    }
    // The month's ceiling, asked before each idea and never during one. (Asked again from the
    // second idea on: the build before it may have used the month up.)
    if (turn > 0) budget = readBudget(deps, now());
    if (budget?.reached === true) {
      logger.warn("build night stopped early: the month's ceiling on build credits is reached", { built: built.length, failed: failed.length, creditsThisMonth: budget.counted, creditLimit: budget.limit });
      return { built, failed, skipped: budgetReachedText(budget, config.timeZone) };
    }
    const outcome = await buildIdea(idea, deps, now, stop, stillWaiting);
    // Read the state back: "failed" means the idea really is build_failed now.
    const state = store.getIdea(idea.id)?.state;
    // (An idea that was not started because it had moved on is neither. An idea found cut off
    // at the top of this run and built on its second try is no longer failed.)
    const wasFailed = failed.indexOf(idea.id);
    if (outcome.ok && state === "built") {
      built.push(idea.id);
      if (wasFailed !== -1) failed.splice(wasFailed, 1);
    } else if (state === "build_failed" && wasFailed === -1) failed.push(idea.id);
  }
  if (stop.aborted) {
    logger.info("build night stopped: this process was told to stop", { built: built.length, failed: failed.length });
    return { built, failed, skipped: SKIPPED_STOPPED };
  }

  const leftOver = waiting.length - tonight.length;
  const skipped = waiting.length === 0 ? SKIPPED_NOTHING_APPROVED : leftOver > 0 ? `${leftOver} approved ${leftOver === 1 ? "idea waits" : "ideas wait"} for another night (limit ${config.maxBuildsPerNight} a night)` : "";
  logger.info("build night finished", { built: built.length, failed: failed.length, leftForAnotherNight: leftOver });
  return { built, failed, skipped };
}

/**
 * `overnight build-now <id>`: build one idea right away. Allowed when the idea is "approved" or
 * "build_failed". Ignores the nightly limit, but not the pause flag and not the month's ceiling
 * on build credits. Never throws.
 */
export async function buildOne(ideaId: string, deps: BuildDeps): Promise<BuildOutcome> {
  const { store, config, backends, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const refused = (reason: string): BuildOutcome => ({ ok: false, backend: backends.primary.name, ms: 0, reason, couldNotStart: true });
  const stop = stopWatch(deps);
  try {
    // A build that was cut off long ago (its process was killed) is failed first, so that it can
    // be built again here and now instead of waiting for the next nightly run.
    failInterruptedBuilds(deps, now());
    if (store.isPaused(config.pausedByDefault)) return refused("Overnight is paused (to build, run: npx overnight resume)");
    const budget = readBudget(deps, now());
    if (budget?.reached === true) {
      logger.warn("build-now refused: the month's ceiling on build credits is reached", { ideaId, creditsThisMonth: budget.counted, creditLimit: budget.limit });
      return refused(budgetReachedText(budget, config.timeZone));
    }
    const idea = store.getIdea(ideaId);
    if (idea === null) return refused("there is no idea with that id");
    if (idea.state === "building") {
      // Still inside its time limit: it may really be running (in another window, or the nightly job).
      const since = Date.parse(idea.buildStartedAt ?? idea.updatedAt);
      const freeAt = Number.isFinite(since) ? new Date(since + interruptedAfterMs(config)) : null;
      const when = freeAt === null ? "" : `; if that build was cut off, it can be built again after ${formatLocal(freeAt, config.timeZone)}`;
      return refused(`this idea is marked as being built right now${when}`);
    }
    if (idea.state !== "approved" && idea.state !== "build_failed") {
      return refused(`this idea is "${idea.state}"; only an approved idea, or one whose build failed, can be built`);
    }
    if (stop.signal.aborted) return refused(STOPPED_REASON);
    return await buildIdea(idea, deps, now, stop.signal, approvedOrFailed);
  } catch (error) {
    logger.error("build-now stopped on an unexpected error", { ideaId, error: errorSummary(error) });
    return refused("the build stopped on an unexpected error");
  } finally {
    stop.done();
  }
}
