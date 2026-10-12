// The dashboard's command line: every switch and every refusal. The ids here are invented.
import { DASHBOARD_PORT } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { DASHBOARD_USAGE, optionsNpmKept, parseDashboardArgs } from "../src/args.ts";

const PLAIN = { ok: true, help: false, port: null, filming: false, showQuoteFor: [], demo: false, play: false };

describe("parseDashboardArgs: what it takes", () => {
  it("with no words: real data, the usual port, quotes shown", () => {
    expect(parseDashboardArgs([])).toEqual(PLAIN);
  });

  it("--filming", () => {
    expect(parseDashboardArgs(["--filming"])).toEqual({ ...PLAIN, filming: true });
  });

  it("--filming --show-quote <ideaId>, once or several times, in the order given", () => {
    expect(parseDashboardArgs(["--filming", "--show-quote", "idea_01"])).toEqual({ ...PLAIN, filming: true, showQuoteFor: ["idea_01"] });
    expect(parseDashboardArgs(["--show-quote", "idea_02", "--filming", "--show-quote", "idea_01"])).toEqual({ ...PLAIN, filming: true, showQuoteFor: ["idea_02", "idea_01"] });
  });

  it("names an idea once, however often it is given", () => {
    expect(parseDashboardArgs(["--filming", "--show-quote", "idea_01", "--show-quote", "idea_02", "--show-quote", "idea_01"])).toEqual({ ...PLAIN, filming: true, showQuoteFor: ["idea_01", "idea_02"] });
  });

  it("takes every shape an idea's id can have", () => {
    for (const id of ["7", "a", "Idea-01_x", "a".repeat(80), "constructor"]) {
      expect(parseDashboardArgs(["--filming", "--show-quote", id])).toEqual({ ...PLAIN, filming: true, showQuoteFor: [id] });
    }
  });

  it("--demo", () => {
    expect(parseDashboardArgs(["--demo"])).toEqual({ ...PLAIN, demo: true });
  });

  it("--demo --play", () => {
    expect(parseDashboardArgs(["--demo", "--play"])).toEqual({ ...PLAIN, demo: true, play: true });
    expect(parseDashboardArgs(["--play", "--demo"])).toEqual({ ...PLAIN, demo: true, play: true });
  });

  it("--demo --port <n>, from 1024 to 65535", () => {
    expect(parseDashboardArgs(["--demo", "--port", "4322"])).toEqual({ ...PLAIN, demo: true, port: 4322 });
    expect(parseDashboardArgs(["--port", "1024", "--demo"])).toEqual({ ...PLAIN, demo: true, port: 1024 });
    expect(parseDashboardArgs(["--demo", "--port", "65535"])).toEqual({ ...PLAIN, demo: true, port: 65_535 });
    expect(parseDashboardArgs(["--demo", "--port", String(DASHBOARD_PORT)])).toEqual({ ...PLAIN, demo: true, port: DASHBOARD_PORT });
  });

  it("everything the demo takes, together", () => {
    expect(parseDashboardArgs(["--demo", "--play", "--port", "4322", "--filming", "--show-quote", "idea_01"])).toEqual({ ok: true, help: false, port: 4322, filming: true, showQuoteFor: ["idea_01"], demo: true, play: true });
  });

  it("a switch given twice means the same as once (npm run dashboard:demo -- --demo)", () => {
    expect(parseDashboardArgs(["--demo", "--demo", "--filming", "--filming", "--play", "--play"])).toEqual({ ...PLAIN, demo: true, filming: true, play: true });
  });

  it("does not change the words it was given", () => {
    const argv = Object.freeze(["--filming", "--show-quote", "idea_01"]);
    parseDashboardArgs(argv);
    expect(argv).toEqual(["--filming", "--show-quote", "idea_01"]);
  });
});

