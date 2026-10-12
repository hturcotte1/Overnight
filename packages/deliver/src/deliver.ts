// The morning: for every app built last night, verify it, publish it and tell the wearer.
//
// Running this twice must never publish twice or buzz twice. So every step leaves a mark in the
// store before the next one starts: a published idea skips straight to the to-do, a delivered
// idea is left alone, and a to-do that MAY exist (Bee's reply was lost, or we were stopped while
// asking) is never created a second time.
//
// Delivery still happens while Overnight is paused: what was approved and built gets delivered.
// Only asking and building stop.
//
// Being stopped (deps.signal) follows the same rule. The step in progress is ended and its
// programs killed; nothing new is started; and the idea in progress is left exactly where the
// next run picks it up:
//   - stopped while verifying or publishing: the idea stays "built" (or "publish_failed") and is
//     verified and published again next time. If the push had been started by then, a note on
//     the idea says so (whether GitHub took it is not known); the publisher replaces that version
//     cleanly if it is there (see publisher.ts).
//   - stopped while Bee was being asked for the to-do: the mark described above stays, so the
//     next run closes the idea without asking Bee a second time.
//
// Two things are deliberately NOT treated as failures:
//   - A push that went through although the page was not seen live before the wait ran out.
//     GitHub Pages usually catches up a little later, so the idea is recorded as published, with a
//     note and a warning that say it was not confirmed, and the wearer is told as usual. (Being
//     stopped at that moment is still a stop: see above.)
//   - A build that was stopped or cut off (rather than failed) and still has a start left. The
//     night builder tries it once more, and until then nobody is told "couldn't finish". The rule
//     itself is core's (isBuildAwaitingRetry).
//
// And one failure is worded with care: a push that ran into its time limit may have reached
// GitHub although we never heard so. The idea is failed like any other (nothing was confirmed,
// so no link is recorded and nobody is sent one), and its reason adds that the app may be public.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { BeeError, errorSummary, finishedBuildDir, isBuildAwaitingRetry } from "@overnight/core";
import type { BeeGateway, Config, DataPaths, Idea, Logger, Store } from "@overnight/core";
import { factText, failureText, morningAlarmAt, morningText } from "./announce.ts";
import { createPagesPublisher, SLUG_PATTERN } from "./publisher.ts";
import { discardTree, sweepGone } from "./remove-tree.ts";
import { readCarriedReport, sizesFromChecks, writeReport } from "./report.ts";
import type { CarriedReport, DeliverReport } from "./report.ts";
import type { DeliverDeps, DeliverOneResult, DeliverSummary, Publisher, PublishResult, Verifier, VerifyChecks, VerifyResult } from "./types.ts";
import { createSandboxedVerifier } from "./verifier.ts";

/**
 * The note left on a published idea just before Bee is asked to create its morning to-do. Every
 * outcome replaces it, so an idea still carrying it when a new run starts was cut off mid-way:
 * its to-do may exist, and no second one is made.
 */
export const ANNOUNCING_NOTE = "telling the wearer in Bee now";

/**
 * The note on an idea that is closed that way. It says only what is known: Bee was being asked
 * when Overnight stopped. Whether the to-do was made is not known, so it does not say "told".
 */
const INTERRUPTED_NOTE = "Bee was being told when Overnight stopped, so its to-do may or may not exist; no second one is made";

/**
 * The note on an idea that is closed because Bee's answer never reached us in a form we could use
 * (`kind`: no reply in time, a reply we could not read, anything unexpected). The same rule as the
 * note above: no reply in time can also mean the request never left this Mac, so all that is
 * known is that Bee was asked. It does not say "told" either.
 */
const lostReplyNote = (kind: string): string => `Bee was asked for the to-do but its reply was lost (${kind}), so the to-do may or may not exist; no second one is made`;

/**
 * Added to the reason when publishing failed after the push had been started (it ran into its
 * time limit, say): GitHub may have taken the new version although we never heard so. The idea is
 * a failure all the same, but its reason must not let anyone think nothing went out.
 */
const PUSH_MAY_BE_PUBLIC = " The push may have reached GitHub all the same, so the app may be public.";

