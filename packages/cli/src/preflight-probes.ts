// How `overnight preflight` really asks its questions of this Mac. Each answer is yes or no (or
// one of a few fixed words): what a program printed never leaves this file.
//
// gh is started the way the deliver job will start it: by name, on the PATH that job has. So
// "gh is logged in" here also means "the job will find gh".
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { Config, LoginState } from "@overnight/core";
import { nightJobPath, readCrewJobSandbox, readNightJobsState } from "./background.ts";
import type { PreflightProbes } from "./commands/preflight.ts";
import { gatewayAnswers } from "./gateway.ts";
import { runQuiet } from "./run-quiet.ts";
import type { QuietOptions, QuietResult } from "./run-quiet.ts";
import { readSmallFile, sameText } from "./small-file.ts";

/** The parts that come from other packages. wiring.ts passes the real ones. */
export interface ProbeParts {
  beeLoginState: () => Promise<LoginState>;
  /** Full path of kiro-cli, or null if it is not installed (@overnight/detector). */
  findKiroBinary: () => string | null;
  /** Kiro Crew's own folder (@overnight/builder). */
  crewHome: () => string;
  /** Null when Kiro Crew is set the way the mode needs, else why not (@overnight/builder). Reads only. */
  crewSettingsProblem: (crewHome: string, mode: Config["buildSandbox"]) => string | null;
  /** Where the skill is installed inside Kiro Crew's folder (@overnight/builder). */
  installedSkillFile: (crewHome: string) => string;
  /** Our own copy of the skill: crew/build-skill.md (@overnight/builder). */
  buildSkillFile: string;
  /** The builder's own sandbox probe, on its own (@overnight/builder: runStandaloneSandboxProbe). */
  sandboxProbe: PreflightProbes["sandboxProbe"];
  /** Is a build running on this data folder right now? Null if that could not be told. */
  buildRunning: PreflightProbes["buildRunning"];
  /** Replaced in tests. */
  run?: (command: string, args: string[], options: QuietOptions) => Promise<QuietResult>;
  gatewayAnswers?: () => Promise<boolean>;
  home?: string;
  /** The folder node is in. Default: the folder of the node running this. */
  nodeDir?: string;
  /** Where Playwright keeps its browsers. Default: PLAYWRIGHT_BROWSERS_PATH, or ~/Library/Caches/ms-playwright. */
  browsersDir?: string;
}

const KIRO_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 30_000;
/** A skill is a few kilobytes of text. */
const MAX_SKILL_BYTES = 1024 * 1024;
/** GitHub's own rule for an account name. Checked before the name is put into a request path. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

export function realPreflightProbes(parts: ProbeParts): PreflightProbes {
  const run = parts.run ?? runQuiet;
  const home = parts.home ?? homedir();
  const user = userInfo().username;
  // What a background job has, and no more: nothing of this shell's leaks into the answer.
  const baseEnv = { HOME: home, USER: user, LOGNAME: user, TMPDIR: tmpdir(), NO_COLOR: "1" };
  const jobEnv = {
    ...baseEnv,
    PATH: nightJobPath(home, parts.nodeDir ?? path.dirname(process.execPath)),
    // Never wait on a question nobody is there to answer.
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const gh = (args: string[], keepOutput = false) => run("gh", args, { env: jobEnv, timeoutMs: GH_TIMEOUT_MS, keepOutput });

  return {
    beeLoginState: parts.beeLoginState,

    async kiroSignedIn() {
      const binary = parts.findKiroBinary();
      if (binary === null) return false;
      // The same rule as the detector's own check: a clean exit, and not the words "Not logged in".
      // The output (the account's email address when signed in) is looked at here and dropped.
      const result = await run(binary, ["whoami"], { env: { ...baseEnv, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeoutMs: KIRO_TIMEOUT_MS, keepOutput: true });
      if (!result.started) return false;
      if (result.timedOut) throw new Error(`kiro-cli did not say whether Kiro is signed in within ${KIRO_TIMEOUT_MS / 1000} seconds`);
      return result.exitCode === 0 && !/not logged in/i.test(result.output);
    },

    gatewayAnswers: parts.gatewayAnswers ?? (() => gatewayAnswers()),

    async crewSettingsProblem(mode) {
      return parts.crewSettingsProblem(parts.crewHome(), mode);
    },

    async installedSkill() {
      const ours = readSmallFile(parts.buildSkillFile, MAX_SKILL_BYTES);
      if (ours === null) throw new Error("crew/build-skill.md could not be read");
      const file = parts.installedSkillFile(parts.crewHome());
      const installed = readSmallFile(file, MAX_SKILL_BYTES);
      // Something is there but it is not a plain, readable file of a sensible size: not ours.
      if (installed === null) return existsSync(file) ? "different" : "missing";
      return sameText(installed, ours) ? "same" : "different";
    },

    sandboxProbe: parts.sandboxProbe,
    buildRunning: parts.buildRunning,

    async ghLoggedIn() {
      const result = await gh(["auth", "status"]);
      if (result.timedOut) throw new Error(`gh did not answer within ${GH_TIMEOUT_MS / 1000} seconds`);
      return result.started && result.exitCode === 0;
    },

    async pagesRepoReachable(repo) {
      if (!REPO_NAME.test(repo) || repo === "." || repo === "..") return false;
      // Who is logged in: the apps repo lives under that account, as the publisher has it.
      const who = await gh(["api", "user", "--jq", ".login"], true);
      if (who.timedOut) throw new Error(`GitHub did not answer within ${GH_TIMEOUT_MS / 1000} seconds`);
      const owner = who.output.trim();
      if (!who.started || who.exitCode !== 0 || !GITHUB_LOGIN.test(owner)) return false;
      const seen = await gh(["api", `repos/${owner}/${repo}`, "--silent"]);
      if (seen.timedOut) throw new Error(`GitHub did not answer within ${GH_TIMEOUT_MS / 1000} seconds`);
      return seen.started && seen.exitCode === 0;
    },

    async headlessShellPresent() {
      const dir = parts.browsersDir ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(home, "Library", "Caches", "ms-playwright");
      try {
        // The name the deliver step's own check looks for.
        return readdirSync(dir).some((name) => name.startsWith("chromium_headless_shell-"));
      } catch {
        return false;
      }
    },

    nightJobs: () => readNightJobsState(home),
    crewJobSandbox: () => readCrewJobSandbox(home),
  };
}
