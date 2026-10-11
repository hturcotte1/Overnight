// The detector: one conversation in, one checked verdict out, through Kiro CLI with no tools.
//
// What keeps the transcript safe here (SPEC §5 and §9):
// - Kiro always runs as our own "overnight-detector" agent, whose tools list is empty. Kiro's
//   default agent can read files, so there is no option to run without the agent.
// - It runs from its own folder with its own KIRO_HOME, both under the data folder.
// - The prompt, which holds the transcript, reaches Kiro on standard input. It is never a
//   command-line argument: any program on the Mac can read another program's arguments.
// - Nothing is sent until ensureSetup() has seen both of Kiro's content-sharing settings off.
// - Kiro's saved copies of each chat are deleted after a day.
// - Failure reasons and log lines are our own words: never the transcript, never the model's
//   reply, never what `kiro-cli whoami` printed (it prints the account's email address).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { silentLogger } from "@overnight/core";
import type { DataPaths, Detector, DetectorInput, DetectorResult, Logger } from "@overnight/core";
import { createKiroRunner } from "./kiro.ts";
import type { KiroRunner } from "./kiro.ts";
import { buildPrompt, transcriptText, withRetryNote } from "./prompt.ts";
import { parseVerdict } from "./schema.ts";
import { pruneSavedSessions } from "./sessions.ts";

export const AGENT_NAME = "overnight-detector";
export const DEFAULT_MODEL = "claude-haiku-4.5";
export const DEFAULT_TIMEOUT_MS = 90_000;
/** Kiro may use prompts to improve its service unless both of these are "false". */
export const PRIVACY_SETTINGS = ["codeWhisperer.shareCodeWhispererContentWithAWS", "telemetry.enabled"] as const;
/** What ensureSetup() throws, and what detect() gives as its reason, while Kiro is signed out. */
export const SIGNED_OUT_MESSAGE = "Kiro is signed out on this Mac, so no ideas can be noticed. To fix it, run: kiro-cli login";

const MAX_ATTEMPTS = 2;
const SETTINGS_TIMEOUT_MS = 20_000;
const SIGN_IN_TIMEOUT_MS = 20_000;
/** While Kiro is signed out, detect() looks again at most this often. */
const SIGN_IN_RECHECK_MS = 30_000;
/** Old saved chats are cleared at set-up and then at most this often. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const AGENT_FILE = fileURLToPath(new URL(`../agent/${AGENT_NAME}.json`, import.meta.url));

export interface KiroDetectorOptions {
  paths: DataPaths;
  logger?: Logger;
  model?: string;
  timeoutMs?: number;
  /** Full path of kiro-cli, if it is not in one of the two usual places. */
  kiroBinary?: string;
  /** Replaces the real kiro-cli. For tests. */
  run?: KiroRunner;
  /** The clock, in milliseconds. For tests. */
  now?: () => number;
}

export type KiroDetector = Detector & {
  /**
   * Create the folders, install the no-tools agent, check Kiro's privacy settings and check that
   * Kiro is signed in. Throws, with a message that says what to do, if real text must not or
   * cannot be sent. Safe to call again and again: after a failure it starts over, and once it
   * has succeeded a further call only looks at two files and starts no kiro-cli.
   */
  ensureSetup(): Promise<void>;
};

/** A refusal in our own words. Its message is safe to log and to hand back as a reason. */
class SetupError extends Error {}

const settingsSchema = z.object({
  // Kept to plain model names so the value can never be read as another command-line flag.
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a model name like claude-haiku-4.5"),
  timeoutMs: z.number().int().min(1).max(600_000),
});

// The agent file we ship. Checked every time it is installed, so an edit that gives the agent
// tools is caught before any transcript goes through it.
const agentSchema = z.looseObject({
  name: z.literal(AGENT_NAME),
  tools: z.array(z.unknown()).length(0),
  allowedTools: z.array(z.unknown()).length(0),
});

