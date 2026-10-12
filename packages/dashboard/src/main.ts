#!/usr/bin/env node
// The dashboard's command: `npm run dashboard` and `npm run dashboard:demo`.
//
// It starts a web page on this Mac that only reads, prints the link that opens it, and runs
// until it is stopped with Ctrl-C. It is a viewer and nothing else: it never makes a folder,
// never opens the database for writing and never talks to Bee, Kiro or GitHub.
//
//   - Without --demo it shows Overnight's own data, with the same settings as every other
//     command (`.env` at the top of the repo), and only ever on the one fixed port.
//   - With --demo it shows invented data in a throwaway folder (src/demo, loaded only then),
//     by a pretend clock that reads 1:02 AM. Nothing real is opened, and `.env` is not read.
//
// Exit codes: 0 stopped (or --help), 1 could not start, 2 a wrong option or a bad setting.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, DASHBOARD_PORT, dataPaths, loadConfig } from "@overnight/core";
import type { Config, DataPaths } from "@overnight/core";
import { DASHBOARD_USAGE, optionsNpmKept, parseDashboardArgs } from "./args.ts";
import { homeTilde } from "./render/format.ts";
import { createDashboard } from "./server/server.ts";
import { createSite } from "./site.ts";

const EXIT_STOPPED = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/** The repo root, worked out from where this file lives (packages/dashboard/src), as the `overnight` command does. */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const say = (line: string): void => console.log(line);
const complain = (line: string): void => console.error(line);

/** What the page is shown from: the settings, the folders, the clock, and how to put it all away again. */
interface Showing {
  config: Config;
  paths: DataPaths;
  now?: () => Date;
  /** Starts the invented night (demo with --play). */
  play?: () => void;
  /** Lets go of whatever was set up for the show. */
  close(): void;
}

async function main(argv: readonly string[]): Promise<number | "running"> {
  const args = parseDashboardArgs(argv);
  if (args.ok && args.help) {
    say(DASHBOARD_USAGE);
    return EXIT_STOPPED;
  }
  // Before any setting is read or any folder is looked at: an option typed before npm's "--"
  // never got here, and starting without --filming or --demo is the unsafe way to be wrong.
  const kept = optionsNpmKept(argv, process.env);
  if (kept !== null) {
    complain(kept);
    return EXIT_USAGE;
  }
  if (!args.ok) {
    complain(args.problem);
    return EXIT_USAGE;
  }

  // Real data is only ever shown on the one fixed port. A number given with --port only comes with --demo (args.ts).
  const port = args.demo ? (args.port ?? DASHBOARD_PORT) : DASHBOARD_PORT;

  let showing: Showing;
  if (args.demo) {
    // The only place the writing half of this package is loaded.
    const { openDemoStage } = await import("./demo/stage.ts");
    const stage = openDemoStage();
    showing = {
      config: stage.config,
      paths: stage.paths,
      now: stage.now,
      play: () => stage.play({ onProblem: (kind) => say(`dashboard: the invented night stopped (${kind})`) }),
      close: () => stage.close(),
    };
  } else {
    let config: Config;
    try {
      config = loadConfig(repoRoot());
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      complain(error.message);
      complain("Settings live in the .env file at the top of the repo (see .env.example).");
      return EXIT_USAGE;
    }
    // Only the names of the folders are worked out here. Nothing is made: a data folder that is not there shows as "Nothing saved yet".
    showing = { config, paths: dataPaths(config.dataDir), close: () => {} };
  }

  const filming = { on: args.filming, showQuoteFor: new Set(args.showQuoteFor) };
  const site = createSite({ config: showing.config, paths: showing.paths, filming, demo: args.demo, port, now: showing.now });
  const dashboard = createDashboard({ site, port });

  let started: { keyUrl: string };
  try {
    started = await dashboard.listen();
  } catch (error) {
    showing.close();
    await dashboard.close();
    if ((error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE") {
      complain(
        args.demo
          ? `Port ${port} is in use. The dashboard may already be running. Stop it first, or pick another: npm run dashboard:demo -- --port ${port === 4322 ? 4323 : 4322}`
          : `Port ${port} is in use. The dashboard may already be running. Stop it first.`,
      );
    } else {
      complain(`The dashboard could not start on port ${port}.`);
    }
    return EXIT_FAILED;
  }

  // Ctrl-C, or a stop from outside: stop answering, drop every connection, put the demo away, end.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void dashboard
      .close()
      .catch(() => {})
      .then(() => {
        try {
          showing.close();
        } finally {
          process.exit(EXIT_STOPPED);
        }
      });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);

  say(`Overnight dashboard: ${started.keyUrl}`);
  if (args.demo) say("Demo data: everything shown is invented. Stop it with Ctrl-C.");
  else say(`It only reads ${homeTilde(showing.config.dataDir, homedir())}. Stop it with Ctrl-C.`);
  if (args.filming) say("Filming mode is on: what was said is hidden.");
  if (args.demo && args.play) {
    say("An invented night starts in a few seconds and ticks through by itself.");
    showing.play?.();
  }
  return "running";
}

try {
  const outcome = await main(process.argv.slice(2));
  if (outcome !== "running") process.exitCode = outcome;
} catch (error) {
  // The demo's own refusals are plain sentences that name no folder. Of anything else only the kind is said: a message can hold a path.
  const known = error instanceof Error && error.name === "DemoFolderError";
  complain(known ? error.message : `The dashboard could not start (${error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : "Error"}).`);
  process.exitCode = EXIT_FAILED;
}
