// The publisher: put one checked dist folder on GitHub Pages and wait until it is really live.
// If the push went through but the page is not seen serving this build before the wait runs out,
// it says exactly that ({ ok: true, confirmedLive: false }) with the link, and the caller decides.
//
// Everything goes through the GitHub CLI login on this Mac ("gh" and "git" by name, found on our
// PATH). No token is read, printed or stored by this code. Proved by spike 7 (docs/spikes.md):
// a push to main of the public apps repo is live in 20 to 60 seconds, the repo root needs a
// .nojekyll file, and "live" must mean "serves THIS build", not just "answers 200".
//
// What this code promises, because the repo is public and nobody is watching at 6:30 a.m.:
//   - git and gh get a short, fixed environment (scrubbedEnv below), never ours as it is.
//   - Every commit is by "Overnight" with the account's GitHub no-reply address, set in git's own
//     environment variables so that nothing inherited can override it, and checked again on the
//     finished commit before anything is pushed.
//   - What is pushed is byte for byte what was verified: names that change what git does with a
//     folder are refused, and the staged files are compared with the copied ones.
//   - Nothing is ever force-pushed, and a first commit is only ever made in a repo that is empty.
//   - Our local clone is disposable. If it is cut off, locked or damaged it is renamed aside
//     (never deleted) and cloned again, so one bad morning cannot break every later one.
//   - Publishing is safe to repeat. If an earlier run pushed and then died before the idea was
//     recorded as published, the folder in the clone carries this idea's id (overnight.json), and
//     this run simply replaces it with its own version and its own marker.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { errorSummary } from "@overnight/core";
import type { Config, DataPaths, Logger } from "@overnight/core";
import { z } from "zod";
import { copyPlainTree, DIST_REFUSE_NAMES } from "./plain-copy.ts";
import { localPrivateStrings, scanForPrivateStrings } from "./private-scan.ts";
import { removeTree } from "./remove-tree.ts";
import { runCommand } from "./run-command.ts";
import type { CommandRunner, Publisher, PublishJob, PublishResult } from "./types.ts";

/** A slug becomes a folder that is deleted and rewritten, and part of a public link. Keep it boring. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IDEA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MARKER = /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/;

/** The file inside each published app that says which idea it is and which publish put it there. */
export const MARKER_FILE = "overnight.json";

/** The name every commit is made under. */
export const COMMIT_NAME = "Overnight";

/** Why a publish ended early when Overnight was told to stop. */
export const PUBLISH_STOPPED_REASON = "Publishing was stopped before it finished.";

/**
 * Settings that go in front of every git command, whatever the user's own git settings say:
 * no hooks (a hook is a program that would run with the GitHub login in reach), no signing (it
 * can ask for a passphrase nobody is there to type), and nothing that drops or rewrites files on
 * their way into a commit (ignore lists, attribute filters, line-ending conversion).
 */
export const GIT_SAFETY = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "push.gpgSign=false",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.autocrlf=false",
] as const;

/**
 * The only variables of ours that git and gh are given: where the home folder is, where programs
 * are, and (when set) where gh keeps its login. Checked on Oct 10, 2026: with just HOME and PATH,
 * gh finds its login and git finds the credential helper that goes through gh.
 */
const PASSED_ON = ["HOME", "PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"] as const;

const API_TIMEOUT_MS = 30_000;
const LOCAL_GIT_TIMEOUT_MS = 30_000;
const NETWORK_GIT_TIMEOUT_MS = 120_000;
/** Clean-up commands when we are being stopped: there are seconds left, not minutes. */
const STOPPING_GIT_TIMEOUT_MS = 3_000;
const FETCH_TIMEOUT_MS = 10_000;
const DIST_MAX_FILES = 500;
const DIST_MAX_BYTES = 20 * 1024 * 1024;
const TEMP_CLONE_PREFIX = ".tmp-clone-";

const userSchema = z.object({
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  id: z.number().int().positive(),
});
const markerFileSchema = z.object({ id: z.string(), marker: z.string() });

