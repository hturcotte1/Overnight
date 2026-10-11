// All text in this file is made up for the tests. None of it is Bee data.
// Kiro is always a fake here: these tests start no process and touch no network.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, dataPaths } from "@overnight/core";
import type { DataPaths, DetectorInput } from "@overnight/core";
import { createKiroDetector, PRIVACY_SETTINGS, SIGNED_OUT_MESSAGE } from "../src/index.ts";
import type { KiroRunOptions, KiroRunner, KiroRunResult } from "../src/index.ts";

const INPUT: DetectorInput = {
  utterances: [
    { text: "We always forget whose turn it is to pick the board game.", spokenAt: "2026-03-01T19:00:02.000Z" },
    { text: "Someone should build a little page that just picks the next person.", spokenAt: "2026-03-01T19:00:09.000Z" },
    { text: "Yeah, and it remembers who went last.", spokenAt: "2026-03-01T19:00:15.000Z" },
  ],
  recentTitles: ["Plant watering tracker"],
};

const VERDICT = {
  is_idea: true,
  confidence: 0.9,
  title: "Game night picker",
  pitch: "Picks whose turn it is to choose the board game and remembers who went last.",
  quote: "Someone should build a little page that just picks the next person.",
  said_by_wearer_guess: true,
  likely_media: false,
  buildable_as_static_web_app: true,
  reason: "A sincere wish for a small tool that one web page can do.",
};
const GOOD_REPLY = JSON.stringify(VERDICT);
// A reply that breaks the rules and also repeats the conversation, to prove none of it leaks.
const BAD_REPLY = `The board game talk is an idea. ${JSON.stringify({ ...VERDICT, title: "A page that picks whose turn it is for the board game" })}`;
const SPOKEN_WORDS = ["board game", "picks the next person", "went last"];

type Reply = string | Partial<KiroRunResult> | Error;
type Call = { args: string[]; options: KiroRunOptions };

const done = (stdout: string): KiroRunResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false });

// What the real `kiro-cli whoami` prints, with an invented address that must never leave the detector.
const ACCOUNT_EMAIL = "invented.person@example.test";
const SIGNED_IN = `Logged in with GitHub\nEmail: ${ACCOUNT_EMAIL}\n`;
const SIGNED_OUT: Partial<KiroRunResult> = { stdout: "Not logged in\n", exitCode: 1 };

/** A stand-in for kiro-cli: it remembers settings like the real one, answers whoami, and plays back chat replies. */
function fakeKiro(options: { settings?: Record<string, string>; ignoreSets?: boolean; settingsFail?: Partial<KiroRunResult>; whoami?: Partial<KiroRunResult>; replies?: Reply[] } = {}) {
  const calls: Call[] = [];
  const settings = new Map(Object.entries(options.settings ?? {}));
  const replies = [...(options.replies ?? [])];
  const state = { whoami: options.whoami ?? { stdout: SIGNED_IN } };
  const run: KiroRunner = async (args, runOptions) => {
    calls.push({ args, options: runOptions });
    if (args[0] === "whoami") return { ...done(""), ...state.whoami };
    if (args[0] === "settings") {
      if (options.settingsFail) return { ...done(""), ...options.settingsFail };
      const key = args[1]!;
      if (args.length === 3) {
        if (!options.ignoreSets) settings.set(key, args[2]!);
        return done("");
      }
      const value = settings.get(key);
      return value === undefined ? { stdout: "", stderr: `error: No value associated with ${key}\n`, exitCode: 1, timedOut: false } : done(`${value} (global)\n`);
    }
    const next = replies.shift();
    if (next === undefined) throw new Error("the fake has no reply left");
    if (next instanceof Error) throw next;
    return typeof next === "string" ? done(next) : { ...done(""), ...next };
  };
  const chats = () => calls.filter((call) => call.args[0] === "chat");
  /** What each chat was given on standard input: the prompt. */
  const prompts = () => chats().map((call) => call.options.stdin ?? "");
  const whoamiCalls = () => calls.filter((call) => call.args[0] === "whoami");
  const settingsCalls = () => calls.filter((call) => call.args[0] === "settings").map((call) => call.args.slice(1).join(" "));
  return {
    run,
    calls,
    chats,
    prompts,
    whoamiCalls,
    settingsCalls,
    signOut: () => void (state.whoami = SIGNED_OUT),
    signIn: () => void (state.whoami = { stdout: SIGNED_IN }),
  };
}

