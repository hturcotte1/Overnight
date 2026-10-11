// All text this spike sends to Kiro is synthetic: invented for the spike. None of it is Bee data.
//
// Spike 9: does `kiro-cli chat --no-interactive`, with the no-tools overnight-detector agent, read
// its prompt from standard input when no prompt argument is given?
//
// Why it matters: any program on a Mac can read any other program's arguments (`ps` prints them).
// The detector used to hand the conversation to kiro-cli as the last argument, so for the few
// seconds a detection ran, what was just said could be read by anyone looking at the process list.
//
// Usage: OVERNIGHT_DATA_DIR=<a scratch folder> node spikes/09-kiro-stdin-prompt.ts [try ...]
//   stdin     a short prompt of several lines on standard input, no prompt argument (the default)
//   long      the same, with about 2,500 invented words in the middle (a full-size detector prompt)
//   unicode   the short prompt with accented letters, Japanese and an emoji in it
//   empty     standard input that closes with nothing on it, and no prompt argument
//   argument  the old way, as a control: the prompt as the last argument
// Like the other spikes, it keeps its files in <data folder>/spikes/ (~/.overnight/spikes/ when
// OVERNIGHT_DATA_DIR is not set). Its own folders there are 09-kiro-home and 09-empty-cwd.
//
// Set-up is the detector's own ensureSetup() (its no-tools agent, an empty working folder, its own
// KIRO_HOME, both content-sharing settings checked off, sign-in checked), pointed at folders of the
// spike's own. Each try that reaches the model costs about 0.01 Kiro credits. The empty try never
// reaches the model and costs nothing.
//
// Result on 2026-10-10 with Kiro CLI 2.29.0: yes. Standard input was read whole as one prompt
// (several lines; 13.8 KB; non-ASCII letters), the code word was in no process's arguments or
// environment, the argument control was seen in two processes' arguments, and empty standard
// input exits with code 1 without reaching the model.
//
// While kiro-cli runs, the spike reads the process list every 50 ms and looks for the prompt's
// code word in the arguments, and in the environment, of every process on the Mac. It prints
// counts and yes/no only: never a command line, because those hold folder names.
//
// Afterwards it reads the copy of the chat that Kiro saved in the spike's KIRO_HOME, for three
// numbers: how long a prompt Kiro says it got, how many tools ran, and what the chat cost.
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataPaths } from "@overnight/core";
import { AGENT_NAME, createKiroDetector, DEFAULT_MODEL, findKiroBinary } from "../packages/detector/src/index.ts";
import { stripAnsi } from "./lib/kiro.ts";
import { spikeDataDir } from "./lib/util.ts";

const TRIES = ["stdin", "long", "unicode", "empty", "argument"] as const;
type Try = (typeof TRIES)[number];

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!TRIES.includes(name as Try)) {
    console.error(`Unknown try "${name}". Choose from: ${TRIES.join(", ")}`);
    process.exit(2);
  }
}
const tries = (wanted.length > 0 ? wanted : ["stdin"]) as Try[];

const TIMEOUT_MS = 90_000;
const SAMPLE_EVERY_MS = 50;
/** Put into Kiro's environment so the spike can prove it is able to read a process's environment at all. */
const ENV_CONTROL = "OVERNIGHT_SPIKE_ENV_CONTROL=readable";

const binary = findKiroBinary();
if (!binary) {
  console.error("kiro-cli was not found.");
  process.exit(2);
}

