#!/usr/bin/env node
// The `overnight` command. Run as `npx overnight <command>`, `npm run overnight -- <command>`,
// or by the background job as `node packages/cli/src/main.ts listen`.
// All the work is in cli.ts and src/commands; this file only starts it and sets the exit code.
import { runCli } from "./cli.ts";
import { exitOnceFlushed } from "./exit.ts";

const code = await runCli(process.argv.slice(2));
process.exitCode = code;

// Normally the process ends by itself here, with everything it printed delivered. If something
// is still holding it open after that (a stray timer or child process), do not let it linger.
exitOnceFlushed(code);