describe("parseDashboardArgs: --help", () => {
  it("--help and -h ask for the help text and carry no settings at all", () => {
    expect(parseDashboardArgs(["--help"])).toEqual({ ok: true, help: true });
    expect(parseDashboardArgs(["-h"])).toEqual({ ok: true, help: true });
  });

  it("wins over everything else on the line, mistakes included", () => {
    expect(parseDashboardArgs(["--demo", "--port", "4322", "--help"])).toEqual({ ok: true, help: true });
    expect(parseDashboardArgs(["--bogus", "--help"])).toEqual({ ok: true, help: true });
    expect(parseDashboardArgs(["--port", "--help"])).toEqual({ ok: true, help: true });
    expect(parseDashboardArgs(["--show-quote", "-h"])).toEqual({ ok: true, help: true });
  });

  it("the help text names every switch, both commands and the fixed port", () => {
    for (const word of ["--filming", "--show-quote <ideaId>", "--demo", "--play", "--port <n>", "--help", "npm run dashboard ", "npm run dashboard:demo", `port ${DASHBOARD_PORT}`, "1024 to 65535", "only reads", "Ctrl-C"]) {
      expect(DASHBOARD_USAGE).toContain(word);
    }
  });

  it("the help text takes no option that the parser refuses", () => {
    const switches = new Set(DASHBOARD_USAGE.match(/--[a-z-]+/g));
    expect([...switches].sort()).toEqual(["--demo", "--filming", "--help", "--play", "--port", "--show-quote"]);
  });
});