/**
 * The note left on an idea when Overnight was stopped once the push of the new version had been
 * started, but before the link was confirmed and recorded. The publisher counts a push as possibly
 * out from the moment it starts, so the stop may have landed during the push itself, with nothing
 * on GitHub. The note therefore says "started", never "pushed". The idea is published again on the
 * next run, which replaces this note.
 */
export const PUSHED_UNCONFIRMED_NOTE = "the push to GitHub was started, but Overnight was stopped before the link was confirmed; the next run publishes it again";

/**
 * The note on a published idea whose new version was pushed, but whose page was not seen serving
 * it before Overnight stopped looking. It usually goes live a little later, so the idea counts as
 * published and the wearer is told as usual. (Not to be confused with PUSHED_UNCONFIRMED_NOTE,
 * which is about being stopped, and where the idea is published again.)
 */
export const NOT_SEEN_LIVE_NOTE = "pushed to GitHub, but the page was not seen live before Overnight stopped waiting for it; it usually appears a little later";

/** What deliverOne answers for a build that was cut short and still gets its second try. */
export const BUILD_RETRY_PENDING_REASON = "The build was cut short, not failed. It will be built once more, and nobody is told it could not be finished unless that fails too.";

/** What deliverOne answers when it was stopped part-way. */
export const DELIVER_STOPPED_REASON = "Overnight was stopped before this delivery finished. Running it again picks up where it left off.";

/** Once the stop signal is up: how long a Bee call that is already in flight may still take. */
const STOP_GRACE_MS = 6_000;
/** Once the stop signal is up: runDeliver and deliverOne have answered by this time, whatever is still going on. */
const STOP_LIMIT_MS = 9_500;
const STOPPED = Symbol("stopped");

/** How many times Bee is asked for one to-do or fact when it answers with a plain refusal. */
const BEE_ATTEMPTS = 3;
const IDEA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

interface Context {
  store: Store;
  bee: BeeGateway;
  config: Config;
  paths: DataPaths;
  logger: Logger;
  now: () => Date;
  verifier: Verifier;
  publisher: Publisher;
  retryDelayMs: number;
  signal: AbortSignal | undefined;
  stopGraceMs: number;
  /** True once the stop signal has fired: finish the write in hand, start nothing new. */
  stopped: () => boolean;
  /** Set when we have already answered our caller because stopping took too long: write nothing more at all. */
  halted: boolean;
}

function makeContext(deps: DeliverDeps): Context {
  const now = deps.now ?? (() => new Date());
  return {
    store: deps.store,
    bee: deps.bee,
    config: deps.config,
    paths: deps.paths,
    logger: deps.logger,
    now,
    verifier: deps.verify ?? createSandboxedVerifier({ paths: deps.paths, logger: deps.logger, ...(deps.run ? { run: deps.run } : {}) }),
    publisher: deps.publish ?? createPagesPublisher({ paths: deps.paths, config: deps.config, logger: deps.logger, now, ...(deps.run ? { run: deps.run } : {}) }),
    retryDelayMs: deps.retryDelayMs ?? 5_000,
    signal: deps.signal,
    stopGraceMs: deps.stopGraceMs ?? STOP_GRACE_MS,
    stopped: () => deps.signal?.aborted === true,
    halted: false,
  };
}

/** Wait `ms`, or until the stop signal fires, whichever comes first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The result of `work`, or STOPPED once the stop signal has been up for the grace period. The
 * work itself cannot be cancelled (a Bee call takes no signal); whatever it does after that is
 * ignored, which is why callers leave their "may exist" marks in place when they get STOPPED.
 */
function unlessStopped<T>(ctx: Context, work: Promise<T>): Promise<T | typeof STOPPED> {
  const signal = ctx.signal;
  if (signal === undefined) return work;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const startGrace = () => {
      timer = setTimeout(() => resolve(STOPPED), ctx.stopGraceMs);
    };
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", startGrace);
    };
    if (signal.aborted) startGrace();
    else signal.addEventListener("abort", startGrace, { once: true });
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

/**
 * `work`, but answered within STOP_LIMIT_MS of the stop signal whatever happens. Everything in
 * this file already ends quickly when stopped; this is the guarantee behind it.
 */
