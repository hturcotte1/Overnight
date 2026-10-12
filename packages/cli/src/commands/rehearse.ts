// `overnight rehearse`: try the night and the morning on an invented idea, without Bee.
//
//   overnight rehearse new "<title>" "<pitch>"    adds one invented idea, already approved, dated
//                                                 yesterday, and prints its id
//   overnight rehearse run <ideaId> [--no-publish]
//                                                 builds it for real, checks it in the sandbox,
//                                                 publishes it for real (unless --no-publish) and
//                                                 records it as delivered
//
// It is `overnight build-now` with two differences, and they are the whole point:
//   - It refuses the real data folder (../rehearsal-folder.ts says which that is, and why).
//   - Bee is ALWAYS a stand-in (../rehearsal-stand-ins.ts). The real Bee gateway is never made
//     on this path, and @overnight/bee is not even loaded. What the wearer would have been told
//     is written to <data folder>/rehearsal-bee.log instead.
// Everything else is the real thing: the settings (BUILD_BACKEND still picks the builder), the
// locks, the stop signals, both builders, the sandboxed check, and the publisher unless
// --no-publish swaps in a stand-in for it too.
//
// A title and a pitch typed here end up in a public app when the run publishes. Use made-up
// words only, as for any brief.
import { nowIso } from "@overnight/core";
import type { Idea, Store } from "@overnight/core";
import { oneLine } from "../output.ts";
import { createStandInBee, createStandInPublisher, rehearsalBeeLogFile } from "../rehearsal-stand-ins.ts";
import { buildNow } from "./build-now.ts";
import type { BuildNowDeps } from "./build-now.ts";
import type { DeliverFactories, DeliverSteps } from "./deliver.ts";

/** Every rehearsal idea belongs to this made-up conversation. No real conversation has this key: real keys are random. */
export const REHEARSAL_CONVERSATION_KEY = "rehearsal";
/** The note a rehearsal idea is created with. */
export const REHEARSAL_NOTE = "rehearsal: an invented idea, never heard by Bee";
export const REHEARSAL_ASKED_NOTE = "rehearsal: never asked on the wrist";
export const REHEARSAL_APPROVED_NOTE = "rehearsal: approved by hand, not on the wrist";
/** The note a rehearsal idea ends with once its run has gone all the way. */
export const REHEARSAL_DELIVERED_NOTE = "rehearsal: delivered to a stand-in, nothing was sent to Bee";

/** The command's name in the build and deliver logs, also on the lines its build and deliver steps write. */
export const REHEARSE_NAME = "overnight rehearse";

export const MAX_REHEARSAL_TITLE_CHARS = 80;
export const MAX_REHEARSAL_PITCH_CHARS = 400;

const DAY_MS = 24 * 3_600_000;
const TEN_MINUTES_MS = 600_000;

export function isRehearsalIdea(idea: Pick<Idea, "conversationKey">): boolean {
  return idea.conversationKey === REHEARSAL_CONVERSATION_KEY;
}

/**
 * The commands that only ever run on real data: the listener, the two night jobs' commands and
 * build-now. None of them runs on a data folder that holds a rehearsal idea.
 */
export const REAL_DATA_ONLY_COMMANDS = ["listen", "build", "deliver", "build-now"] as const;
export type RealDataOnlyCommand = (typeof REAL_DATA_ONLY_COMMANDS)[number];

export function isRealDataOnlyCommand(command: string): command is RealDataOnlyCommand {
  return (REAL_DATA_ONLY_COMMANDS as readonly string[]).includes(command);
}

/**
 * For the commands in REAL_DATA_ONLY_COMMANDS: a data folder that holds a rehearsal idea is a
 * rehearsal folder, and they do not run on it. Otherwise a rehearsal idea left half-way (a failed
 * build, say) would be announced on the wearer's wrist by the next real `deliver` pointed at that
 * folder, and one left approved would be built by the next real `build` as if the wearer had
 * said yes to it. Null when the folder holds none.
 */
