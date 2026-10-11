// The fallback build backend: Kiro CLI, headless, inside OUR macOS sandbox.
//
//   /usr/bin/sandbox-exec -f sandbox/kiro-cli-build.sb -D HOME=... -D WORKSPACE=... -D DATA_DIR=...
//       -D REPO=... -D NODE_DIR=... -D NPM_CACHE=...      (one -D for each name the profile asks for)
//       <kiro-cli> chat --no-interactive --model auto --trust-tools read,write,shell "<prompt>"
//
// The prompt is the text of crew/build-skill.md plus one line saying where the brief is. Kiro
// runs in the workspace folder with a stripped-down environment (HOME, PATH, TMPDIR, NO_COLOR),
// under a hard time limit that kills its whole process group (Kiro has no timeout of its own).
// It uses the Kiro sign-in on this Mac; there is no API key.
//
// TMPDIR is a corner of the build jobs' own temporary folder, <data>/tmp/build/kiro-cli: the only temporary folder the
// sandbox lets a build read or write. It is emptied before each build, so nothing one build left
// there (a compiled test, a cache) is picked up by the next.
//
// Before the brief is sent, both of Kiro's content-sharing settings must read "false" in the
// Kiro home this build uses (the same check packages/detector makes before it sends real text).
// They are only read here, never changed, and the build is refused otherwise.
//
// Kiro's exit code and its own report are never trusted: the files it leaves decide
// (build-status.ts), and the deliver step checks again before anything is published.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DataPaths, Logger } from "@overnight/core";
import { checkBuildResult } from "./build-status.ts";
import { BUILD_SKILL_FILE, kiroCliPrompt, readTextFile, REPO_ROOT } from "./crew-files.ts";
import { createCommandRunner, isStopping } from "./run.ts";
import type { CommandResult, CommandRunner } from "./run.ts";
import { realPath, realPathAllowMissing, sandboxDefines } from "./sandbox-values.ts";
import { buildTmpDir, isSafeIdeaId } from "./workspace.ts";
import { minutesText, STOPPED_REASON } from "./types.ts";
import type { BuildBackend, BuildJob, BuildOptions, BuildOutcome } from "./types.ts";

export const KIRO_CLI = "kiro-cli";
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The sandbox profile that ships with this package. */
export const KIRO_CLI_SANDBOX_PROFILE = path.resolve(import.meta.dirname, "..", "sandbox", "kiro-cli-build.sb");
/** What Kiro printed during the last build of an idea, kept beside its brief for the dashboard. */
export const KIRO_OUTPUT_FILE = "kiro-cli-output.log";
const MAX_SAVED_OUTPUT_CHARS = 200_000;
/**
 * Kiro's two content-sharing settings. Kiro may use prompts from individual accounts to improve
 * its service unless both are off (SPEC section 9). Same list as packages/detector.
 */
export const PRIVACY_SETTINGS = ["codeWhisperer.shareCodeWhispererContentWithAWS", "telemetry.enabled"] as const;
const SETTINGS_TIMEOUT_MS = 20_000;
export const SHARING_NOT_OFF = "Kiro's content-sharing settings are not both switched off, so the brief was not sent to Kiro CLI";
export const SHARING_UNKNOWN = "Kiro's content-sharing settings could not be checked, so the brief was not sent to Kiro CLI";

export interface KiroCliBackendOptions {
  paths: DataPaths;
  logger: Logger;
  /** Full path of kiro-cli. Default: ~/.local/bin/kiro-cli, then the app bundle. */
  kiroBinary?: string;
  /** The folder that holds node and npm, put first on Kiro's PATH. Default: the node running us. */
  nodeBinDir?: string;
  run?: CommandRunner;
  now?: () => Date;
  /** Default: crew/build-skill.md. */
  skillFile?: string;
  /** Default: sandbox/kiro-cli-build.sb in this package. */
  sandboxProfile?: string;
  /** Default: /usr/bin/sandbox-exec. */
  sandboxExec?: string;
  /** The repo whose .env the sandbox hides. Default: this repo. */
  repoRoot?: string;
  /** Default: the user's home folder. */
  home?: string;
}

export function kiroBinaryCandidates(): string[] {
  return [path.join(homedir(), ".local", "bin", "kiro-cli"), "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli"];
}

