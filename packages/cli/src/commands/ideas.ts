// `overnight ideas`: today's ideas, or all of them.
// The plain listing shows titles only. The quote (real speech) and the pitch appear only with
// --json, which is for programs, not for a screen someone else might be looking at.
// Once an idea has been through a build, its line is followed by what came of it: the folder
// name of its app (the slug), the link once it is published, and the reason if it failed.
import { formatLocal, IDEA_STATES, isBuildAwaitingRetry, localDayBounds } from "@overnight/core";
import type { Config, Idea, Store } from "@overnight/core";
import { oneLine, plural, toJson } from "../output.ts";
import type { Write } from "../output.ts";
import { isRehearsalIdea } from "./rehearse.ts";

export interface IdeasDeps {
  store: Pick<Store, "listIdeas" | "countBuildStarts">;
  config: Pick<Config, "timeZone">;
  write: Write;
  now?: () => Date;
}

export interface IdeasOptions {
  json?: boolean;
  /** Every idea ever heard, not just today's. */
  all?: boolean;
}

const STATE_WIDTH = Math.max(...IDEA_STATES.map((state) => state.length));

/** In front of the title of an idea made by `overnight rehearse new`: invented, never heard by Bee. */
export const REHEARSAL_MARK = "[rehearsal]";

function line(idea: Idea, timeZone: string): string {
  const when = formatLocal(new Date(idea.createdAt), timeZone);
  const note = idea.note === null ? "" : `  (${oneLine(idea.note)})`;
  // The note changes as an idea moves on; where it came from does not. So the mark goes by that.
  const mark = isRehearsalIdea(idea) ? `${REHEARSAL_MARK} ` : "";
  return `  ${idea.id}  ${idea.state.padEnd(STATE_WIDTH)}  ${when}  ${mark}${oneLine(idea.title)}${note}`;
}

const FAILED_STATES: readonly Idea["state"][] = ["build_failed", "publish_failed"];

/** What is said under an idea whose build was cut short and has its one second try coming. */
export const SECOND_TRY_LINE = "its build was cut off, not failed: it will be built once more at the next nightly build, and nobody has been told yet";

/**
 * The indented lines under an idea that has been through a build. None for an idea that has not.
 * `awaitingSecondTry` is core's isBuildAwaitingRetry for this idea.
 */
export function buildLines(idea: Idea, awaitingSecondTry = false): string[] {
  const rows: Array<[label: string, value: string]> = [];
  if (idea.slug !== null) rows.push(["slug", oneLine(idea.slug)]);
  if (idea.publishedUrl !== null) rows.push(["link", oneLine(idea.publishedUrl)]);
  // An old reason is kept on the idea after a later try has worked. Show it only while it is true.
  if (FAILED_STATES.includes(idea.state)) rows.push(["failed", idea.failureReason === null ? "no reason was recorded" : oneLine(idea.failureReason)]);
  if (awaitingSecondTry) rows.push(["next", SECOND_TRY_LINE]);
  return rows.map(([label, value]) => `      ${label.padEnd(6)}  ${value}`);
}

export function ideas(deps: IdeasDeps, options: IdeasOptions = {}): number {
  const { store, config, write } = deps;
  // "Today" is the local calendar day, the same day the ask limit counts in.
  const since = options.all ? undefined : localDayBounds(deps.now?.() ?? new Date(), config.timeZone).start.toISOString();
  const list = store.listIdeas(since === undefined ? {} : { createdSince: since });

  if (options.json) {
    write(toJson(list));
    return 0;
  }
  const scope = options.all ? "so far" : "today";
  if (list.length === 0) {
    write(`No ideas ${scope}.`);
    return 0;
  }
  write(`${plural(list.length, "idea")} ${scope}:`);
  for (const idea of list) {
    write(line(idea, config.timeZone));
    // Only a failed build can be waiting for a second try, so only those are counted.
    const awaitingSecondTry = idea.state === "build_failed" && isBuildAwaitingRetry(idea, store.countBuildStarts(idea.id));
    for (const extra of buildLines(idea, awaitingSecondTry)) write(extra);
  }
  return 0;
}