export function rehearsalFolderRefusal(store: Pick<Store, "listIdeas">, command: string): string | null {
  const count = store.listIdeas().filter(isRehearsalIdea).length;
  if (count === 0) return null;
  const why = command === "build" ? `"overnight build" is the real nightly build` : `"overnight ${command}" talks to the real Bee`;
  return `Not started: this data folder holds ${count === 1 ? "a rehearsal idea" : `${count} rehearsal ideas`} (made by "overnight rehearse new"), and ${why}, so it does not run here. Use "npx overnight rehearse run <ideaId>" for those, or a data folder with no rehearsal in it.`;
}

export interface RehearseNewDeps {
  store: Pick<Store, "createIdea" | "transitionIdea" | "getValue" | "setPaused">;
  /** Prints the new idea's id, and nothing else: a script reads it. */
  write: (line: string) => void;
  /** Everything meant for a person. */
  writeError: (line: string) => void;
  now?: () => Date;
  /** Why a rehearsal may not use this data folder, or null when it may (../rehearsal-folder.ts). */
  folderProblem: () => string | null;
}

/**
 * Add one invented idea, already approved. Exit code 0 and the id on standard output; 2 when the
 * folder is refused or the words are unusable.
 */
export function rehearseNew(titleGiven: string, pitchGiven: string, deps: RehearseNewDeps): number {
  const refused = deps.folderProblem();
  if (refused !== null) {
    deps.writeError(refused);
    return 2;
  }
  const title = oneLine(titleGiven);
  const pitch = oneLine(pitchGiven);
  if (title === "" || pitch === "") {
    deps.writeError('A rehearsal idea needs a title and a pitch: overnight rehearse new "<title>" "<pitch>"');
    return 2;
  }
  if (title.length > MAX_REHEARSAL_TITLE_CHARS || pitch.length > MAX_REHEARSAL_PITCH_CHARS) {
    deps.writeError(`Too long: a title has at most ${MAX_REHEARSAL_TITLE_CHARS} characters and a pitch at most ${MAX_REHEARSAL_PITCH_CHARS}.`);
    return 2;
  }

  const now = deps.now?.() ?? new Date();
  // Dated yesterday, so it counts against nobody's limits for today.
  const heardAt = new Date(now.getTime() - DAY_MS - TEN_MINUTES_MS).toISOString();
  const approvedAt = new Date(now.getTime() - DAY_MS).toISOString();
  const idea = deps.store.createIdea({ title, pitch, quote: "", confidence: 1, conversationKey: REHEARSAL_CONVERSATION_KEY, detectorRunId: null, note: REHEARSAL_NOTE }, heardAt);
  deps.store.transitionIdea(idea.id, "asked", { askedAt: heardAt, note: REHEARSAL_ASKED_NOTE }, heardAt);
  deps.store.transitionIdea(idea.id, "approved", { answeredAt: approvedAt, note: REHEARSAL_APPROVED_NOTE }, approvedAt);

  // A data folder nobody has paused or resumed is in quiet mode (that is how Overnight starts),
  // and nothing is built in quiet mode. A rehearsal folder has no wrist to keep quiet for.
  if (deps.store.getValue("paused") === null) {
    deps.store.setPaused(false, nowIso(now));
    deps.writeError("This data folder had never been paused or resumed, so quiet mode was switched off in it: a build is refused in quiet mode.");
  }
  deps.writeError(`Added a rehearsal idea, already approved. Build and deliver it with: npx overnight rehearse run ${idea.id}`);
  deps.write(idea.id);
  return 0;
}

export interface RehearseRunDeps<Backend = unknown> extends Omit<BuildNowDeps<Backend>, "loadDeliverFactories"> {
  /** Loads @overnight/deliver, and only that: never the Bee gateway. */
  loadDeliverSteps: () => Promise<DeliverSteps>;
  /** Why a rehearsal may not use this data folder, or null when it may (../rehearsal-folder.ts). */
  folderProblem: () => string | null;
}