describe("parseDashboardArgs: what it refuses, each in one plain sentence", () => {
  const refusals: Array<[string, string[], string]> = [
    ["--port without --demo", ["--port", "4322"], `--port only works with --demo: Overnight's real data is only ever shown on port ${DASHBOARD_PORT}.`],
    ["--port with --filming but without --demo", ["--filming", "--port", "4322"], `--port only works with --demo: Overnight's real data is only ever shown on port ${DASHBOARD_PORT}.`],
    ["--port naming the usual port, without --demo", ["--port", String(DASHBOARD_PORT)], `--port only works with --demo: Overnight's real data is only ever shown on port ${DASHBOARD_PORT}.`],
    ["--play without --demo", ["--play"], "--play only works with --demo: it runs an invented night on invented data."],
    ["--play with --filming but without --demo", ["--filming", "--play"], "--play only works with --demo: it runs an invented night on invented data."],
    ["--show-quote without --filming", ["--show-quote", "idea_01"], "--show-quote only works with --filming: without it every quote is shown anyway."],
    ["--show-quote with --demo but without --filming", ["--demo", "--show-quote", "idea_01"], "--show-quote only works with --filming: without it every quote is shown anyway."],
    ["--show-quote with nothing after it", ["--filming", "--show-quote"], "--show-quote needs an idea's id after it."],
    ["--show-quote followed by another switch", ["--show-quote", "--filming"], "--show-quote needs an idea's id after it."],
    ["--show-quote with an empty id", ["--filming", "--show-quote", ""], `--show-quote takes an idea's id (letters, digits, "-" and "_"), and "" is not one.`],
    ["--show-quote with a path", ["--filming", "--show-quote", "../etc"], `--show-quote takes an idea's id (letters, digits, "-" and "_"), and "../etc" is not one.`],
    ["--show-quote with a space in the id", ["--filming", "--show-quote", "idea 01"], `--show-quote takes an idea's id (letters, digits, "-" and "_"), and "idea 01" is not one.`],
    ["--show-quote with an id that starts with an underscore", ["--filming", "--show-quote", "_idea"], `--show-quote takes an idea's id (letters, digits, "-" and "_"), and "_idea" is not one.`],
    ["--show-quote with an id of 81 characters", ["--filming", "--show-quote", "a".repeat(81)], `--show-quote takes an idea's id (letters, digits, "-" and "_"), and "${"a".repeat(40)}..." is not one.`],
    ["--show-quote with a new line in the id", ["--filming", "--show-quote", "idea\n01"], `--show-quote takes an idea's id (letters, digits, "-" and "_"), and "idea\\n01" is not one.`],
    ["--port with nothing after it", ["--demo", "--port"], "--port needs a number from 1024 to 65535 after it."],
    ["--port followed by another switch", ["--port", "--demo"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with a word", ["--demo", "--port", "four"], "--port needs a number from 1024 to 65535 after it."],
    ["--port below 1024", ["--demo", "--port", "1023"], "--port needs a number from 1024 to 65535 after it."],
    ["--port 80", ["--demo", "--port", "80"], "--port needs a number from 1024 to 65535 after it."],
    ["--port 0", ["--demo", "--port", "0"], "--port needs a number from 1024 to 65535 after it."],
    ["--port above 65535", ["--demo", "--port", "65536"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with six digits", ["--demo", "--port", "432100"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with a zero in front", ["--demo", "--port", "04322"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with many zeros in front", ["--demo", "--port", "0000004322"], "--port needs a number from 1024 to 65535 after it."],
    ["--port 999", ["--demo", "--port", "999"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with a minus", ["--demo", "--port", "-4322"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with a fraction", ["--demo", "--port", "4322.5"], "--port needs a number from 1024 to 65535 after it."],
    ["--port in another notation", ["--demo", "--port", "0x10e2"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with a letter after the number", ["--demo", "--port", "4322a"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with a space in it", ["--demo", "--port", " 4322"], "--port needs a number from 1024 to 65535 after it."],
    ["--port with an empty word", ["--demo", "--port", ""], "--port needs a number from 1024 to 65535 after it."],
    ["--port twice", ["--demo", "--port", "4322", "--port", "4323"], "--port was given more than once."],
    ["--port twice with the same number", ["--demo", "--port", "4322", "--port", "4322"], "--port was given more than once."],
    ["--port=4322 in one word", ["--demo", "--port=4322"], 'The dashboard has no option "--port=4322"; --help lists the ones it has.'],
    ["a switch it does not have", ["--bogus"], 'The dashboard has no option "--bogus"; --help lists the ones it has.'],
    ["a switch from the overnight command", ["--json"], 'The dashboard has no option "--json"; --help lists the ones it has.'],
    ["a switch in capitals", ["--DEMO"], 'The dashboard has no option "--DEMO"; --help lists the ones it has.'],
    ["a switch with one dash", ["-demo"], 'The dashboard has no option "-demo"; --help lists the ones it has.'],
    ["two dashes alone", ["--"], 'The dashboard has no option "--"; --help lists the ones it has.'],
    ["a word that is not a switch", ["demo"], 'The dashboard has no option "demo"; --help lists the ones it has.'],
    ["an idea's id with no switch in front", ["--filming", "idea_01"], 'The dashboard has no option "idea_01"; --help lists the ones it has.'],
    ["a data folder", ["/Users/invented/.overnight"], 'The dashboard has no option "/Users/invented/.overnight"; --help lists the ones it has.'],
    ["an empty word", [""], 'The dashboard has no option ""; --help lists the ones it has.'],
    ["a very long word", [`--${"x".repeat(200)}`], `The dashboard has no option "--${"x".repeat(38)}..."; --help lists the ones it has.`],
  ];

  it.each(refusals)("%s", (_what, argv, problem) => {
    expect(parseDashboardArgs(argv)).toEqual({ ok: false, problem });
  });

  it.each(refusals)("%s: one sentence, no line break", (_what, _argv, problem) => {
    expect(problem).toMatch(/^[^\n\r]+\.$/);
    // One full stop that ends a sentence: the last character. (A port range or "..." inside quotes is not one.)
    expect(problem.replace(/"[^"]*"/g, '""').replace(/\.$/, "")).not.toMatch(/\.\s/);
  });

  it("a mistake anywhere refuses the whole line: nothing is half-accepted", () => {
    expect(parseDashboardArgs(["--demo", "--play", "--bogus"]).ok).toBe(false);
    expect(parseDashboardArgs(["--bogus", "--demo"]).ok).toBe(false);
  });
});

// `npm run dashboard --filming` (no "--" before the option): npm keeps the option, starts the
// script without it, and tells the script about it only through its environment.
describe("optionsNpmKept: an option typed before npm's two dashes", () => {
  /** What npm 11 hands a script for each of them (seen with `npm run env <option>`). */
  const NPM = { script: { npm_lifecycle_event: "dashboard" }, demoScript: { npm_lifecycle_event: "dashboard:demo" } };

  it("says nothing when npm kept nothing, whatever else is in the environment", () => {
    expect(optionsNpmKept([], {})).toBeNull();
    expect(optionsNpmKept(["--filming"], { ...NPM.script, npm_config_cache: "/invented/cache", npm_config_user_agent: "npm/11", npm_config_yes: "true" })).toBeNull();
    // "Off" is not "kept": --no-filming and --filming=false reach the script as an empty value.
    expect(optionsNpmKept([], { npm_config_filming: "", npm_config_demo: "false" })).toBeNull();
  });

  it("refuses --filming that npm kept: the dashboard would have shown every quote", () => {
    expect(optionsNpmKept([], { ...NPM.script, npm_config_filming: "true" })).toBe(
      "--filming was typed before npm's two dashes, so npm kept it and the dashboard was not started without it. Put it after the two dashes: npm run dashboard -- --filming",
    );
  });

  it("refuses --demo that npm kept: the dashboard would have opened Overnight's real data", () => {
    expect(optionsNpmKept([], { ...NPM.script, npm_config_demo: "true" })).toBe(
      "--demo was typed before npm's two dashes, so npm kept it and the dashboard was not started without it. Put it after the two dashes: npm run dashboard -- --demo",
    );
  });

  it("names every option that was kept, and the script that was run", () => {
    expect(optionsNpmKept(["--demo"], { ...NPM.demoScript, npm_config_filming: "true", npm_config_port: "true" })).toBe(
      "--filming and --port were typed before npm's two dashes, so npm kept them and the dashboard was not started without them. Put them after the two dashes: npm run dashboard:demo -- --filming --port <n>",
    );
    expect(optionsNpmKept([], { ...NPM.script, npm_config_demo: "true", npm_config_filming: "true", npm_config_show_quote: "true" })).toBe(
      "--demo, --filming and --show-quote were typed before npm's two dashes, so npm kept them and the dashboard was not started without them. Put them after the two dashes: npm run dashboard -- --demo --filming --show-quote <ideaId>",
    );
  });

  it("knows --play by what npm makes of it: four of npm's own one-letter switches, and no trace of the word", () => {
    const asNpmReadsIt = { npm_config_parseable: "true", npm_config_long: "true", npm_config_all: "true", npm_config_yes: "true" };
    expect(optionsNpmKept(["--demo"], { ...NPM.demoScript, ...asNpmReadsIt })).toBe(
      "--play was typed before npm's two dashes, so npm kept it and the dashboard was not started without it. Put it after the two dashes: npm run dashboard:demo -- --play",
    );
    expect(optionsNpmKept(["--demo"], { npm_config_play: "true" })).toContain("--play was typed before");
    // Three of the four are somebody's own npm settings, not our option.
    expect(optionsNpmKept(["--demo"], { ...asNpmReadsIt, npm_config_long: undefined })).toBeNull();
    expect(optionsNpmKept(["--demo", "--play"], asNpmReadsIt)).toBeNull();
  });

  it("is content when the option was also given properly", () => {
    expect(optionsNpmKept(["--filming"], { npm_config_filming: "true" })).toBeNull();
    expect(optionsNpmKept(["--demo", "--port", "4322"], { npm_config_demo: "true", npm_config_port: "4322" })).toBeNull();
    expect(optionsNpmKept(["--filming", "--show-quote", "idea_01"], { npm_config_show_quote: "idea_01" })).toBeNull();
  });

  it("never prints back a value or a script name it was handed", () => {
    const sentence = optionsNpmKept([], { npm_lifecycle_event: "dashboard; rm -rf /invented", npm_config_port: "<b>4400</b>", npm_config_show_quote: "/Users/invented/.overnight" }) ?? "";
    expect(sentence).toBe(
      "--show-quote and --port were typed before npm's two dashes, so npm kept them and the dashboard was not started without them. Put them after the two dashes: npm run dashboard -- --show-quote <ideaId> --port <n>",
    );
    expect(optionsNpmKept([], { npm_lifecycle_event: "dashboard:filming", npm_config_demo: "true" })).toContain("npm run dashboard:filming -- --demo");
    expect(sentence).not.toMatch(/[\n\r]/);
  });

  it("is in the help text: the options go after the two dashes", () => {
    expect(DASHBOARD_USAGE).toContain("The options go after the two dashes.");
  });
});