/** Full path of kiro-cli, or null. Never looked up on PATH: background jobs do not have one. */
export function findKiroBinary(): string | null {
  return kiroBinaryCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

interface SandboxParts {
  profile: string;
  /** The profile's values as sandbox-exec arguments: "-D", "NAME=<full real path>", ... (see sandbox-values.ts). */
  defines: string[];
  kiroBinary: string;
}

/** The arguments after "sandbox-exec" up to and including kiro-cli itself: the profile, its values, the program. */
function sandboxedKiro(parts: SandboxParts): string[] {
  return ["-f", parts.profile, ...parts.defines, parts.kiroBinary];
}

/** The arguments after "sandbox-exec": the profile, its values, then the Kiro command. */
export function sandboxedKiroArgs(parts: SandboxParts & { prompt: string }): string[] {
  return [...sandboxedKiro(parts), "chat", "--no-interactive", "--model", "auto", "--trust-tools", "read,write,shell", parts.prompt];
}

/** The arguments that ask Kiro, inside the same sandbox, what one of its settings is. */
export function sandboxedSettingArgs(parts: SandboxParts, key: string): string[] {
  return [...sandboxedKiro(parts), "settings", key];
}

/** The Kiro CLI build's own corner of the build jobs' temporary folder. */
export const KIRO_CLI_TMP = "kiro-cli";

/**
 * The Kiro CLI build's temporary folder, made if missing and emptied: <data>/tmp/build/kiro-cli.
 * Only this corner is emptied. The rest of <data>/tmp/build is the running Kiro Crew gateway's
 * temporary folder, and a fallback build must not pull files out from under it. Null when the
 * folder cannot be made ready (a link standing in its place is refused, not followed).
 */
export function kiroCliTmpDir(buildTmp: string): string | null {
  const dir = path.join(buildTmp, KIRO_CLI_TMP);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) return null;
    chmodSync(dir, 0o700);
    return emptyFolder(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Remove everything inside a folder, never the folder itself. Links are removed, not followed.
 * False when the folder is not a plain folder or something in it could not be removed.
 */
export function emptyFolder(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function createKiroCliBackend(options: KiroCliBackendOptions): BuildBackend {
  const { paths } = options;
  const logger = options.logger.child({ backend: KIRO_CLI });
  const now = options.now ?? (() => new Date());
  const run = options.run ?? createCommandRunner();
  const sandboxExec = options.sandboxExec ?? SANDBOX_EXEC;

  /** Keep what Kiro printed, for a person looking into a failed build. Never logged. Best effort. */
  function saveOutput(ideaId: string, result: CommandResult): void {
    try {
      const dir = path.join(paths.ideas, ideaId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const text = `exit code: ${result.exitCode ?? "none"}${result.timedOut ? " (stopped at the time limit)" : ""}\n\n--- reply ---\n${result.stdout.slice(-MAX_SAVED_OUTPUT_CHARS)}\n\n--- activity ---\n${result.stderr.slice(-MAX_SAVED_OUTPUT_CHARS)}\n`;
      writeFileSync(path.join(dir, KIRO_OUTPUT_FILE), text, { mode: 0o600 });
    } catch {
      // The build's result does not depend on this file.
    }
  }

  async function build(job: BuildJob, startedMs: number, signal: AbortSignal | undefined): Promise<BuildOutcome> {
    const ms = () => now().getTime() - startedMs;
    const cannotStart = (reason: string): BuildOutcome => ({ ok: false, backend: KIRO_CLI, ms: ms(), reason, couldNotStart: true });
    const failed = (reason: string): BuildOutcome => ({ ok: false, backend: KIRO_CLI, ms: ms(), reason, couldNotStart: false });
    /** Has Overnight been told to stop? */
    const stopped = (): boolean => signal?.aborted === true || isStopping();
    const withSignal = signal === undefined ? {} : { signal };

    if (stopped()) return failed(STOPPED_REASON);
    if (!isSafeIdeaId(job.ideaId)) return cannotStart("the idea id cannot be used as a folder name");
    const kiroBinary = realPath(options.kiroBinary ?? findKiroBinary() ?? "");
    if (kiroBinary === null) return cannotStart("Kiro CLI is not installed (kiro-cli was not found)");
    if (!existsSync(sandboxExec)) return cannotStart("this Mac has no sandbox-exec, so the build was not started");
    const profile = realPath(options.sandboxProfile ?? KIRO_CLI_SANDBOX_PROFILE);
    if (profile === null) return cannotStart("the build sandbox profile is missing");

    const workspace = realPath(job.workspace);
    const home = realPath(options.home ?? homedir());
    const nodeBinDir = realPath(options.nodeBinDir ?? path.dirname(process.execPath));
    if (workspace === null || !existsSync(path.join(workspace, "brief.md"))) return cannotStart("the workspace or its brief.md is missing");
    // The profile says itself which values it wants; every one is a real path, or nothing starts.
    const defines =
      home === null || nodeBinDir === null
        ? null
        : sandboxDefines(profile, {
            HOME: home,
            WORKSPACE: workspace,
            DATA_DIR: realPath(paths.root),
            REPO: realPath(options.repoRoot ?? REPO_ROOT),
            // The Node.js install: the folder that holds bin/node.
            NODE_DIR: path.dirname(nodeBinDir),
            NPM_CACHE: realPathAllowMissing(path.join(home, ".npm")),
          });
    if (home === null || nodeBinDir === null || defines === null) return cannotStart("a folder the build sandbox needs is missing");
    // The build's own temporary folder, empty: nothing an earlier build left there is reused.
    const tmpRoot = buildTmpDir(paths);
    const tmpDir = tmpRoot === null ? null : kiroCliTmpDir(tmpRoot);
    if (tmpDir === null) return cannotStart("the build's temporary folder could not be made ready");

    const skill = readTextFile(options.skillFile ?? BUILD_SKILL_FILE);
    if (skill === null) return cannotStart("the build instructions in crew/build-skill.md could not be read");
    const prompt = kiroCliPrompt(skill, workspace);

    // Only what Kiro and npm need. Nothing from our own environment reaches agent-written code.
    // macOS's own programs come first on the PATH: nothing in a user-writable folder can stand
    // in for one of them. node, npm and npx are found in the node folder, which has no others.
    const env = {
      HOME: home,
      PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin", nodeBinDir].join(":"),
      TMPDIR: tmpDir,
      NO_COLOR: "1",
    };
    const parts = { profile, defines, kiroBinary };

    // Nothing is sent to Kiro until both content-sharing settings read "false": asked of Kiro
    // itself, in the same folder, with the same environment and inside the same sandbox as the
    // build, so the answer is the one the build would get. Kiro prints "false (global)".
    for (const key of PRIVACY_SETTINGS) {
      const setting = await run(sandboxExec, sandboxedSettingArgs(parts, key), { cwd: workspace, env, timeoutMs: SETTINGS_TIMEOUT_MS, ...withSignal });
      if (stopped()) return failed(STOPPED_REASON);
      if (setting.error !== undefined || setting.timedOut) {
        logger.error("kiro cli build refused: a content-sharing setting could not be read", { ideaId: job.ideaId, key, timedOut: setting.timedOut });
        return cannotStart(SHARING_UNKNOWN);
      }
      // A setting that was never set exits 1 ("No value associated with ..."): that is not "off".
      if (setting.exitCode !== 0 || !/^false(\s+\(\w+\))?$/.test(setting.stdout.trim())) {
        logger.error("kiro cli build refused: a content-sharing setting is not off", { ideaId: job.ideaId, key });
        return cannotStart(SHARING_NOT_OFF);
      }
    }

    const args = sandboxedKiroArgs({ ...parts, prompt });
    logger.info("kiro cli build started", { ideaId: job.ideaId, timeoutMin: Math.round(job.timeoutMs / 60_000) });
    // Stopped at once, with everything it started, when Overnight is told to stop.
    const result = await run(sandboxExec, args, { cwd: workspace, env, timeoutMs: job.timeoutMs, ...withSignal });
    saveOutput(job.ideaId, result);

    const check = checkBuildResult(workspace, startedMs);
    logger.info("kiro cli ended", { ideaId: job.ideaId, exitCode: result.exitCode, timedOut: result.timedOut, built: check.ok });
    // A build that had already finished cleanly when it was stopped, or the time ran out, still counts.
    if (check.ok) return { ok: true, backend: KIRO_CLI, ms: ms() };
    // Cut off because Overnight itself was told to stop: not a failure of the build.
    if (stopped()) return failed(STOPPED_REASON);
    if (result.error !== undefined) return cannotStart("Kiro CLI could not be started inside the build sandbox");
    if (result.timedOut) return failed(`the build ran past its time limit of ${minutesText(job.timeoutMs)}`);
    if (check.neverStarted) {
      const said = `${result.stdout}\n${result.stderr}`;
      // sandbox-exec's own complaints start with its name: a bad profile or a missing value.
      if (/^sandbox-exec: /m.test(result.stderr)) return cannotStart("the build sandbox refused to start Kiro CLI");
      if (/not logged in|kiro-cli login/i.test(said)) return cannotStart("Kiro is signed out on this Mac (to fix it, run: kiro-cli login)");
    }
    return failed(check.reason);
  }

  return {
    name: KIRO_CLI,
    async build(job: BuildJob, buildOptions: BuildOptions = {}) {
      const startedMs = now().getTime();
      try {
        return await build(job, startedMs, buildOptions.signal);
      } catch {
        // The error's own text is not passed on: it could quote a path or a tool's reply.
        logger.error("kiro cli build stopped on an unexpected error", { ideaId: job.ideaId });
        return { ok: false, backend: KIRO_CLI, ms: now().getTime() - startedMs, reason: "the Kiro CLI build stopped on an unexpected error", couldNotStart: false };
      }
    },
  };
}