// The detector's own set-up, in the spike's own folders.
const root = spikeDataDir();
const kiroHome = path.join(root, "09-kiro-home");
const cwd = path.join(root, "09-empty-cwd");
// The detector only clears old saved chats from a Kiro folder that is inside `root`.
const paths = { ...dataPaths(root), detectorKiroHome: kiroHome, detectorCwd: cwd };
try {
  await createKiroDetector({ paths }).ensureSetup();
} catch (error) {
  console.error(`Set-up refused: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(2);
}

/** An invented conversation line. Every word is from a fixed list; nobody said any of it. */
function fillerLines(words: number): string[] {
  const stock = ["the", "kettle", "is", "on", "again", "and", "nobody", "has", "fed", "the", "cat", "since", "lunch", "so", "that", "is", "next"];
  const lines: string[] = [];
  for (let done = 0, line = 0; done < words; done += stock.length, line += 1) {
    const clock = `${String(10 + Math.floor(line / 60) % 12).padStart(2, "0")}:${String(line % 60).padStart(2, "0")}:00`;
    lines.push(`[${clock}] ${stock.map((word, i) => (i === line % stock.length ? `${word}${line}` : word)).join(" ")}`);
  }
  return lines;
}

/** The answer needs the second line and the last-but-one, so a right answer means every line arrived as one prompt. */
function buildPrompt(codeWord: string, fillerWords: number, accentWord: string | null): string {
  return [
    "This text is synthetic. It was invented for a test and nobody said it.",
    "The first number is 17.",
    ...fillerLines(fillerWords),
    `The code word is ${codeWord}.`,
    ...(accentWord === null ? [] : [`The accent word is ${accentWord}.`]),
    "The second number is 26.",
    accentWord === null
      ? 'Reply with exactly one JSON object and nothing else, with no code fences: {"sum": <the first number plus the second number>, "code_word": "<the code word>"}'
      : 'Reply with exactly one JSON object and nothing else, with no code fences: {"sum": <the first number plus the second number>, "code_word": "<the code word>", "accent_word": "<the accent word, copied exactly>"}',
  ].join("\n");
}

/** Letters outside plain ASCII, to see that they survive the trip through standard input. */
const ACCENT_WORD = "crème-brûlée-señor-日本語-🙂";

function ps(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("/bin/ps", args, { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }, (_error, stdout) => resolve(stdout));
  });
}

interface Watch {
  samples: number;
  /** Processes in Kiro's own process group, by program name, with the most arguments each was seen with. */
  programs: Map<string, number>;
  codeWordInArguments: boolean;
  codeWordInEnvironment: boolean;
  /** True once the control variable was seen, which proves environments can be read. */
  environmentReadable: boolean;
}

/** One look at every process on the Mac. `-ww` stops ps from cutting long command lines short. */
async function sample(watch: Watch, groupId: number, codeWord: string): Promise<void> {
  const [withArguments, withEnvironment] = await Promise.all([
    ps(["-axww", "-o", "pid=,pgid=,command="]),
    // -E adds each process's environment after its arguments (for this user's own processes).
    ps(["-axEww", "-o", "pid=,pgid=,command="]),
  ]);
  watch.samples += 1;
  const rowPattern = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
  const commandOf = new Map<string, string>();
  for (const row of withArguments.split("\n")) {
    const match = rowPattern.exec(row);
    if (!match) continue;
    const command = match[3]!;
    commandOf.set(match[1]!, command);
    if (command.includes(codeWord)) watch.codeWordInArguments = true;
    if (Number(match[2]) !== groupId) continue;
    // The program's file name and how many arguments followed it. Good enough for a count.
    const parts = command.split(/\s+/);
    const program = path.basename(parts[0]!);
    watch.programs.set(program, Math.max(watch.programs.get(program) ?? 0, parts.length - 1));
  }
  for (const row of withEnvironment.split("\n")) {
    const match = rowPattern.exec(row);
    if (!match) continue;
    // What -E added to this process's row is its environment. A process that only one of the two
    // listings caught is left for the next look, 50 ms on.
    const command = commandOf.get(match[1]!);
    if (command === undefined || !match[3]!.startsWith(command)) continue;
    const environment = match[3]!.slice(command.length);
    if (environment.includes(ENV_CONTROL)) watch.environmentReadable = true;
    if (environment.includes(codeWord)) watch.codeWordInEnvironment = true;
  }
}

/** What Kiro wrote down about the chat it just saved. Numbers only. */
interface Recorded {
  promptLength: number | null;
  toolUses: number;
  credits: number;
}

const savedChatsDir = path.join(kiroHome, "sessions", "cli");
function savedChats(): string[] {
  try {
    return readdirSync(savedChatsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Reads the chats saved since `before`. The file's layout is Kiro's own and may change: then this is null. */
function recordedSince(before: string[]): Recorded | null {
  const fresh = savedChats().filter((name) => !before.includes(name));
  if (fresh.length === 0) return null;
  const recorded: Recorded = { promptLength: null, toolUses: 0, credits: 0 };
  try {
    for (const name of fresh) {
      const saved = JSON.parse(readFileSync(path.join(savedChatsDir, name), "utf8")) as {
        session_state?: { conversation_metadata?: { user_turn_metadatas?: { user_prompt_length?: number; builtin_tool_uses?: number; metering_usage?: { value?: number; unit?: string }[] }[] } };
      };
      for (const turn of saved.session_state?.conversation_metadata?.user_turn_metadatas ?? []) {
        recorded.promptLength = turn.user_prompt_length ?? null;
        recorded.toolUses += turn.builtin_tool_uses ?? 0;
        for (const meter of turn.metering_usage ?? []) if (meter.unit === "credit") recorded.credits += meter.value ?? 0;
      }
    }
  } catch {
    return null;
  }
  recorded.credits = Number(recorded.credits.toFixed(4));
  return recorded;
}

interface Outcome {
  try: Try;
  promptBytes: number;
  /** One per Unicode character, to tell apart from bytes in the unicode try. */
  promptCharacters: number;
  exitCode: number | null;
  timedOut: boolean;
  seconds: number;
  /** The reply held one JSON object with the right sum and the code word. */
  rightAnswer: boolean;
  jsonObjectsInReply: number;
  stdoutBytes: number;
  stderrBytes: number;
  processListSamples: number;
  programsInKiroGroup: Record<string, number>;
  codeWordInArguments: boolean;
  codeWordInEnvironment: boolean;
  environmentReadable: boolean;
  /** Null when no chat was saved (Kiro never reached the model) or the saved file could not be read. */
  kiroRecorded: Recorded | null;
}

function runTry(name: Try): Promise<Outcome> {
  const codeWord = `quillfeather${Math.floor(100_000 + Math.random() * 900_000)}`;
  const accentWord = name === "unicode" ? ACCENT_WORD : null;
  const prompt = name === "empty" ? "" : buildPrompt(codeWord, name === "long" ? 2_500 : 0, accentWord);
  const args = ["chat", "--no-interactive", "--agent", AGENT_NAME, "--model", DEFAULT_MODEL];
  if (name === "argument") args.push(prompt);
  // The same stripped-down environment the detector gives Kiro, plus the control variable.
  const [controlName, controlValue] = ENV_CONTROL.split("=") as [string, string];
  const env = { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: process.env.TMPDIR ?? "/tmp", NO_COLOR: "1", KIRO_HOME: kiroHome, [controlName]: controlValue };

  const chatsBefore = savedChats();
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(binary!, args, { cwd, env, stdio: [name === "argument" ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
    const groupId = child.pid ?? -1;
    const watch: Watch = { samples: 0, programs: new Map(), codeWordInArguments: false, codeWordInEnvironment: false, environmentReadable: false };

    let running = true;
    const watching = (async () => {
      while (running) {
        await sample(watch, groupId, codeWord);
        await new Promise((wake) => setTimeout(wake, SAMPLE_EVERY_MS));
      }
    })();

    if (child.stdin) {
      // If Kiro goes away without reading, the write fails. That must not crash the spike.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt, "utf8");
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-groupId, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, TIMEOUT_MS);

    const finish = async (exitCode: number | null): Promise<void> => {
      clearTimeout(timer);
      running = false;
      await watching;
      const reply = stripAnsi(stdout);
      const objects = reply.match(/\{[^{}]*\}/g) ?? [];
      const rightAnswer = objects.some((text) => {
        try {
          const value = JSON.parse(text) as { sum?: unknown; code_word?: unknown; accent_word?: unknown };
          return value.sum === 43 && value.code_word === codeWord && (accentWord === null || value.accent_word === accentWord);
        } catch {
          return false;
        }
      });
      resolve({
        try: name,
        promptBytes: Buffer.byteLength(prompt, "utf8"),
        promptCharacters: [...prompt].length,
        exitCode,
        timedOut,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        rightAnswer,
        jsonObjectsInReply: objects.length,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        processListSamples: watch.samples,
        programsInKiroGroup: Object.fromEntries(watch.programs),
        codeWordInArguments: watch.codeWordInArguments,
        codeWordInEnvironment: watch.codeWordInEnvironment,
        environmentReadable: watch.environmentReadable,
        kiroRecorded: recordedSince(chatsBefore),
      });
    };
    child.once("error", () => void finish(null));
    child.once("close", (code) => void finish(code));
  });
}

const outcomes: Outcome[] = [];
for (const name of tries) {
  const outcome = await runTry(name);
  outcomes.push(outcome);
  console.log(JSON.stringify(outcome));
}

const byName = (name: Try): Outcome | undefined => outcomes.find((outcome) => outcome.try === name);
const piped = [byName("stdin"), byName("long"), byName("unicode")].filter((outcome): outcome is Outcome => outcome !== undefined);
const control = byName("argument");
const summary = {
  kiroReadsThePromptFromStandardInput: piped.length === 0 ? "not tried" : piped.every((outcome) => outcome.exitCode === 0 && outcome.rightAnswer),
  // Kiro's own count of the prompt's length, against ours. Only the unicode try can tell bytes from
  // characters (on 2026-10-10, Kiro CLI 2.29.0 counted bytes).
  kiroGotTheWholePrompt:
    piped.length === 0 ? "not tried" : piped.every((outcome) => outcome.kiroRecorded?.promptLength === outcome.promptBytes || outcome.kiroRecorded?.promptLength === outcome.promptCharacters),
  toolsRun: outcomes.reduce((sum, outcome) => sum + (outcome.kiroRecorded?.toolUses ?? 0), 0),
  creditsUsed: Number(outcomes.reduce((sum, outcome) => sum + (outcome.kiroRecorded?.credits ?? 0), 0).toFixed(4)),
  promptSeenInAnyArgumentsWhenPiped: piped.length === 0 ? "not tried" : piped.some((outcome) => outcome.codeWordInArguments),
  promptSeenInAnyEnvironmentWhenPiped: piped.length === 0 ? "not tried" : piped.some((outcome) => outcome.codeWordInEnvironment),
  theCheckCanSeeArguments: control === undefined ? "not tried (run the argument try)" : control.codeWordInArguments,
  theCheckCanSeeEnvironments: outcomes.some((outcome) => outcome.environmentReadable),
  emptyStandardInputExitCode: byName("empty")?.exitCode ?? "not tried",
};
console.log(JSON.stringify(summary, null, 2));
if (piped.some((outcome) => outcome.exitCode !== 0 || !outcome.rightAnswer || outcome.codeWordInArguments || outcome.codeWordInEnvironment)) process.exitCode = 1;
