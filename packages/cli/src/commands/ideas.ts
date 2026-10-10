// `overnight ideas`: today's ideas, or all of them.
// The plain listing shows titles only. The quote (real speech) and the pitch appear only with
// --json, which is for programs, not for a screen someone else might be looking at.
import { formatLocal, IDEA_STATES, localDayBounds } from "@overnight/core";
import type { Config, Idea, Store } from "@overnight/core";
import { oneLine, plural, toJson } from "../output.ts";
import type { Write } from "../output.ts";

export interface IdeasDeps {
  store: Pick<Store, "listIdeas">;
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

function line(idea: Idea, timeZone: string): string {
  const when = formatLocal(new Date(idea.createdAt), timeZone);
  const note = idea.note === null ? "" : `  (${oneLine(idea.note)})`;
  return `  ${idea.id}  ${idea.state.padEnd(STATE_WIDTH)}  ${when}  ${oneLine(idea.title)}${note}`;
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
  for (const idea of list) write(line(idea, config.timeZone));
  return 0;
}