function readAgentFile(): string {
  const text = readFileSync(AGENT_FILE, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SetupError(`The detector's agent file is not valid JSON: ${AGENT_FILE}`);
  }
  if (!agentSchema.safeParse(value).success) {
    throw new SetupError(`The detector's agent file must be named "${AGENT_NAME}" and have no tools: ${AGENT_FILE}`);
  }
  return text;
}

/** Is `inner` a folder somewhere below `outer`? */
function isInside(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

type SignIn = { state: "in" } | { state: "out" } | { state: "unknown"; why: string; unavailable: boolean };

export function createKiroDetector(options: KiroDetectorOptions): KiroDetector {
  const settings = settingsSchema.safeParse({ model: options.model ?? DEFAULT_MODEL, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (!settings.success) {
    throw new Error(`Bad detector setting. ${settings.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const { model, timeoutMs } = settings.data;
  const { paths } = options;
  const logger = options.logger ?? silentLogger;
  const run = options.run ?? createKiroRunner(options.kiroBinary === undefined ? {} : { kiroBinary: options.kiroBinary });
  const now = options.now ?? Date.now;
  const where = { cwd: paths.detectorCwd, kiroHome: paths.detectorKiroHome };
  // Everything a chat is started with. No prompt here: with none given as an argument, Kiro reads
  // it from standard input (spike 9).
  const chatArgs = ["chat", "--no-interactive", "--agent", AGENT_NAME, "--model", model];
  const installedAgentFile = path.join(paths.detectorKiroHome, "agents", `${AGENT_NAME}.json`);

  /** True once a full set-up has succeeded, until a later one fails. */
  let ready = false;
  /** Why not, in our own words, for detect()'s reason. */
  let notReadyWhy = "ensureSetup() has not been called";
  let settingUp: Promise<void> | null = null;
  /** Set when a chat failed and `kiro-cli whoami` said Kiro was signed out. No chat starts while it is set. */
  let signedOut = false;
  let signInCheckedAt = 0;
  let prunedAt: number | null = null;
  /** The last "not now" reason given, so the same one is not logged as a warning on every pass. */
  let lastWaitReason = "";

  /** "off", or why we could not tell. Kiro prints the value as "false (global)". */
  async function readSetting(key: string): Promise<"off" | "not off" | { unreadable: string }> {
    const result = await run(["settings", key], { ...where, timeoutMs: SETTINGS_TIMEOUT_MS });
    if (result.error) return { unreadable: result.error };
    if (result.timedOut) return { unreadable: `no answer within ${SETTINGS_TIMEOUT_MS / 1000} s` };
    // A setting that was never set exits 1 with "No value associated with ...": that is "not off".
    if (result.exitCode !== 0) return "not off";
    return /^false(\s+\(\w+\))?$/.test(result.stdout.trim()) ? "off" : "not off";
  }

  async function switchOff(key: string): Promise<void> {
    const before = await readSetting(key);
    if (before === "off") return;
    if (typeof before === "object") {
      // The runner's own error text names an error code or a place, never an argument.
      throw new SetupError(`Could not run kiro-cli to check its "${key}" setting (${before.unreadable}), so real text will not be sent to Kiro.`);
    }
    await run(["settings", key, "false"], { ...where, timeoutMs: SETTINGS_TIMEOUT_MS });
    // Trust only what Kiro reads back, not the exit code of the command that set it.
    if ((await readSetting(key)) !== "off") {
      throw new SetupError(`Kiro's "${key}" setting is not off and could not be switched off, so real text will not be sent to Kiro.`);
    }
    logger.info("switched off a Kiro content-sharing setting", { key });
  }

  /**
   * Is Kiro signed in on this Mac? `kiro-cli whoami` prints "Not logged in" when it is not, and
   * the account's email address when it is. Its output is read here and goes nowhere else: not
   * into a log line, an error or a result.
   */
  async function signIn(): Promise<SignIn> {
    const result = await run(["whoami"], { ...where, timeoutMs: SIGN_IN_TIMEOUT_MS });
    if (result.error) return { state: "unknown", why: result.error, unavailable: result.unavailable !== undefined };
    if (result.timedOut) return { state: "unknown", why: `kiro-cli did not say whether Kiro is signed in within ${SIGN_IN_TIMEOUT_MS / 1000} s`, unavailable: false };
    if (result.exitCode === null) return { state: "unknown", why: "kiro-cli was stopped before it said whether Kiro is signed in", unavailable: false };
    if (result.exitCode !== 0 || /not logged in/i.test(`${result.stdout}\n${result.stderr}`)) return { state: "out" };
    return { state: "in" };
  }

  /** How many things are in the working folder that should not be. Finder's own .DS_Store is harmless. */
  function strays(): number {
    return readdirSync(paths.detectorCwd).filter((name) => name !== ".DS_Store").length;
  }

  /** Delete Kiro's saved chats that are more than a day old. Only ever inside our own data folder. */
  async function pruneSessions(): Promise<void> {
    prunedAt = now();
    if (!isInside(paths.root, paths.detectorKiroHome)) return;
    const removed = await pruneSavedSessions(paths.detectorKiroHome, prunedAt);
    if (removed > 0) logger.info("removed old saved Kiro chats", { files: removed });
  }

  async function setUp(): Promise<void> {
    ready = false;
    const agentText = readAgentFile();
    for (const dir of [paths.detectorCwd, paths.detectorKiroHome, path.dirname(installedAgentFile)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The working folder must hold nothing: no file for the model to be shown, and no workspace
    // settings file that could override the two settings checked below. We refuse rather than
    // tidy up: deleting files from a folder that is not what we think it is would be worse.
    const found = strays();
    if (found > 0) {
      throw new SetupError(`The detector's working folder is not empty (${found} item(s) in ${paths.detectorCwd}), so real text will not be sent to Kiro.`);
    }
    // Written on every set-up, so an old or edited copy never lingers.
    writeFileSync(installedAgentFile, agentText, { mode: 0o600 });
    await pruneSessions();
    for (const key of PRIVACY_SETTINGS) await switchOff(key);
    const signedIn = await signIn();
    if (signedIn.state === "out") throw new SetupError(SIGNED_OUT_MESSAGE);
    if (signedIn.state === "unknown") throw new SetupError(`Could not check that Kiro is signed in (${signedIn.why}), so nothing will be sent to Kiro.`);
    signedOut = false;
    ready = true;
    logger.info("detector is set up", { model, timeoutMs });
  }

  /** Is what setUp() left on disk still there? Files only: this is all a repeat call costs. */
  function stillInPlace(): boolean {
    try {
      return readFileSync(installedAgentFile, "utf8") === readFileSync(AGENT_FILE, "utf8") && strays() === 0;
    } catch {
      return false;
    }
  }

  async function setUpIfNeeded(): Promise<void> {
    if (ready && !signedOut && stillInPlace()) return;
    notReadyWhy = "set-up has not finished";
    try {
      await setUp();
    } catch (error) {
      ready = false;
      // Errors that are not ours (a full disk, say) may carry a path; only their type is kept.
      notReadyWhy = error instanceof SetupError ? error.message : `set-up failed (${error instanceof Error ? error.name : "unknown error"})`;
      throw error;
    }
  }

  function ensureSetup(): Promise<void> {
    // Two callers at once share one run.
    settingUp ??= setUpIfNeeded().finally(() => {
      settingUp = null;
    });
    return settingUp;
  }

  async function detect(input: DetectorInput): Promise<DetectorResult> {
    const started = Date.now();
    let attempts = 0;
    /** A real failure: Kiro was asked and gave nothing we can use. */
    const giveUp = (reason: string): DetectorResult => {
      const ms = Date.now() - started;
      logger.warn("detector gave no verdict", { reason, ms, attempts });
      return { ok: false, reason, ms, attempts };
    };
    /** Not a failure of this conversation: the detector could not even try. The caller asks again later. */
    const notNow = (reason: string): DetectorResult => {
      const ms = Date.now() - started;
      const fields = { reason, ms, attempts, retryLater: true };
      if (reason === lastWaitReason) logger.debug("detector cannot run yet", fields);
      else logger.warn("detector cannot run yet", fields);
      lastWaitReason = reason;
      return { ok: false, reason, ms, attempts, retryLater: true };
    };

    try {
      if (!ready) return notNow(`the detector is not set up, so nothing was sent to Kiro (${notReadyWhy})`);
      const transcript = transcriptText(input);
      if (transcript === "") return giveUp("there was nothing to classify");

      if (signedOut) {
        if (now() - signInCheckedAt < SIGN_IN_RECHECK_MS) return notNow(SIGNED_OUT_MESSAGE);
        signInCheckedAt = now();
        const again = await signIn();
        if (again.state === "out") return notNow(SIGNED_OUT_MESSAGE);
        if (again.state === "unknown") return notNow(`could not check that Kiro is signed in (${again.why})`);
        signedOut = false;
        logger.info("Kiro is signed in again");
      }
      lastWaitReason = "";

      const prompt = buildPrompt(input);
      let problem = "";
      let replyProblem: string | null = null;
      let signInChecked = false;
      let result: DetectorResult | null = null;
      while (result === null && attempts < MAX_ATTEMPTS) {
        attempts += 1;
        // The second try tells the model what was wrong with the first, in our own words.
        const text = replyProblem === null ? prompt : withRetryNote(prompt, replyProblem);
        const reply = await run([...chatArgs], { ...where, timeoutMs, stdin: text });
        if (reply.error) {
          // kiro-cli could not start, or was stopped with this process. A second try would go the same way.
          result = reply.unavailable === undefined ? giveUp(reply.error) : notNow(reply.error);
        } else if (!reply.timedOut && reply.exitCode === null) {
          // Killed by a signal that was not our timeout: something is stopping it. Do not start another.
          result = giveUp("kiro-cli was stopped before it answered");
        } else if (reply.timedOut || reply.exitCode !== 0) {
          problem = reply.timedOut ? `kiro-cli did not answer within ${Math.round(timeoutMs / 1000)} s` : `kiro-cli exited with code ${reply.exitCode}`;
          if (!signInChecked) {
            // A signed-out Kiro fails every chat (or leaves it hanging). Find out once, so the
            // caller can wait for a sign-in instead of counting failures against this conversation.
            signInChecked = true;
            const state = await signIn();
            if (state.state === "out") {
              signedOut = true;
              signInCheckedAt = now();
              result = notNow(SIGNED_OUT_MESSAGE);
            } else if (state.state === "unknown" && state.unavailable) {
              result = notNow(state.why);
            }
          }
        } else {
          const parsed = parseVerdict(reply.stdout, transcript);
          if (parsed.ok) {
            const { verdict } = parsed;
            const ms = Date.now() - started;
            logger.info("detector verdict", {
              ms,
              attempts,
              isIdea: verdict.is_idea,
              confidence: verdict.confidence,
              likelyMedia: verdict.likely_media,
              buildable: verdict.buildable_as_static_web_app,
              quoteCut: parsed.quoteCut === true,
            });
            result = { ok: true, verdict, ms, attempts };
          } else {
            replyProblem = parsed.problem;
            problem = `the model's reply could not be used: ${parsed.problem}`;
          }
        }
        if (result === null) logger.debug("detector attempt failed", { attempt: attempts, problem });
      }
      result ??= giveUp(attempts > 1 ? `${problem} (after ${attempts} attempts)` : problem);

      // Kiro saved a copy of each chat that ran. Clear out the old ones now and then.
      const noChatRan = !result.ok && result.retryLater === true;
      if (!noChatRan && (prunedAt === null || now() - prunedAt >= PRUNE_EVERY_MS)) await pruneSessions();
      return result;
    } catch (error) {
      // Only the error's type is reported: a message from elsewhere could carry prompt text.
      return giveUp(`the detector failed unexpectedly (${error instanceof Error ? error.name : "unknown error"})`);
    }
  }

  return { detect, ensureSetup };
}
