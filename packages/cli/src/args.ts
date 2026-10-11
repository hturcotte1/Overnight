// Command-line parsing by hand: one command word, then on/off switches like --json, and (for
// build-now and rehearse only) a few more words, such as an idea's id. No switch takes a value,
// so there is nothing more to it.

export interface ParsedArgs {
  command: string | null;
  /** Switch names without the dashes: "--json" is "json". "-h" counts as "help". */
  flags: Set<string>;
  /** Anything after the command that is not a switch. build-now takes the idea's id; rehearse takes "new" or "run" and their words. */
  extras: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | null = null;
  const flags = new Set<string>();
  const extras: string[] = [];
  for (const arg of argv) {
    if (arg === "-h") flags.add("help");
    else if (arg.startsWith("-")) flags.add(arg.replace(/^-+/, ""));
    else if (command === null) command = arg;
    else extras.push(arg);
  }
  return { command, flags, extras };
}
