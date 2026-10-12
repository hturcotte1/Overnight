// The dashboard's command line, read by hand: a few switches, two of which take one word.
// Pure: it is given the words and says what they mean, or refuses in one plain sentence.
//
// The rules that keep real data safe live here, so they hold however the dashboard is started:
//   --port and --play only come with --demo (real data is only ever served on the one fixed port);
//   --show-quote only comes with --filming, and only takes something that looks like an idea's id.
import { DASHBOARD_PORT } from "@overnight/core";
import { IDEA_ID } from "./types.ts";

/**
 * What the words mean.
 * `help: true` stands apart on purpose: it has no settings in it, so a caller cannot start the
 * dashboard on real data because someone asked what the options were.
 */
export type DashboardArgs =
  | {
      ok: true;
      help: false;
      /** null: the usual port (DASHBOARD_PORT). A number only ever comes with `demo`. */
      port: number | null;
      filming: boolean;
      /** The ideas whose quote may be shown while filming, in the order given, each once. */
      showQuoteFor: string[];
      demo: boolean;
      play: boolean;
    }
  | { ok: true; help: true }
  | { ok: false; problem: string };

/** The ports --port takes. Those below 1024 belong to the system. */
const MIN_PORT = 1024;
const MAX_PORT = 65_535;

/** The help text. Keep it in step with the switches below, with README and with CLAUDE.md. */
export const DASHBOARD_USAGE = `The Overnight dashboard: a web page on this Mac that only reads.

  npm run dashboard                                   Overnight's real data, on port ${DASHBOARD_PORT}
  npm run dashboard -- --filming                      the same, with what was said hidden
  npm run dashboard -- --filming --show-quote <id>    hidden, except this one idea's quote
  npm run dashboard:demo                              invented data in a throwaway folder
  npm run dashboard:demo -- --play                    invented data, and an invented night ticks through
  npm run dashboard:demo -- --port 4322               invented data on another port

  --filming              Hide every quote, the ideas nobody has approved, and the build notes.
  --show-quote <ideaId>  With --filming: show this idea's quote all the same. Can be given more than once.
  --demo                 Show invented data instead of Overnight's own. Nothing real is opened.
  --play                 With --demo: run an invented night, step by step.
  --port <n>             With --demo: the port to use, ${MIN_PORT} to ${MAX_PORT}.
  --help                 Show this text.

The options go after the two dashes. Typed before them they stay with npm and never reach the
dashboard, which then refuses to start rather than start without them.

It prints a link with a key in it. The dashboard opens from that link and shows nothing without it.
Stop it with Ctrl-C.`;

export function parseDashboardArgs(argv: readonly string[]): DashboardArgs {
  // --help wins over everything else on the line, mistakes included: someone asking for help
  // should get it.
  if (argv.includes("--help") || argv.includes("-h")) return { ok: true, help: true };

  let port: number | null = null;
  let filming = false;
  let demo = false;
  let play = false;
  const showQuoteFor: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (word === "--filming") filming = true;
    else if (word === "--demo") demo = true;
    else if (word === "--play") play = true;
    else if (word === "--show-quote") {
      index += 1;
      const id = argv[index];
      if (id === undefined || id.startsWith("-")) return refuse("--show-quote needs an idea's id after it.");
      if (!IDEA_ID.test(id)) return refuse(`--show-quote takes an idea's id (letters, digits, "-" and "_"), and ${shown(id)} is not one.`);
      if (!showQuoteFor.includes(id)) showQuoteFor.push(id);
    } else if (word === "--port") {
      index += 1;
      const value = argv[index];
      if (port !== null) return refuse("--port was given more than once.");
      // Plain digits with no zero in front: "04322" and "4322.0" are somebody's slip, not a port.
      if (value === undefined || !/^[1-9][0-9]{3,4}$/.test(value) || Number(value) < MIN_PORT || Number(value) > MAX_PORT) {
        return refuse(`--port needs a number from ${MIN_PORT} to ${MAX_PORT} after it.`);
      }
      port = Number(value);
    } else {
      return refuse(`The dashboard has no option ${shown(word)}; --help lists the ones it has.`);
    }
  }

  if (port !== null && !demo) return refuse(`--port only works with --demo: Overnight's real data is only ever shown on port ${DASHBOARD_PORT}.`);
  if (play && !demo) return refuse("--play only works with --demo: it runs an invented night on invented data.");
  if (showQuoteFor.length > 0 && !filming) return refuse("--show-quote only works with --filming: without it every quote is shown anyway.");
  return { ok: true, help: false, port, filming, showQuoteFor, demo, play };
}

function refuse(problem: string): DashboardArgs {
  return { ok: false, problem };
}

/** A word from the command line, quoted and cut short, safe to print back. */
function shown(word: string): string {
  return JSON.stringify(word.length > 40 ? `${word.slice(0, 40)}...` : word);
}

// ---------- options that npm kept for itself ----------

/** The scripts in the root package.json that start the dashboard. Only one of these names is ever printed back. */
const DASHBOARD_SCRIPT = /^dashboard(:(demo|filming))?$/;

/** How each option shows up in the environment when npm has kept it: npm hands its scripts `npm_config_<name>`. */
const KEPT_AS: ReadonlyArray<{ option: string; name: string; takes: string | null }> = [
  { option: "--demo", name: "npm_config_demo", takes: null },
  { option: "--filming", name: "npm_config_filming", takes: null },
  { option: "--show-quote", name: "npm_config_show_quote", takes: "<ideaId>" },
  { option: "--play", name: "npm_config_play", takes: null },
  { option: "--port", name: "npm_config_port", takes: "<n>" },
];

/**
 * npm reads "--play" as four of its own one-letter switches run together (-p -l -a -y), so that
 * one leaves no `npm_config_play` behind: it leaves these four, all switched on, and no warning.
 */
const PLAY_AS_NPM_READS_IT = ["npm_config_parseable", "npm_config_long", "npm_config_all", "npm_config_yes"] as const;

function switchedOn(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "false";
}

/**
 * Were any of the dashboard's options typed before npm's "--"? npm keeps those for itself and
 * starts the script without them: `npm run dashboard --filming` would show every quote, and
 * `npm run dashboard --demo` would open Overnight's real data instead of invented data. Both
 * fail in the unsafe direction, so the command refuses to start and says how to type it.
 *
 * Gives that one sentence, or null when nothing was kept back. An option that npm kept but that
 * was also given properly (it is in `argv`) is fine. Pure: `env` is the environment, handed in.
 */
export function optionsNpmKept(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string | null {
  const kept = KEPT_AS.filter(({ option, name }) => {
    const byName = switchedOn(env[name]);
    const asLetters = option === "--play" && PLAY_AS_NPM_READS_IT.every((letter) => env[letter] === "true");
    return (byName || asLetters) && !argv.includes(option);
  });
  if (kept.length === 0) return null;
  const names = kept.map(({ option }) => option);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const script = DASHBOARD_SCRIPT.test(env.npm_lifecycle_event ?? "") ? env.npm_lifecycle_event : "dashboard";
  const typed = kept.map(({ option, takes }) => (takes === null ? option : `${option} ${takes}`)).join(" ");
  const [was, it] = names.length === 1 ? ["was", "it"] : ["were", "them"];
  return `${list} ${was} typed before npm's two dashes, so npm kept ${it} and the dashboard was not started without ${it}. Put ${it} after the two dashes: npm run ${script} -- ${typed}`;
}