function withStopLimit<T>(ctx: Context, work: Promise<T>, whenOutOfTime: () => T): Promise<T> {
  const signal = ctx.signal;
  if (signal === undefined) return work;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const startLimit = () => {
      timer = setTimeout(() => {
        ctx.halted = true;
        ctx.logger.error("deliver did not stop in time; answering without waiting for the step in progress");
        resolve(whenOutOfTime());
      }, STOP_LIMIT_MS);
    };
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", startLimit);
    };
    if (signal.aborted) startLimit();
    else signal.addEventListener("abort", startLimit, { once: true });
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

/** The kind of a Bee failure, for logs and notes. Anything that is not a BeeError is "unexpected". */
function beeErrorKind(error: unknown): BeeError["kind"] | "unexpected" {
  return error instanceof BeeError ? error.kind : "unexpected";
}

type BeeOutcome<T> = { outcome: "created"; value: T } | { outcome: "refused"; kind: string } | { outcome: "lost"; kind: string };

/**
 * Ask Bee to create one thing. "refused" means Bee said no and nothing exists ("failed" is tried
 * again a few times; "logged-out" is not). "lost" means it MAY exist (no reply in time, a reply we
 * could not read, anything unexpected), so the caller must never ask again.
 */
async function createInBee<T>(ctx: Context, what: string, ideaId: string, create: () => Promise<T>): Promise<BeeOutcome<T>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { outcome: "created", value: await create() };
    } catch (error) {
      const kind = beeErrorKind(error);
      if (kind !== "failed" && kind !== "logged-out") {
        ctx.logger.warn("Bee's reply was lost, so the item may exist; not creating another", { ideaId, what, kind });
        return { outcome: "lost", kind };
      }
      // Being stopped ends the tries: Bee said no, so nothing exists and a later run asks again.
      const willRetry = kind === "failed" && attempt < BEE_ATTEMPTS && !ctx.stopped();
      ctx.logger.warn("Bee refused to create an item", { ideaId, what, kind, attempt, willRetry });
      if (!willRetry) return { outcome: "refused", kind };
      await sleep(ctx.retryDelayMs, ctx.signal);
      if (ctx.stopped()) return { outcome: "refused", kind };
    }
  }
}

/** Rewrite the idea's report from the store, carrying over what earlier steps measured. Never throws. */
function saveReport(ctx: Context, ideaId: string, fresh: CarriedReport = {}): void {
  try {
    const idea = ctx.store.getIdea(ideaId);
    if (idea === null) return;
    const before = readCarriedReport(ctx.paths, ideaId);
    const checks: VerifyChecks = fresh.checks ?? before.checks ?? {};
    const timings = fresh.timings ?? before.timings ?? { verifyMs: null, publishMs: null, liveAfterMs: null };
    // What this step found out, else what an earlier step of the same delivery wrote down. A
    // report from before this field existed says it through its timing: a page that has a
    // "live after" time was seen live.
    const confirmedLive = fresh.confirmedLive !== undefined ? fresh.confirmedLive : (before.confirmedLive ?? (typeof timings.liveAfterMs === "number" ? true : null));
    const at = ctx.now().toISOString();
    const report: DeliverReport = {
      ideaId,
      slug: idea.slug,
      title: idea.title,
      pitch: idea.pitch,
      backend: idea.buildBackend,
      state: idea.state,
      ok: idea.state === "published" || idea.state === "delivered",
      url: idea.publishedUrl,
      confirmedLive,
      failureReason: idea.failureReason,
      note: idea.note,
      checks,
      timings,
      sizes: sizesFromChecks(checks),
      screenshots: fresh.screenshots ?? before.screenshots ?? { phone: null, desktop: null },
      morningTodoId: idea.morningTodoId,
      factId: idea.factId,
      startedAt: fresh.startedAt ?? before.startedAt ?? at,
      publishedAt: idea.publishedAt,
      deliveredAt: idea.deliveredAt,
      updatedAt: at,
    };
    writeReport(ctx.paths, report);
  } catch (error) {
    ctx.logger.warn("could not write the report", { ideaId, error: errorSummary(error) });
  }
}