const ALL_OFF = Object.fromEntries(PRIVACY_SETTINGS.map((key) => [key, "false"]));
/** Everything a chat is started with. The prompt is not among it. */
const CHAT_ARGS = ["chat", "--no-interactive", "--agent", "overnight-detector", "--model", "claude-haiku-4.5"];

let dir: string;
let paths: DataPaths;
let logLines: string[];
const logger = () => createLogger({ name: "test", minLevel: "debug", write: (line) => logLines.push(line) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "overnight-detector-test-"));
  paths = dataPaths(dir);
  logLines = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function readyDetector(replies: Reply[], extra: { timeoutMs?: number; model?: string; now?: () => number } = {}) {
  const kiro = fakeKiro({ settings: ALL_OFF, replies });
  const detector = createKiroDetector({ paths, run: kiro.run, logger: logger(), ...extra });
  await detector.ensureSetup();
  return { detector, kiro };
}

const sessionsDir = () => path.join(paths.detectorKiroHome, "sessions", "cli");
const HOUR_MS = 60 * 60 * 1000;

/** A saved-chat file like the ones Kiro leaves behind, last written `ageMs` ago. */
function savedChat(name: string, ageMs: number, nowMs: number = Date.now()): string {
  mkdirSync(sessionsDir(), { recursive: true });
  const file = path.join(sessionsDir(), name);
  writeFileSync(file, "an invented saved chat");
  const when = new Date(nowMs - ageMs);
  utimesSync(file, when, when);
  return file;
}

function expectNoSpokenWords(text: string): void {
  for (const words of SPOKEN_WORDS) expect(text).not.toContain(words);
}