export interface RehearseRunOptions {
  /** Do everything but the publish: a stand-in publisher answers with a link that cannot exist. */
  noPublish?: boolean;
}

/**
 * Build one rehearsal idea and take it all the way to "delivered", telling Bee nothing.
 * Resolves with the exit code: 0 only when the idea ends up delivered; 2 when the folder is
 * refused; otherwise what `overnight build-now` would answer (1, or 130, 143, 129 on a stop signal).
 */
export async function rehearseRun<Backend>(ideaId: string, options: RehearseRunOptions, deps: RehearseRunDeps<Backend>): Promise<number> {
  const { store, paths, write, writeError } = deps;
  const noPublish = options.noPublish === true;

  const refused = deps.folderProblem();
  if (refused !== null) {
    writeError(refused);
    return 2;
  }
  const idea = store.getIdea(ideaId);
  if (idea === null) {
    writeError(`No idea has the id "${oneLine(ideaId).slice(0, 80)}". Make one with: npx overnight rehearse new "<title>" "<pitch>"`);
    return 1;
  }
  if (!isRehearsalIdea(idea)) {
    writeError('Not started: that idea was not made by "overnight rehearse new", and a rehearsal only ever builds an invented idea.');
    return 1;
  }

  const beeLog = rehearsalBeeLogFile(paths);
  const now = deps.now ?? (() => new Date());
  const standInBee = createStandInBee({ file: beeLog, now });
  const standInPublisher = createStandInPublisher({ file: beeLog, now });
  const loadDeliverFactories = async (): Promise<DeliverFactories> => {
    const steps = await deps.loadDeliverSteps();
    return {
      // The one Bee a rehearsal ever has.
      createBee: () => standInBee,
      runDeliver: (given) => steps.runDeliver(noPublish ? { ...given, publish: standInPublisher } : given),
      deliverOne: (id, given) => steps.deliverOne(id, noPublish ? { ...given, publish: standInPublisher } : given),
    };
  };

  write(`Rehearsal: Bee is a stand-in. What it would have been told goes to ${beeLog}`);
  write(noPublish ? "Rehearsal: the publisher is a stand-in too (--no-publish). Nothing leaves this Mac but the build's own downloads." : "Rehearsal: this run PUBLISHES the app for real, on the public apps page. (--no-publish skips that.)");
  // In both logs: the deliver step's own lines ("told the wearer about a built app") read the
  // same in a rehearsal, and here they are about the stand-in.
  for (const logger of [deps.buildLogger, deps.deliverLogger]) {
    logger.info(`${REHEARSE_NAME}: a rehearsal run is starting; Bee is a stand-in, so nothing in this run reaches the wearer`, { ideaId: idea.id, beeStandIn: true, publisherStandIn: noPublish });
  }

  const code = await buildNow(idea.id, { ...deps, loadDeliverFactories, commandName: REHEARSE_NAME });

  const after = store.getIdea(idea.id);
  if (after?.state === "delivered" && after.note !== REHEARSAL_DELIVERED_NOTE) {
    try {
      // The builder and the deliver step wrote their own notes on the way. Say again what this idea is.
      store.setIdeaNote(idea.id, REHEARSAL_DELIVERED_NOTE, nowIso(now()));
    } catch {
      // The idea is delivered either way; `overnight ideas` still marks it as a rehearsal.
    }
  }
  deps.deliverLogger.info(`${REHEARSE_NAME}: the rehearsal run is over`, { ideaId: idea.id, exitCode: code, state: after?.state ?? "unknown" });
  write(`Nothing was sent to Bee. What it would have been told is in ${beeLog}`);
  if (noPublish) write("Nothing was published: any link above is a stand-in.");
  return code;
}