type PublishOutcome = { ok: true; url: string; notSeenLive?: true } | { ok: false; reason: string; stopped?: true };

/**
 * Clear what earlier tries left under tmp/deliver for this idea. Best effort, and never throws: a
 * build can leave a folder that cannot even be listed, and a leftover like that must not keep the
 * idea from getting its verdict (the new run folder has a name of its own anyway).
 */
function clearOldRuns(ctx: Context, ideaRuns: string): void {
  try {
    sweepGone(ctx.paths.deliverRuns);
    if (!discardTree(ideaRuns)) ctx.logger.warn("an earlier run's folder could not be deleted; carrying on without it");
  } catch (error) {
    ctx.logger.warn("could not clear an earlier run's folder; carrying on", { error: errorSummary(error) });
  }
}

/** For an idea that is "built" (or, when asked for by id, "publish_failed"): verify, publish, record. */
async function verifyAndPublish(ctx: Context, idea: Idea): Promise<PublishOutcome> {
  const { store, paths, logger } = ctx;
  const startedAt = ctx.now().toISOString();
  const report: CarriedReport = { startedAt, checks: {}, timings: { verifyMs: null, publishMs: null, liveAfterMs: null }, screenshots: { phone: null, desktop: null }, confirmedLive: null };

  /** `pushMayBeOut`: the push had been started and may have got through. The recorded reason and the log both say so. */
  const fail = (why: string, pushMayBeOut = false): PublishOutcome => {
    const reason = pushMayBeOut ? `${why}${PUSH_MAY_BE_PUBLIC}` : why;
    const at = ctx.now().toISOString();
    if (idea.state === "built") store.transitionIdea(idea.id, "publish_failed", { failureReason: reason, note: reason }, at);
    else store.updateIdea(idea.id, { failureReason: reason, note: reason }, at);
    saveReport(ctx, idea.id, report);
    logger.warn("a built app was not published", {
      ideaId: idea.id,
      failedStep: typeof report.checks?.failedStep === "string" ? report.checks.failedStep : "publish",
      ...(pushMayBeOut ? { pushMayHaveReachedGitHub: true } : {}),
    });
    return { ok: false, reason };
  };
  /** Stopped part-way: no verdict, no state change. The next run starts this idea again. */
  const stoppedHere = (during: string): PublishOutcome => {
    logger.warn("stopped before a built app was published; the next run picks it up", { ideaId: idea.id, during });
    return { ok: false, reason: DELIVER_STOPPED_REASON, stopped: true };
  };
  /**
   * Stopped while publishing. Never half-published without a record: if the new version is, or
   * may be, on GitHub (`pushed`: the push had at least been started), the idea says so until the
   * next run has published it again and recorded the link. The log says the same, and no more.
   */
  const stoppedWhilePublishing = (pushed: boolean): PublishOutcome => {
    if (pushed) store.updateIdea(idea.id, { note: PUSHED_UNCONFIRMED_NOTE }, ctx.now().toISOString());
    return stoppedHere(pushed ? "publish, once the push had started" : "publish");
  };

  if (ctx.stopped()) return stoppedHere("start");
  if (!IDEA_ID.test(idea.id)) return fail("The idea's id cannot be used as a folder name.");
  const slug = idea.slug;
  if (slug === null || !SLUG_PATTERN.test(slug)) return fail("The idea has no usable folder name for its link.");

  // A fresh run folder with a new name every time. Nothing from an earlier try can leak into this
  // one, and a program an earlier try left running (its sandbox only knows the old folder) cannot
  // write into it.
  const ideaRuns = path.join(paths.deliverRuns, idea.id);
  clearOldRuns(ctx, ideaRuns);
  const runDir = path.join(ideaRuns, `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);

  const verifyFrom = Date.now();
  let verified: VerifyResult;
  try {
    // Where the finished build is (core's rule): built/<id> once the builder has moved it out of
    // every build job's reach, the workspace itself if that move never happened.
    verified = await ctx.verifier.verify({ ideaId: idea.id, workspace: finishedBuildDir(paths, idea.id), runDir, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
  } catch (error) {
    logger.error("the verifier stopped on an unexpected error", { ideaId: idea.id, error: errorSummary(error) });
    verified = { ok: false, reason: "Verification could not be completed because of an unexpected error.", checks: {} };
  }
  // A verification that was cut short says nothing about the app, whatever it returned.
  if (ctx.stopped() || (!verified.ok && verified.stopped === true)) return stoppedHere("verify");
  report.checks = verified.checks;
  report.timings = { verifyMs: Date.now() - verifyFrom, publishMs: null, liveAfterMs: null };
  if (!verified.ok) return fail(verified.reason);
  report.screenshots = { phone: verified.screenshotPhone, desktop: verified.screenshotDesktop };

  // New for every publish: the page counts as live only once it serves exactly this marker.
  const marker = `${idea.id}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const publishFrom = Date.now();
  let published: PublishResult;
  try {
    published = await ctx.publisher.publish({ ideaId: idea.id, slug, distDir: verified.distDir, marker, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
  } catch (error) {
    logger.error("the publisher stopped on an unexpected error", { ideaId: idea.id, error: errorSummary(error) });
    published = { ok: false, reason: "Publishing could not be completed because of an unexpected error." };
  }
  if (ctx.halted) return stoppedHere("publish");
  report.timings = { verifyMs: report.timings.verifyMs, publishMs: Date.now() - publishFrom, liveAfterMs: published.ok ? published.liveAfterMs : null };
  if (!published.ok) {
    if (ctx.stopped() || published.stopped === true) return stoppedWhilePublishing(published.pushed === true);
    return fail(published.reason, published.pushed === true);
  }
  // Pushed, and seen serving this build? Only an explicit "no" from the publisher counts as not seen.
  const seenLive = published.confirmedLive !== false;
  // Not seen live AND we are being stopped: the same as any other stop after the push. Nothing is
  // recorded as published, and the next run publishes again and waits for the page itself.
  if (!seenLive && ctx.stopped()) return stoppedWhilePublishing(true);

  // Seen live: the page serves this build, and that is recorded even if we are being stopped.
  // Not seen live (and not stopped): the push went through, so the app is published as far as we
  // can do it; the page usually follows within minutes. Recorded as published, with a note that
  // says what was and was not seen.
  const at = ctx.now().toISOString();
  // A note that only repeated an earlier failure, or said an earlier publish was cut short, is out of date now.
  const staleNote = idea.note === PUSHED_UNCONFIRMED_NOTE || (idea.failureReason !== null && idea.note === idea.failureReason);
  const note = seenLive ? (staleNote ? { note: null } : {}) : { note: NOT_SEEN_LIVE_NOTE };
  store.transitionIdea(idea.id, "published", { publishedUrl: published.url, publishedAt: at, failureReason: null, ...note }, at);
  report.confirmedLive = seenLive;
  saveReport(ctx, idea.id, report);
  if (published.confirmedLive === false) {
    logger.warn("published a built app, but its page was not seen live before the wait ran out; the wearer is told as usual", { ideaId: idea.id, verifyMs: report.timings.verifyMs, publishMs: report.timings.publishMs, waitedMs: published.waitedMs });
  } else {
    logger.info("published a built app", { ideaId: idea.id, verifyMs: report.timings.verifyMs, publishMs: report.timings.publishMs, liveAfterMs: published.liveAfterMs });
  }
  // Throwaway files; if they cannot be deleted now, the next clean-up gets them.
  if (!ctx.stopped()) discardTree(ideaRuns);
  return { ok: true, url: published.url, ...(seenLive ? {} : { notSeenLive: true as const }) };
}

/**
 * For an idea that is "published": create the morning to-do (at most once, ever), then the Bee fact.
 * "stopped" means the stop signal cut this short; whatever mark is on the idea was left on purpose.
 */
async function announce(ctx: Context, ideaId: string): Promise<"delivered" | "not-told" | "stopped"> {
  const { store, bee, config, logger } = ctx;
  if (ctx.stopped()) return "stopped";
  const idea = store.getIdea(ideaId);
  if (idea === null) return "not-told";
  if (idea.state === "delivered") return "delivered";
  if (idea.state !== "published") return "not-told";
  const url = idea.publishedUrl;
  if (url === null) {
    logger.error("a published idea has no link, so nobody can be told about it", { ideaId });
    return "not-told";
  }
  const deliver = (todoId: number | null, note: string | null) => {
    const at = ctx.now().toISOString();
    store.transitionIdea(ideaId, "delivered", { deliveredAt: at, morningTodoId: todoId, note }, at);
  };

  if (idea.note === ANNOUNCING_NOTE) {
    logger.warn("an earlier run was cut off while telling the wearer; not creating a second to-do", { ideaId });
    deliver(null, INTERRUPTED_NOTE);
  } else {
    // A durable mark first: if we are stopped before Bee replies, the next run must know a to-do may exist.
    store.updateIdea(ideaId, { note: ANNOUNCING_NOTE }, ctx.now().toISOString());
    const todo = await unlessStopped(
      ctx,
      createInBee(ctx, "morning to-do", ideaId, () => bee.createTodo(morningText(idea.title, url), morningAlarmAt(ctx.now(), config))),
    );
    if (todo === STOPPED || ctx.halted) {
      // Bee has not answered and we cannot wait: the mark stays, so no later run asks a second time.
      logger.warn("stopped while Bee was being asked for the morning to-do; the next run closes this idea without asking again", { ideaId });
      return "stopped";
    }
    if (todo.outcome === "refused") {
      // Nothing was created, so the mark comes off and a later run asks again.
      store.updateIdea(ideaId, { note: idea.note }, ctx.now().toISOString());
      return ctx.stopped() ? "stopped" : "not-told";
    }
    if (todo.outcome === "created") {
      deliver(todo.value.id, idea.note);
      logger.info("told the wearer about a built app", { ideaId, todoId: todo.value.id });
    } else {
      // "lost": the to-do may exist, so this was the one and only ask. The note says just that.
      deliver(null, lostReplyNote(todo.kind));
    }
  }

  // The fact is an extra: when we are being stopped it is simply not written.
  if (config.writeBeeFacts && idea.factId === null && !ctx.stopped()) {
    const fact = await unlessStopped(
      ctx,
      createInBee(ctx, "fact", ideaId, () => bee.createFact(factText(idea.title, url, ctx.now(), config.timeZone))),
    );
    if (fact !== STOPPED && !ctx.halted && fact.outcome === "created") {
      store.updateIdea(ideaId, { factId: fact.value.id }, ctx.now().toISOString());
      logger.info("wrote the Bee fact", { ideaId, factId: fact.value.id });
    }
  }
  if (!ctx.halted) saveReport(ctx, ideaId);
  return "delivered";
}

/**
 * Tell the wearer, once per idea, that an app could not be finished. True when the to-do was created.
 *
 * The idea is read again first, because what the caller saw can be out of date. The morning run
 * lists the failures once and then asks Bee about them one at a time, with waits between tries.
 * In that time `overnight build-now`, or a build that is running late, may have started the idea
 * again, and another run may have told the wearer already. Only an idea that is still failed,
 * still untold and not waiting for its second try gets the to-do.
 *
 * The time is recorded BEFORE Bee is asked and taken back only when Bee plainly refused, so no
 * outcome can buzz twice.
 */
async function notifyFailure(ctx: Context, ideaId: string): Promise<boolean> {
  const { store, bee, config, logger } = ctx;
  if (ctx.stopped()) return false;
  const idea = store.getIdea(ideaId);
  if (idea === null || idea.failureNotifiedAt !== null) return false;
  if (idea.state !== "build_failed" && idea.state !== "publish_failed") {
    logger.info("an idea is no longer failed, so the wearer is not told it could not be finished", { ideaId, state: idea.state });
    return false;
  }
  if (awaitingBuildRetry(ctx, idea)) return false;
  store.updateIdea(idea.id, { failureNotifiedAt: ctx.now().toISOString() }, ctx.now().toISOString());
  const todo = await unlessStopped(
    ctx,
    createInBee(ctx, "couldn't-finish to-do", idea.id, () => bee.createTodo(failureText(idea.title), morningAlarmAt(ctx.now(), config))),
  );
  // Stopped with Bee's answer still out: the to-do may exist, so the time stays recorded.
  if (todo === STOPPED || ctx.halted) return false;
  if (todo.outcome === "refused") {
    store.updateIdea(idea.id, { failureNotifiedAt: null }, ctx.now().toISOString());
    return false;
  }
  if (todo.outcome === "created") logger.info("told the wearer an app could not be finished", { ideaId: idea.id, todoId: todo.value.id, state: idea.state });
  return todo.outcome === "created";
}

/**
 * True for a failed build that is not a failure yet: it was stopped or cut off, and the night
 * builder still owes it a second try (core's rule, the same one the builder goes by). Until that
 * try has ended badly too, nobody is told. Says so in the log, by id only.
 * If the count of its build starts cannot be read, the answer is also true: saying nothing this
 * morning can be made up for tomorrow, a wrong "couldn't finish" on the wrist cannot be taken back.
 */
function awaitingBuildRetry(ctx: Context, idea: Idea): boolean {
  // Was it cut short at all? Asked of core as "with no start used up", so that which reasons
  // count as cut short is decided in one place. A build that really failed never gets past here.
  if (!isBuildAwaitingRetry(idea, 0)) return false;
  let starts: number;
  try {
    starts = ctx.store.countBuildStarts(idea.id);
  } catch (error) {
    ctx.logger.error("could not count an idea's build starts; not telling the wearer about it in this run", { ideaId: idea.id, error: errorSummary(error) });
    return true;
  }
  if (!isBuildAwaitingRetry(idea, starts)) return false;
  ctx.logger.info("a build that was cut short gets one more try; not telling the wearer it could not be finished", { ideaId: idea.id, buildStarts: starts });
  return true;
}

/**
 * The whole morning run: every idea in "built" (verify, publish, announce), every idea in
 * "published" that was not announced yet (announce only), and every build_failed or
 * publish_failed idea the wearer has not been told about (the 🌙 to-do), except a build that was
 * cut short and is still to be tried again. Never throws.
 * When deps.signal fires it stops as described at the top of this file and resolves within 10 seconds.
 */
export async function runDeliver(deps: DeliverDeps): Promise<DeliverSummary> {
  const ctx = makeContext(deps);
  const { store, logger } = ctx;
  const summary: DeliverSummary = { delivered: [], failed: [], notified: [] };
  /** Pushed in this run, but the page was not seen live before the wait ran out. */
  const notSeenLive: string[] = [];
  const add = (list: string[], id: string) => {
    if (!list.includes(id)) list.push(id);
  };
  /** One idea's trouble must not stop the others. */
  const safely = async (ideaId: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      add(summary.failed, ideaId);
      logger.error("could not deliver an idea", { ideaId, error: errorSummary(error) });
    }
  };
  /** An idea that was cut short by the stop signal is neither delivered nor failed: it waits for the next run. */
  const announceAndCount = async (ideaId: string) => {
    const told = await announce(ctx, ideaId);
    if (told === "delivered") add(summary.delivered, ideaId);
    else if (told === "not-told") add(summary.failed, ideaId);
  };

  const morning = async (): Promise<void> => {
    let waiting: { published: Idea[]; built: Idea[] };
    try {
      waiting = { published: store.listIdeas({ states: ["published"] }), built: store.listIdeas({ states: ["built"] }) };
    } catch (error) {
      logger.error("could not read the ideas to deliver", { error: errorSummary(error) });
      return;
    }

    // 1. Published by an earlier run that did not get as far as the to-do.
    for (const idea of waiting.published) {
      if (ctx.stopped()) return;
      await safely(idea.id, () => announceAndCount(idea.id));
    }

    // 2. Built last night: one at a time, and each is announced before the next one starts.
    for (const idea of waiting.built) {
      if (ctx.stopped()) return;
      await safely(idea.id, async () => {
        const published = await verifyAndPublish(ctx, idea);
        if (published.ok) {
          if (published.notSeenLive === true) add(notSeenLive, idea.id);
          await announceAndCount(idea.id);
        } else if (published.stopped !== true) add(summary.failed, idea.id);
      });
    }

    // 3. Anything that failed (last night's build, or the publish just now) and was not mentioned
    //    yet. A build that was only cut short is left out while its second try is still to come.
    //    This list can be old by the time an idea's turn comes, so notifyFailure reads each again.
    if (ctx.stopped()) return;
    let failures: Idea[] = [];
    try {
      failures = store.listIdeas({ states: ["build_failed", "publish_failed"] }).filter((idea) => idea.failureNotifiedAt === null && !awaitingBuildRetry(ctx, idea));
    } catch (error) {
      logger.error("could not read the failed ideas", { error: errorSummary(error) });
    }
    for (const idea of failures) {
      if (ctx.stopped()) return;
      try {
        if (await notifyFailure(ctx, idea.id)) add(summary.notified, idea.id);
      } catch (error) {
        logger.error("could not tell the wearer about a failure", { ideaId: idea.id, error: errorSummary(error) });
      }
    }
  };

  try {
    await withStopLimit(ctx, morning(), () => undefined);
  } catch (error) {
    logger.error("the deliver run stopped on an unexpected error", { error: errorSummary(error) });
  }
  if (ctx.stopped()) summary.stopped = true;
  logger.info("deliver run finished", { delivered: summary.delivered.length, failed: summary.failed.length, notified: summary.notified.length, notSeenLive: notSeenLive.length, stopped: ctx.stopped() });
  // A copy: if we answered before the step in progress had ended, nothing it does later changes the answer.
  return {
    delivered: [...summary.delivered],
    failed: [...summary.failed],
    notified: [...summary.notified],
    ...(summary.stopped ? { stopped: true as const } : {}),
    ...(notSeenLive.length > 0 ? { notSeenLive: [...notSeenLive] } : {}),
  };
}

/** The same steps for one idea, for `overnight build-now`. Never throws. Stops on deps.signal like runDeliver. */
export async function deliverOne(ideaId: string, deps: DeliverDeps): Promise<DeliverOneResult> {
  const ctx = makeContext(deps);
  const { store, logger } = ctx;
  const stoppedResult = (url?: string | null): DeliverOneResult => ({ ok: false, ...(url ? { url } : {}), reason: DELIVER_STOPPED_REASON, stopped: true });

  const one = async (): Promise<DeliverOneResult> => {
    const idea = store.getIdea(ideaId);
    if (idea === null) return { ok: false, reason: "There is no idea with that id." };
    const withUrl = (url: string | null | undefined) => (url ? { url } : {});

    if (idea.state === "delivered") return { ok: true, ...withUrl(idea.publishedUrl) };
    if (ctx.stopped()) return stoppedResult(idea.publishedUrl);
    if (idea.state === "build_failed") {
      // The same rule as the morning run: a build that was only cut short is not a failure yet.
      if (awaitingBuildRetry(ctx, idea)) return { ok: false, reason: BUILD_RETRY_PENDING_REASON };
      await notifyFailure(ctx, idea.id);
      return { ok: false, reason: idea.failureReason ?? "The build failed." };
    }
    let notSeenLive: { notSeenLive?: true } = {};
    if (idea.state === "built" || idea.state === "publish_failed") {
      const published = await verifyAndPublish(ctx, idea);
      if (!published.ok) {
        if (published.stopped === true) return stoppedResult();
        await notifyFailure(ctx, ideaId);
        return { ok: false, reason: published.reason };
      }
      if (published.notSeenLive === true) notSeenLive = { notSeenLive: true };
    } else if (idea.state !== "published") {
      return { ok: false, reason: `The idea is "${idea.state}", so there is nothing to deliver yet.` };
    }

    const told = await announce(ctx, ideaId);
    const url = store.getIdea(ideaId)?.publishedUrl;
    if (told === "delivered") return { ok: true, ...withUrl(url), ...notSeenLive };
    if (told === "stopped") return { ...stoppedResult(url), ...notSeenLive };
    return { ok: false, ...withUrl(url), ...notSeenLive, reason: "The app is published, but the Bee to-do could not be created. Delivering again will try once more." };
  };

  try {
    return await withStopLimit(ctx, one(), () => stoppedResult());
  } catch (error) {
    logger.error("could not deliver an idea", { ideaId, error: errorSummary(error) });
    return { ok: false, reason: "Delivery stopped on an unexpected error." };
  }
}