export interface PagesPublisherOptions {
  paths: DataPaths;
  config: Config;
  logger: Logger;
  run?: CommandRunner;
  fetchFn?: typeof fetch;
  now?: () => Date;
  /** How often to look whether the new version is live. Default 5 seconds. */
  pollMs?: number;
  /** How long to wait for it. Default 10 minutes. */
  liveTimeoutMs?: number;
  /** The strings that name this Mac or its owner and must not be published. Default: asked of the system. */
  privateStrings?: () => Promise<string[]>;
  /** Where the short environment for git and gh is taken from. Default: our own environment. */
  env?: Record<string, string | undefined>;
}

/** Stops a publish with a reason for the wearer. Never carries tool output. */
class PublishStop extends Error {}
/** Thrown when the stop signal has fired. */
class PublishStopped extends Error {}

/**
 * The environment git and gh run in: a short fixed list, so that nothing from the shell or the
 * job that started Overnight (an identity, a token, an editor, a proxy helper) rides along.
 * Tokens in GH_TOKEN or GITHUB_TOKEN are deliberately NOT passed on: publishing uses the GitHub
 * CLI's own stored login and nothing else.
 */
export function scrubbedEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ON) {
    const value = source[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  // Never wait on a question nobody is there to answer.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  // git's porcelain output is parsed below: keep it in one language.
  env.LC_ALL = "C";
  return env;
}

/** The id git gives a file's content, worked out by us: a hash over "blob <size>\0" and the bytes. */
function blobId(content: Buffer, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Every file under `dir` as { "relative/path": content }, paths in one Unicode form. */
function readTree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (stat.isFile()) files.set(`${prefix}${name}`.normalize("NFC"), readFileSync(full));
      else throw new Error("not a plain file");
    }
  };
  walk(dir, "");
  return files;
}

/** Lock files a killed git leaves behind. With one of these in place every later git command fails. */
function hasStaleLocks(gitDir: string): boolean {
  try {
    if (readdirSync(gitDir).some((name) => name.endsWith(".lock"))) return true;
    const stack = [path.join(gitDir, "refs")];
    let seen = 0;
    while (stack.length > 0 && seen < 10_000) {
      const current = stack.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        seen += 1;
        if (entry.isDirectory()) stack.push(path.join(current, entry.name));
        else if (entry.name.endsWith(".lock")) return true;
      }
    }
    return false;
  } catch {
    // A .git we cannot even list is not one to build on.
    return true;
  }
}