describe("ensureSetup", () => {
  it("creates the folders and installs the agent with no tools", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF });
    await createKiroDetector({ paths, run: kiro.run }).ensureSetup();

    expect(existsSync(paths.detectorCwd)).toBe(true);
    const agent = JSON.parse(readFileSync(path.join(paths.detectorKiroHome, "agents", "overnight-detector.json"), "utf8"));
    expect(agent).toMatchObject({ name: "overnight-detector", tools: [], allowedTools: [], resources: [], mcpServers: {} });
  });

  it("only reads the two privacy settings when both are already off", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF });
    await createKiroDetector({ paths, run: kiro.run }).ensureSetup();

    expect(kiro.settingsCalls()).toEqual(["codeWhisperer.shareCodeWhispererContentWithAWS", "telemetry.enabled"]);
    for (const call of kiro.calls) expect(call.options).toMatchObject({ cwd: paths.detectorCwd, kiroHome: paths.detectorKiroHome });
  });

  it("switches each setting off when it is on or was never set, then checks again", async () => {
    const kiro = fakeKiro({ settings: { "telemetry.enabled": "true" } });
    await createKiroDetector({ paths, run: kiro.run }).ensureSetup();

    expect(kiro.settingsCalls()).toEqual([
      "codeWhisperer.shareCodeWhispererContentWithAWS",
      "codeWhisperer.shareCodeWhispererContentWithAWS false",
      "codeWhisperer.shareCodeWhispererContentWithAWS",
      "telemetry.enabled",
      "telemetry.enabled false",
      "telemetry.enabled",
    ]);
  });

  it("refuses when a setting will not go off, and detect() keeps refusing", async () => {
    const kiro = fakeKiro({ settings: { ...ALL_OFF, "telemetry.enabled": "true" }, ignoreSets: true, replies: [GOOD_REPLY] });
    const detector = createKiroDetector({ paths, run: kiro.run });

    await expect(detector.ensureSetup()).rejects.toThrow('Kiro\'s "telemetry.enabled" setting is not off and could not be switched off, so real text will not be sent to Kiro.');
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 0 });
    expect(kiro.chats()).toHaveLength(0);
  });

  it("refuses when kiro-cli cannot be run to check", async () => {
    for (const settingsFail of [{ error: "kiro-cli was not found" }, { timedOut: true, exitCode: null }]) {
      const kiro = fakeKiro({ settingsFail });
      await expect(createKiroDetector({ paths, run: kiro.run }).ensureSetup()).rejects.toThrow("real text will not be sent to Kiro");
    }
  });

  it("does not take anything but a plain false for off", async () => {
    for (const value of ["False", "0", "falsey", "null", "true"]) {
      const kiro = fakeKiro({ settings: { ...ALL_OFF, "telemetry.enabled": value }, ignoreSets: true });
      await expect(createKiroDetector({ paths, run: kiro.run }).ensureSetup()).rejects.toThrow("telemetry.enabled");
    }
  });

  it("refuses when the working folder is not empty", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF });
    const detector = createKiroDetector({ paths, run: kiro.run });
    await detector.ensureSetup();
    writeFileSync(path.join(paths.detectorCwd, "notes.md"), "left here by mistake");

    await expect(detector.ensureSetup()).rejects.toThrow("working folder is not empty");
    // A setup that fails later takes back the earlier yes.
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 0 });
  });

  it("is shared by two callers at once, and costs no kiro-cli call once it has succeeded", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF });
    const detector = createKiroDetector({ paths, run: kiro.run });
    await Promise.all([detector.ensureSetup(), detector.ensureSetup()]);
    expect(kiro.settingsCalls()).toHaveLength(2);
    expect(kiro.whoamiCalls()).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) await detector.ensureSetup();
    expect(kiro.calls).toHaveLength(3);
  });

  it("sets up again from scratch when the installed agent file has been changed", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF });
    const detector = createKiroDetector({ paths, run: kiro.run });
    await detector.ensureSetup();
    const installed = path.join(paths.detectorKiroHome, "agents", "overnight-detector.json");
    writeFileSync(installed, JSON.stringify({ name: "overnight-detector", tools: ["fs_read"] }));

    await detector.ensureSetup();
    expect(JSON.parse(readFileSync(installed, "utf8"))).toMatchObject({ tools: [], allowedTools: [] });
    expect(kiro.calls).toHaveLength(6);
  });

  it("checks that Kiro is signed in, after the privacy settings, with a 20 second limit", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF });
    await createKiroDetector({ paths, run: kiro.run }).ensureSetup();

    expect(kiro.calls.map((call) => call.args[0])).toEqual(["settings", "settings", "whoami"]);
    expect(kiro.whoamiCalls()[0]).toEqual({ args: ["whoami"], options: { cwd: paths.detectorCwd, kiroHome: paths.detectorKiroHome, timeoutMs: 20_000 } });
  });

  it("refuses when Kiro is signed out, and says how to fix it", async () => {
    const signedOutAnswers: Partial<KiroRunResult>[] = [
      { stdout: "Not logged in\n", exitCode: 1 },
      { stdout: "Not logged in\n" },
      { stderr: "error: NOT LOGGED IN, please run kiro-cli login\n" },
      { stdout: "", exitCode: 1 },
    ];
    for (const whoami of signedOutAnswers) {
      const kiro = fakeKiro({ settings: ALL_OFF, whoami, replies: [GOOD_REPLY] });
      const detector = createKiroDetector({ paths, run: kiro.run });

      const refusal = await detector.ensureSetup().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toBe(SIGNED_OUT_MESSAGE);
      expect(SIGNED_OUT_MESSAGE).toContain("Kiro is signed out on this Mac");
      expect(SIGNED_OUT_MESSAGE).toContain("run: kiro-cli login");

      const result = await detector.detect(INPUT);
      expect(result).toMatchObject({ ok: false, attempts: 0, retryLater: true });
      expect(result.ok === false && result.reason).toContain("Kiro is signed out on this Mac");
      expect(kiro.chats()).toHaveLength(0);
    }
  });

  it("refuses when it cannot find out whether Kiro is signed in", async () => {
    for (const whoami of [{ timedOut: true, exitCode: null }, { exitCode: null }, { exitCode: null, error: "could not start kiro-cli (EACCES)" }]) {
      const kiro = fakeKiro({ settings: ALL_OFF, whoami });
      await expect(createKiroDetector({ paths, run: kiro.run }).ensureSetup()).rejects.toThrow("Could not check that Kiro is signed in");
    }
  });

  it("can be tried again and again until Kiro is signed in", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF, whoami: SIGNED_OUT, replies: [GOOD_REPLY] });
    const detector = createKiroDetector({ paths, run: kiro.run });
    for (let i = 0; i < 3; i += 1) await expect(detector.ensureSetup()).rejects.toThrow("Kiro is signed out");
    expect(kiro.whoamiCalls()).toHaveLength(3);

    kiro.signIn();
    await detector.ensureSetup();
    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, attempts: 1 });
  });

  it("never lets the account's email address out: not in a log, an error or a result", async () => {
    const leaky = { stdout: `Not logged in as ${ACCOUNT_EMAIL}\n`, stderr: `${ACCOUNT_EMAIL}\n`, exitCode: 1 };
    const kiro = fakeKiro({ settings: ALL_OFF, replies: [{ exitCode: 1 }, GOOD_REPLY] });
    const detector = createKiroDetector({ paths, run: kiro.run, logger: logger() });
    await detector.ensureSetup();
    const worked = await detector.detect(INPUT);

    const signedOutKiro = fakeKiro({ settings: ALL_OFF, whoami: leaky });
    const refused = createKiroDetector({ paths, run: signedOutKiro.run, logger: logger() });
    const refusal = await refused.ensureSetup().catch((error: unknown) => error);
    const waiting = await refused.detect(INPUT);

    expect(worked.ok).toBe(true);
    expect(kiro.whoamiCalls().length).toBeGreaterThanOrEqual(2);
    for (const text of [JSON.stringify(worked), JSON.stringify(waiting), String(refusal), (refusal as Error).stack ?? "", ...logLines]) {
      expect(text).not.toContain(ACCOUNT_EMAIL);
      expect(text).not.toContain("example.test");
    }
  });

  it("deletes Kiro's saved chats that are more than a day old, and nothing else", async () => {
    const old = [savedChat("old-chat.json", 25 * HOUR_MS), savedChat("old-chat.jsonl", 25 * HOUR_MS)];
    const recent = [savedChat("recent-chat.json", 23 * HOUR_MS), savedChat("recent-chat.jsonl", 60_000)];
    mkdirSync(path.join(sessionsDir(), "a-folder"));
    const elsewhere = path.join(paths.detectorKiroHome, "settings");
    mkdirSync(elsewhere, { recursive: true });
    const settingsFile = path.join(elsewhere, "cli.json");
    writeFileSync(settingsFile, "{}");
    utimesSync(settingsFile, new Date(0), new Date(0));

    const kiro = fakeKiro({ settings: ALL_OFF });
    await createKiroDetector({ paths, run: kiro.run, logger: logger() }).ensureSetup();

    expect(old.map((file) => existsSync(file))).toEqual([false, false]);
    expect(recent.map((file) => existsSync(file))).toEqual([true, true]);
    expect(readdirSync(sessionsDir()).sort()).toEqual(["a-folder", "recent-chat.json", "recent-chat.jsonl"]);
    expect(existsSync(settingsFile)).toBe(true);
    expect(logLines.some((line) => line.includes("removed old saved Kiro chats") && line.includes('"files":2'))).toBe(true);
  });

  it("deletes nothing when the Kiro folder is not inside the data folder", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "overnight-detector-outside-"));
    try {
      paths = { ...paths, detectorKiroHome: path.join(outside, "kiro-home") };
      const old = savedChat("old-chat.json", 48 * HOUR_MS);
      await createKiroDetector({ paths, run: fakeKiro({ settings: ALL_OFF }).run }).ensureSetup();
      expect(existsSync(old)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("detect", () => {
  it("refuses before ensureSetup, without calling Kiro", async () => {
    const kiro = fakeKiro({ settings: ALL_OFF, replies: [GOOD_REPLY] });
    const detector = createKiroDetector({ paths, run: kiro.run });

    const result = await detector.detect(INPUT);
    expect(result).toMatchObject({ ok: false, attempts: 0, retryLater: true });
    expect(result.ok === false && result.reason).toContain("not set up");
    expect(kiro.calls).toHaveLength(0);
  });

  it("runs the no-tools agent from the detector's own folders and returns the verdict", async () => {
    const { detector, kiro } = await readyDetector([GOOD_REPLY]);

    const result = await detector.detect(INPUT);
    expect(result).toMatchObject({ ok: true, verdict: VERDICT, attempts: 1 });
    expect(result.ms).toBeGreaterThanOrEqual(0);

    const [chat] = kiro.chats();
    expect(chat!.args).toEqual(CHAT_ARGS);
    // The prompt goes in on standard input.
    expect(chat!.options).toEqual({ cwd: paths.detectorCwd, kiroHome: paths.detectorKiroHome, timeoutMs: 90_000, stdin: expect.any(String) });
    expect(chat!.options.stdin).toContain("[19:00:09] Someone should build a little page that just picks the next person.");
    expect(chat!.options.stdin).toContain("- Plant watering tracker");
  });

  it("never puts the conversation, or any other part of the prompt, into kiro-cli's arguments", async () => {
    // Any program on the Mac can read another program's arguments, so nothing that was said may be
    // in them: not on the first try, not on the retry, and not when a chat fails.
    const { detector, kiro } = await readyDetector([BAD_REPLY, GOOD_REPLY, { exitCode: 1 }, { timedOut: true, exitCode: null }]);
    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, attempts: 2 });
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 2 });

    expect(kiro.chats()).toHaveLength(4);
    for (const chat of kiro.chats()) {
      expect(chat.args).toEqual(CHAT_ARGS);
      // The whole prompt is on standard input instead.
      for (const utterance of INPUT.utterances) expect(chat.options.stdin).toContain(utterance.text);
    }
    // Every word that was said, every recent title, and the prompt's own wording: in no argument of any call.
    const said = [...INPUT.utterances.map((utterance) => utterance.text), ...INPUT.recentTitles].flatMap((text) => text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    expect(said.length).toBeGreaterThan(20);
    const allArguments = kiro.calls.flatMap((call) => call.args).join("\n").toLowerCase();
    for (const word of [...said, "transcript", "wearable", "previous reply", "json", "19:00"]) expect(allArguments).not.toContain(word);
    // Only chats are given anything to read.
    for (const call of kiro.calls.filter((other) => other.args[0] !== "chat")) expect(call.options).not.toHaveProperty("stdin");
  });

  it("uses the model and timeout it was given", async () => {
    const { detector, kiro } = await readyDetector([GOOD_REPLY], { model: "claude-sonnet-4.5", timeoutMs: 5_000 });
    await detector.detect(INPUT);
    expect(kiro.chats()[0]!.args[5]).toBe("claude-sonnet-4.5");
    expect(kiro.chats()[0]!.options.timeoutMs).toBe(5_000);
  });

  it("rejects a model name that could be read as a flag", () => {
    expect(() => createKiroDetector({ paths, model: "--trust-all-tools" })).toThrow("model");
    expect(() => createKiroDetector({ paths, timeoutMs: 0 })).toThrow("timeoutMs");
  });

  it("tries once more after a bad reply, and says what was wrong", async () => {
    const { detector, kiro } = await readyDetector([BAD_REPLY, GOOD_REPLY]);

    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, verdict: VERDICT, attempts: 2 });
    const [first, second] = kiro.prompts();
    expect(first).not.toContain("Your previous reply could not be used");
    expect(second!.startsWith(first!)).toBe(true);
    expect(second).toContain("Your previous reply could not be used: title is longer than 6 words (it has 12).");
  });

  it("cuts a quote that is word for word but too long to its first 25 words at once, without a second call", async () => {
    const sentence = "I want a little page where I type in the room, the wall sizes and the number of coats, and it tells me how many cans of paint to buy for the job.";
    const input: DetectorInput = { utterances: [{ text: sentence, spokenAt: "2026-03-01T10:00:05.000Z" }], recentTitles: [] };
    const longReply = JSON.stringify({ ...VERDICT, title: "Paint can calculator", quote: sentence });
    const { detector, kiro } = await readyDetector([longReply, GOOD_REPLY]);

    const result = await detector.detect(input);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(result.ok && result.verdict.quote).toBe("I want a little page where I type in the room, the wall sizes and the number of coats, and it tells me how many");
    expect(kiro.chats()).toHaveLength(1);
    expect(logLines.some((line) => line.includes('"quoteCut":true'))).toBe(true);
  });

  it("still spends its one retry on a long quote that was never said", async () => {
    const invented = Array.from({ length: 30 }, (_, i) => `made${i}`).join(" ");
    const { detector, kiro } = await readyDetector([JSON.stringify({ ...VERDICT, quote: invented }), GOOD_REPLY]);

    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, verdict: VERDICT, attempts: 2 });
    expect(kiro.prompts()[1]).toContain(
      "Your previous reply could not be used: quote is longer than 25 words (it has 30); quote is not copied word for word from the conversation.",
    );
  });

  it("gives up after two bad replies, with a reason in our own words", async () => {
    const { detector, kiro } = await readyDetector([BAD_REPLY, "I would rather talk about the board game."]);

    const result = await detector.detect(INPUT);
    expect(result).toMatchObject({ ok: false, attempts: 2, reason: "the model's reply could not be used: no JSON object in the reply (after 2 attempts)" });
    expect(kiro.chats()).toHaveLength(2);
  });

  it("comes back with ok false when Kiro times out, after one more try", async () => {
    const { detector, kiro } = await readyDetector([
      { timedOut: true, exitCode: null },
      { timedOut: true, exitCode: null },
    ]);

    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 2, reason: "kiro-cli did not answer within 90 s (after 2 attempts)" });
    // The second try is the plain prompt again: there was no reply to correct.
    expect(kiro.prompts()[1]).toBe(kiro.prompts()[0]);
    expect(kiro.prompts()[0]).toContain("picks the next person");
  });

  it("recovers when only the first try times out", async () => {
    const { detector } = await readyDetector([{ timedOut: true, exitCode: null }, GOOD_REPLY]);
    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, attempts: 2 });
  });

  it("does not trust a reply from a run that exited with an error", async () => {
    const { detector } = await readyDetector([
      { stdout: GOOD_REPLY, exitCode: 4 },
      { stdout: GOOD_REPLY, exitCode: 4 },
    ]);
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 2, reason: "kiro-cli exited with code 4 (after 2 attempts)" });
  });

  it("does not retry when kiro-cli cannot start", async () => {
    const { detector, kiro } = await readyDetector([{ exitCode: null, error: "could not start kiro-cli (EACCES)" }, GOOD_REPLY]);

    const result = await detector.detect(INPUT);
    expect(result).toMatchObject({ ok: false, attempts: 1, reason: "could not start kiro-cli (EACCES)" });
    expect(result).not.toHaveProperty("retryLater");
    expect(kiro.chats()).toHaveLength(1);
  });

  it("says to ask again later when kiro-cli is missing or this process is stopping, and starts no second chat", async () => {
    const notTried: Partial<KiroRunResult>[] = [
      { exitCode: null, error: "kiro-cli was not found (looked in two places)", unavailable: "missing" },
      { exitCode: null, error: "kiro-cli was not started: this process is stopping", unavailable: "stopping" },
      { exitCode: null, error: "kiro-cli was stopped: this process is stopping", unavailable: "stopping" },
    ];
    for (const reply of notTried) {
      const { detector, kiro } = await readyDetector([reply, GOOD_REPLY]);
      expect(await detector.detect(INPUT)).toEqual({ ok: false, reason: reply.error, ms: expect.any(Number), attempts: 1, retryLater: true });
      expect(kiro.chats()).toHaveLength(1);
    }
  });

  it("does not start a second chat when the first was killed before it answered", async () => {
    // What the runner hands back when something other than our timeout killed kiro-cli.
    const { detector, kiro } = await readyDetector([{ exitCode: null }, GOOD_REPLY]);

    const result = await detector.detect(INPUT);
    expect(result).toMatchObject({ ok: false, attempts: 1, reason: "kiro-cli was stopped before it answered" });
    expect(result).not.toHaveProperty("retryLater");
    expect(kiro.chats()).toHaveLength(1);
  });

  it("counts a bad reply, a timeout or an error exit as a real failure, not as ask-again-later", async () => {
    const realFailures: Reply[][] = [
      [BAD_REPLY, BAD_REPLY],
      [
        { timedOut: true, exitCode: null },
        { timedOut: true, exitCode: null },
      ],
      [{ exitCode: 4 }, { exitCode: 4 }],
    ];
    for (const replies of realFailures) {
      const { detector, kiro } = await readyDetector(replies);
      const result = await detector.detect(INPUT);
      expect(result).toMatchObject({ ok: false, attempts: 2 });
      expect(result).not.toHaveProperty("retryLater");
      expect(kiro.chats()).toHaveLength(2);
    }
  });

  it("asks who is signed in once after an error exit or a timeout, and carries on when Kiro is signed in", async () => {
    for (const failure of [{ exitCode: 1 }, { timedOut: true, exitCode: null }]) {
      const { detector, kiro } = await readyDetector([failure, failure]);
      expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 2 });
      // One at set-up, one after the first failed chat; not another after the second.
      expect(kiro.whoamiCalls()).toHaveLength(2);
    }
  });

  it("also notices a signed-out Kiro when the chat hangs instead of failing", async () => {
    const { detector, kiro } = await readyDetector([{ timedOut: true, exitCode: null }, GOOD_REPLY]);
    kiro.signOut();
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, reason: SIGNED_OUT_MESSAGE, attempts: 1, retryLater: true });
    expect(kiro.chats()).toHaveLength(1);
  });

  it("notices Kiro being signed out mid-run, waits without chatting, and picks up again after a sign-in", async () => {
    let clock = 1_000_000;
    const { detector, kiro } = await readyDetector([{ exitCode: 1, stderr: "error: not authenticated" }, GOOD_REPLY], { now: () => clock });
    kiro.signOut();

    // The chat fails, whoami says why: ask again later, and do not try the chat a second time.
    expect(await detector.detect(INPUT)).toEqual({ ok: false, reason: SIGNED_OUT_MESSAGE, ms: expect.any(Number), attempts: 1, retryLater: true });
    expect(kiro.chats()).toHaveLength(1);
    expect(kiro.whoamiCalls()).toHaveLength(2);

    // Asked again straight away: nothing is started at all.
    clock += 5_000;
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, reason: SIGNED_OUT_MESSAGE, attempts: 0, retryLater: true });
    expect(kiro.calls.filter((call) => call.args[0] !== "settings")).toHaveLength(3);

    // Half a minute on it looks again, with whoami only.
    clock += 30_000;
    expect(await detector.detect(INPUT)).toMatchObject({ ok: false, attempts: 0, retryLater: true });
    expect(kiro.whoamiCalls()).toHaveLength(3);
    expect(kiro.chats()).toHaveLength(1);

    kiro.signIn();
    clock += 30_000;
    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, verdict: VERDICT, attempts: 1 });
    expect(kiro.chats()).toHaveLength(2);

    // The warning is logged when the waiting starts, not on every pass.
    const warnings = logLines.filter((line) => line.includes('"level":"warn"') && line.includes("detector cannot run yet"));
    expect(warnings).toHaveLength(1);
  });

  it("goes back through a full set-up when ensureSetup is called while Kiro is signed out", async () => {
    const { detector, kiro } = await readyDetector([{ exitCode: 1 }, GOOD_REPLY]);
    kiro.signOut();
    await detector.detect(INPUT);

    await expect(detector.ensureSetup()).rejects.toThrow("Kiro is signed out");
    kiro.signIn();
    await detector.ensureSetup();
    expect(await detector.detect(INPUT)).toMatchObject({ ok: true, attempts: 1 });
  });

  it("clears out old saved chats after a chat, at most once an hour", async () => {
    let clock = Date.now();
    const { detector } = await readyDetector([GOOD_REPLY, GOOD_REPLY, GOOD_REPLY], { now: () => clock });
    const age = 25 * HOUR_MS;

    // Set-up has just cleared the folder, so a chat a minute later leaves it alone.
    const first = savedChat("first.json", age, clock);
    clock += 60_000;
    await detector.detect(INPUT);
    expect(existsSync(first)).toBe(true);

    clock += 59 * 60_000;
    await detector.detect(INPUT);
    expect(existsSync(first)).toBe(false);

    const second = savedChat("second.json", age, clock);
    clock += 30 * 60_000;
    await detector.detect(INPUT);
    expect(existsSync(second)).toBe(true);
  });

  it("never throws, even if the runner does, and keeps the error's text out of the reason", async () => {
    const { detector } = await readyDetector([new TypeError("could not send: We always forget whose turn it is to pick the board game.")]);

    const result = await detector.detect(INPUT);
    expect(result).toMatchObject({ ok: false, attempts: 1, reason: "the detector failed unexpectedly (TypeError)" });
  });

  it("does not call Kiro when there is nothing to classify", async () => {
    const { detector, kiro } = await readyDetector([GOOD_REPLY]);
    expect(await detector.detect({ utterances: [{ text: "  ", spokenAt: "2026-03-01T19:00:02.000Z" }], recentTitles: [] })).toMatchObject({ ok: false, attempts: 0 });
    expect(kiro.chats()).toHaveLength(0);
  });

  it("never puts what was said into a reason or a log line", async () => {
    const { detector } = await readyDetector([BAD_REPLY, BAD_REPLY, BAD_REPLY, GOOD_REPLY, { stdout: BAD_REPLY, stderr: BAD_REPLY, exitCode: 1 }, { stdout: BAD_REPLY, stderr: BAD_REPLY, exitCode: 1 }]);

    const failed = await detector.detect(INPUT);
    const worked = await detector.detect(INPUT);
    const crashed = await detector.detect(INPUT);
    expect([failed.ok, worked.ok, crashed.ok]).toEqual([false, true, false]);
    for (const result of [failed, crashed]) expectNoSpokenWords(result.ok ? "" : result.reason);

    expect(logLines.length).toBeGreaterThanOrEqual(4);
    for (const line of logLines) {
      expectNoSpokenWords(line);
      expect(line).not.toContain(VERDICT.title);
    }
  });
});