export function createPagesPublisher(options: PagesPublisherOptions): Publisher {
  const { paths, config } = options;
  const run = options.run ?? runCommand;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? 5_000;
  const liveTimeoutMs = options.liveTimeoutMs ?? 10 * 60_000;
  const privateStrings = options.privateStrings ?? localPrivateStrings;

  async function publish(job: PublishJob): Promise<PublishResult> {
    const logger = options.logger.child({ ideaId: job.ideaId });
    const signal = job.signal;
    /** True from the moment the push starts until it is known to have been refused: the new version is, or may be, on GitHub. */
    let pushed = false;
    const baseEnv = scrubbedEnv(options.env ?? process.env);
    /** For git. The identity is added once we know whose account this is. */
    let gitEnv = baseEnv;

    const stopIfAsked = () => {
      if (signal?.aborted) throw new PublishStopped();
    };

    /**
     * Run git or gh. Output is returned for parsing and never logged. `cleanUp` marks the commands
     * that put our clone back in order: they run even while we are being stopped, with a short limit.
     */
    const tool = async (what: string, command: "git" | "gh", args: string[], cwd: string | undefined, timeoutMs: number, cleanUp = false) => {
      if (!cleanUp) stopIfAsked();
      const result = await run(command, command === "git" ? [...GIT_SAFETY, ...args] : args, {
        ...(cwd === undefined ? {} : { cwd }),
        env: command === "git" ? gitEnv : baseEnv,
        timeoutMs: cleanUp && signal?.aborted ? Math.min(timeoutMs, STOPPING_GIT_TIMEOUT_MS) : timeoutMs,
        ...(signal === undefined || cleanUp ? {} : { signal }),
      });
      if (!cleanUp && (result.stopped === true || signal?.aborted)) throw new PublishStopped();
      const ok = result.error === undefined && !result.timedOut && result.exitCode === 0;
      if (!ok) logger.warn("a publishing command failed", { what, exitCode: result.exitCode, timedOut: result.timedOut, couldNotStart: result.error !== undefined });
      return { ok, stdout: result.stdout, timedOut: result.timedOut };
    };
    /** The same, but a failure stops the publish with `reason`. */
    const must = async (what: string, reason: string, command: "git" | "gh", args: string[], cwd: string | undefined, timeoutMs = LOCAL_GIT_TIMEOUT_MS) => {
      const result = await tool(what, command, args, cwd, timeoutMs);
      if (!result.ok) throw new PublishStop(reason);
      return result.stdout;
    };

    try {
      stopIfAsked();
      if (!SLUG_PATTERN.test(job.slug)) throw new PublishStop("The app's folder name is not one that can be published (lowercase letters, digits and dashes only).");
      if (!IDEA_ID.test(job.ideaId) || !MARKER.test(job.marker)) throw new PublishStop("The publish request was not valid.");
      const repo = config.githubPagesRepo;
      if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") throw new PublishStop("The apps repo name in the settings is not valid.");

      // ---- who is logged in to GitHub on this Mac ----
      const who = await must("gh api user", "GitHub did not say who is logged in. Is the GitHub CLI (gh) logged in on this Mac?", "gh", ["api", "user", "--jq", "{login: .login, id: .id}"], undefined, API_TIMEOUT_MS);
      let user: z.infer<typeof userSchema>;
      try {
        user = userSchema.parse(JSON.parse(who));
      } catch {
        throw new PublishStop("GitHub's answer about who is logged in could not be read.");
      }
      const owner = user.login;
      // The account's GitHub "noreply" address: commits are credited to the account without showing a real address.
      const email = `${user.id}+${user.login}@users.noreply.github.com`;
      const remote = `https://github.com/${owner}/${repo}.git`;
      const url = `https://${owner.toLowerCase()}.github.io/${repo}/${job.slug}/`;
      // git reads these four before any setting, so no setting and nothing inherited can put another name or address on a commit.
      gitEnv = { ...baseEnv, GIT_AUTHOR_NAME: COMMIT_NAME, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: COMMIT_NAME, GIT_COMMITTER_EMAIL: email };

      // ---- our clone of the apps repo ----
      mkdirSync(paths.pagesClone, { recursive: true, mode: 0o700 });
      const cloneDir = path.join(paths.pagesClone, repo);
      // Only one deliver runs at a time, so a half-made clone found here was left by a run that was killed.
      for (const name of readdirSync(paths.pagesClone)) {
        if (name.startsWith(TEMP_CLONE_PREFIX)) removeTree(path.join(paths.pagesClone, name));
      }

      /** Rename the clone out of the way. It is never deleted: whatever is wrong with it, a person may want to look. */
      const setAside = (why: string) => {
        const stamp = now().toISOString().replace(/[-:.]/g, "").slice(0, 15);
        try {
          renameSync(cloneDir, path.join(paths.pagesClone, `${repo}.aside-${stamp}-${randomBytes(3).toString("hex")}`));
        } catch {
          throw new PublishStop("Our copy of the apps repo is not usable and could not be moved out of the way.");
        }
        logger.warn("our copy of the apps repo was not usable; it was set aside and a fresh copy will be made", { why });
      };
      /** Clone into a temporary folder and give it its real name only once the clone is complete. */
      const cloneFresh = async () => {
        const temp = path.join(paths.pagesClone, `${TEMP_CLONE_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`);
        try {
          await must("git clone", "Could not copy the apps repo from GitHub.", "git", ["clone", remote, temp], paths.pagesClone, NETWORK_GIT_TIMEOUT_MS);
          renameSync(temp, cloneDir);
        } catch (error) {
          // Our own temporary folder, made a moment ago.
          removeTree(temp);
          if (error instanceof PublishStop || error instanceof PublishStopped) throw error;
          throw new PublishStop("Could not copy the apps repo from GitHub.");
        }
      };

      // An existing clone is built on only if it is whole: a real folder with a .git, no lock
      // files from a killed git, at least one commit, and an origin.
      let fresh = false;
      let whyUnusable: string | null = null;
      let found;
      try {
        found = lstatSync(cloneDir);
      } catch {
        found = null;
      }
      if (found !== null) {
        const gitDir = path.join(cloneDir, ".git");
        let gitDirIsFolder = false;
        try {
          gitDirIsFolder = found.isDirectory() && lstatSync(gitDir).isDirectory();
        } catch {
          gitDirIsFolder = false;
        }
        if (!gitDirIsFolder) whyUnusable = "not a git clone";
        else if (hasStaleLocks(gitDir)) whyUnusable = "left locked by a git that was killed";
        else if (!(await tool("git rev-parse HEAD", "git", ["rev-parse", "--verify", "--quiet", "HEAD"], cloneDir, LOCAL_GIT_TIMEOUT_MS)).ok) whyUnusable = "no commits (a clone that was cut off)";
        else {
          const origin = await tool("git remote get-url", "git", ["remote", "get-url", "origin"], cloneDir, LOCAL_GIT_TIMEOUT_MS);
          if (!origin.ok) whyUnusable = "no origin";
          else if (origin.stdout.trim() !== remote) throw new PublishStop("Our copy of the apps repo points at a different repo than the settings name.");
        }
        if (whyUnusable !== null) setAside(whyUnusable);
      }
      if (found === null || whyUnusable !== null) {
        await cloneFresh();
        fresh = true;
      }

      /**
       * Bring the clone to exactly what GitHub has on main, dropping whatever an earlier run that
       * was cut off left behind (a half-written folder, a commit that was never pushed). Returns
       * the commit main is at, or null when GitHub has no main branch. False: a local command failed.
       */
      const syncWithGitHub = async (): Promise<{ ok: true; mainAt: string | null } | { ok: false }> => {
        const head = await tool("git rev-parse origin/main", "git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], cloneDir, LOCAL_GIT_TIMEOUT_MS);
        if (!head.ok) return { ok: true, mainAt: null };
        const mainAt = head.stdout.trim();
        if (!/^[0-9a-f]{40,64}$/.test(mainAt)) return { ok: false };
        for (const [what, args] of [
          ["git symbolic-ref", ["symbolic-ref", "HEAD", "refs/heads/main"]],
          ["git reset", ["reset", "--hard", "origin/main"]],
          ["git clean", ["clean", "-fdx"]],
        ] as const) {
          if (!(await tool(what, "git", [...args], cloneDir, LOCAL_GIT_TIMEOUT_MS)).ok) return { ok: false };
        }
        return { ok: true, mainAt };
      };

      if (!fresh) await must("git fetch", "Could not update our copy of the apps repo from GitHub.", "git", ["fetch", "--prune", "origin"], cloneDir, NETWORK_GIT_TIMEOUT_MS);
      let synced = await syncWithGitHub();
      if (!synced.ok && !fresh) {
        // Something is wrong inside our copy, not on GitHub: start over from a fresh one, once.
        setAside("could not be brought to what GitHub has");
        await cloneFresh();
        fresh = true;
        synced = await syncWithGitHub();
      }
      if (!synced.ok) throw new PublishStop("Our copy of the apps repo could not be cleaned up.");
      let mainAt = synced.mainAt;

      if (mainAt === null) {
        // GitHub has no main branch. Only a repo with nothing in it at all gets its first commit
        // from us: a root commit next to existing history could never be pushed without force.
        const refs = await must("git ls-remote", "Could not ask GitHub what the apps repo holds.", "git", ["ls-remote", "origin"], cloneDir, NETWORK_GIT_TIMEOUT_MS);
        if (refs.trim() !== "") throw new PublishStop("The apps repo on GitHub has no main branch although it is not empty. Overnight does not create one.");
        const localCommits = (await tool("git rev-parse HEAD", "git", ["rev-parse", "--verify", "--quiet", "HEAD"], cloneDir, LOCAL_GIT_TIMEOUT_MS)).ok;
        if (localCommits) {
          // A first commit from an earlier try that was never pushed. It must not ride along.
          if (fresh) throw new PublishStop("A fresh copy of the empty apps repo was not empty.");
          setAside("holds commits that GitHub does not have");
          await cloneFresh();
          fresh = true;
          synced = await syncWithGitHub();
          if (!synced.ok) throw new PublishStop("Our copy of the apps repo could not be cleaned up.");
          mainAt = synced.mainAt;
        }
        if (mainAt === null) await must("git symbolic-ref", "Our copy of the apps repo could not be set up.", "git", ["symbolic-ref", "HEAD", "refs/heads/main"], cloneDir);
      }
      // Belt and braces next to the environment variables: the clone's own settings say the same.
      await must("git config user.name", "Our copy of the apps repo could not be set up.", "git", ["config", "user.name", COMMIT_NAME], cloneDir);
      await must("git config user.email", "Our copy of the apps repo could not be set up.", "git", ["config", "user.email", email], cloneDir);

      // ---- the files: .nojekyll at the root, and <slug>/ replaced by a plain copy of dist ----
      const target = path.join(cloneDir, job.slug);
      if (path.dirname(path.resolve(target)) !== path.resolve(cloneDir)) throw new PublishStop("Refusing to publish outside our copy of the apps repo.");
      let existing;
      try {
        existing = lstatSync(target);
      } catch {
        existing = null;
      }
      if (existing !== null) {
        if (!existing.isDirectory()) throw new PublishStop("The apps repo already has something that is not a folder under this app's name.");
        // Only ever replace a folder that this same idea published. That is also what makes a
        // publish safe to repeat: a version an interrupted run already pushed carries this id.
        let previous: z.infer<typeof markerFileSchema> | null = null;
        try {
          const markerPath = path.join(target, MARKER_FILE);
          if (lstatSync(markerPath).isFile()) previous = markerFileSchema.parse(JSON.parse(readFileSync(markerPath, "utf8")));
        } catch {
          previous = null;
        }
        if (previous?.id !== job.ideaId) throw new PublishStop("The apps repo already has a different app under this folder name.");
        logger.info("replacing the version of this app that is already in the apps repo");
      }

      const notCommitted = "The new version could not be committed.";
      let copied;
      try {
        // Without .nojekyll GitHub Pages drops files whose names start with "_" (spike 7).
        const noJekyll = path.join(cloneDir, ".nojekyll");
        if (!existsSync(noJekyll)) writeFileSync(noJekyll, "");
        rmSync(target, { recursive: true, force: true });
        copied = copyPlainTree(job.distDir, target, "The built app (dist)", { maxFiles: DIST_MAX_FILES, maxBytes: DIST_MAX_BYTES, refuseNames: DIST_REFUSE_NAMES });
        if (!copied.ok) throw new PublishStop(copied.reason);
        if (!existsSync(path.join(target, "index.html"))) throw new PublishStop("The built app has no index.html.");
        if (scanForPrivateStrings(target, await privateStrings()).filesWithHits > 0) {
          throw new PublishStop("The built app contains this computer's name or the path of its home folder, which must not be published.");
        }
        writeFileSync(path.join(target, MARKER_FILE), `${JSON.stringify({ id: job.ideaId, marker: job.marker })}\n`);
        const wanted = readTree(target);

        // ---- stage, and make sure what is staged is exactly what was copied ----
        await must("git add", notCommitted, "git", ["add", "-A", "--", job.slug, ".nojekyll"], cloneDir);
        const status = await must("git status", notCommitted, "git", ["status", "--porcelain", "--ignored", "--", job.slug], cloneDir);
        if (status.split("\n").some((line) => line.startsWith("!!"))) {
          throw new PublishStop("The apps repo's ignore rules would leave some of the app's files out, so nothing was published.");
        }
        const staged = await must("git ls-files", notCommitted, "git", ["ls-files", "-s", "-z", "--", job.slug], cloneDir);
        const entries = staged.split("\0").filter((entry) => entry !== "");
        let same = entries.length === wanted.size && wanted.size === copied.files + 1;
        for (const entry of entries) {
          // "<mode> <id> <stage>\t<path>"
          const match = /^\d+ ([0-9a-f]{40}|[0-9a-f]{64}) \d\t(.+)$/s.exec(entry);
          const content = match ? wanted.get((match[2] ?? "").slice(job.slug.length + 1).normalize("NFC")) : undefined;
          if (!match || content === undefined || blobId(content, match[1]?.length === 64 ? "sha256" : "sha1") !== match[1]) {
            same = false;
            break;
          }
        }
        if (!same) throw new PublishStop("The files about to be published did not match the files that were tested, so nothing was published.");

        // ---- commit, check whose name is on it and what it sits on, then push (never forced) ----
        await must("git commit", notCommitted, "git", ["commit", "-m", `Publish ${job.slug}`], cloneDir);
        const made = (await must("git log", notCommitted, "git", ["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%P"], cloneDir)).split("\n").map((line) => line.trim());
        if (made[0] !== COMMIT_NAME || made[1] !== email || made[2] !== COMMIT_NAME || made[3] !== email) {
          throw new PublishStop("The new version's commit did not carry Overnight's GitHub no-reply address, so it was not pushed.");
        }
        if ((made[4] ?? "") !== (mainAt ?? "")) throw new PublishStop("The new version's commit does not follow what GitHub has, so it was not pushed.");
        pushed = true;
        const push = await tool("git push", "git", ["push", "-u", "origin", "main"], cloneDir, NETWORK_GIT_TIMEOUT_MS);
        if (!push.ok) {
          // A push that was refused changed nothing on GitHub. One that ran out of time may have.
          if (!push.timedOut) pushed = false;
          throw new PublishStop("Could not push the new version to GitHub.");
        }
      } catch (error) {
        // Put our copy back the way GitHub has it, so that a half-written folder or an unpushed
        // commit cannot go up with a later app's publish. Best effort: the next publish does it again.
        if (mainAt !== null) await tool("git reset after a failed publish", "git", ["reset", "--hard", "origin/main"], cloneDir, LOCAL_GIT_TIMEOUT_MS, true);
        await tool("git clean after a failed publish", "git", ["clean", "-fdx"], cloneDir, LOCAL_GIT_TIMEOUT_MS, true);
        throw error;
      }
      const pushedAt = now().getTime();
      logger.info("pushed a build to the apps repo", { files: copied.files, bytes: copied.bytes });

      // ---- wait until GitHub Pages serves THIS build ----
      const markerUrl = `${url}${MARKER_FILE}`;
      const maxLooks = Math.max(1, Math.ceil(liveTimeoutMs / Math.max(1, pollMs)) + 1);
      for (let look = 1; look <= maxLooks; look += 1) {
        stopIfAsked();
        try {
          const limit = AbortSignal.timeout(FETCH_TIMEOUT_MS);
          const response = await fetchFn(`${markerUrl}?cb=${pushedAt}-${look}`, { signal: signal === undefined ? limit : AbortSignal.any([signal, limit]), cache: "no-store" });
          if (response.status === 200) {
            const served = markerFileSchema.safeParse(JSON.parse((await response.text()).slice(0, 10_000)));
            if (served.success && served.data.id === job.ideaId && served.data.marker === job.marker) {
              const liveAfterMs = Math.max(0, now().getTime() - pushedAt);
              logger.info("the new version is live", { liveAfterMs, looks: look });
              return { ok: true, url, liveAfterMs, confirmedLive: true };
            }
          }
        } catch {
          // Not there yet, not JSON yet, or the network hiccuped: look again.
        }
        stopIfAsked();
        if (look === maxLooks || now().getTime() - pushedAt + pollMs > liveTimeoutMs) break;
        await sleepUnlessStopped(pollMs, signal);
      }
      // The wait ran out. Being stopped comes first: that has its own answer (below), as before.
      stopIfAsked();
      // The push itself went through and nothing else is wrong, so this is not a failed publish:
      // GitHub Pages usually serves a new version within a minute but sometimes takes much
      // longer. We say exactly what we know: pushed, link known, not seen live.
      const waitedMs = Math.max(0, now().getTime() - pushedAt);
      logger.warn("the new version was pushed but was not seen live before the wait ran out", { waitedMs, limitMs: liveTimeoutMs });
      return { ok: true, url, liveAfterMs: null, confirmedLive: false, waitedMs };
    } catch (error) {
      const wasPushed = pushed ? { pushed: true as const } : {};
      if (error instanceof PublishStopped || signal?.aborted === true) {
        logger.warn("publishing was stopped before it finished", { pushed });
        return { ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true, ...wasPushed };
      }
      if (error instanceof PublishStop) return { ok: false, reason: error.message, ...wasPushed };
      logger.error("publishing stopped on an unexpected error", { error: errorSummary(error) });
      return { ok: false, reason: "Publishing could not be completed because of an unexpected error.", ...wasPushed };
    }
  }

  return { publish };
}

/** Wait `ms`, or until the stop signal fires, whichever comes first. */
function sleepUnlessStopped(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}
