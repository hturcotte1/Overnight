// The verifier: decides whether a built app may be published.
//
// An AI agent wrote the app, so its code is run only inside our own macOS sandbox
// (../sandbox/deliver.sb): installing its packages, building it, serving it and testing it in a
// browser. What we do ourselves, with the user's full rights, never follows a link and never
// trusts a size or a result the app's own code could have written.
//
// Three rules keep one step from deciding the outcome of a later one:
//   - Every sandboxed command gets temp and results folders of its own, made fresh for it.
//   - After the install and the build, everything they wrote counts as hostile. Only dist/ is
//     carried forward: moved out of their reach by a rename, then copied by us as plain files.
//   - Our own contract test (which also takes the screenshots) runs in folders that no
//     agent-written code was ever allowed to write, from a harness folder that holds our files
//     only. The app's own smoke test gets a second harness folder and runs afterwards.
// A sandboxed program may write only the folders it was started with, and only inside a "box":
// a folder that we alone can create. Two things follow from the box:
//   - While a step runs, its box is read-only (mode 0500). The sandbox lets a program replace the
//     very folder it may write (move it aside, put a link to somewhere else in its place: tried on
//     Oct 10, 2026, it works), and our own code would then follow that link with the user's full
//     rights. With the box read-only nothing in it can be moved, removed or added, and the
//     sandbox does not let the program change the box itself. Each folder is also checked
//     afterwards to be the one we made.
//   - Renaming the box when its steps are done takes those folders away for good, also from a
//     program that managed to stay running (see remove-tree.ts).
//
// Inside the run folder:
//   logs/              what each step printed, for debugging (no sandbox can see it)
//   site/              OUR copy of dist, made after the build: what is tested is what is
//                      published, and no sandbox can change it
//   harness-contract/  our static server and contract test (read-only in the sandbox)
//   harness-smoke/     our static server and settings plus the app's own smoke test (read-only)
//   build/             box for install and build: app/ (a clean copy of the workspace) and one
//                      scratch folder per command
//   contract/, smoke/  boxes for the two browser steps: an empty work folder and a scratch folder
//   dist-built/        dist as the build left it, after the rename and before our copy
// Only logs/ and site/ are left when verify() returns.
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorSummary } from "@overnight/core";
import type { DataPaths, Logger } from "@overnight/core";
import { z } from "zod";
import { judgeContract, parseContractOutput } from "./contract.ts";
import { findFreePort } from "./free-port.ts";
import { copyPlainTree, DIST_REFUSE_NAMES } from "./plain-copy.ts";
import { localPrivateStrings, scanForPrivateStrings } from "./private-scan.ts";
import { startRegistryProxy } from "./registry-proxy.ts";
import type { RegistryProxy } from "./registry-proxy.ts";
import { moveAside, removeTree } from "./remove-tree.ts";
import { runCommand } from "./run-command.ts";
import { realDir, SANDBOX_EXEC, sandboxCommand, sandboxEnv, SandboxSetupError } from "./sandbox.ts";
import type { SandboxPlaces, SandboxPorts } from "./sandbox.ts";
import type { CommandResult, CommandRunner, Verifier, VerifyChecks, VerifyJob, VerifyResult } from "./types.ts";

const MB = 1024 * 1024;
const MINUTE = 60_000;

export interface VerifyLimits {
  sourceMaxFiles: number;
  sourceMaxBytes: number;
  distMaxFiles: number;
  distMaxBytes: number;
  /** The app's tests folder, copied next to our Playwright. */
  testsMaxFiles: number;
  testsMaxBytes: number;
  screenshotMaxBytes: number;
  /** How many pixels wider than a 390-pixel phone the page may be before that counts as "does not fit". */
  phoneOverflowAllowedPx: number;
  installTimeoutMs: number;
  registryInstallTimeoutMs: number;
  buildTimeoutMs: number;
  contractTimeoutMs: number;
  appSmokeTimeoutMs: number;
}

export const DEFAULT_VERIFY_LIMITS: VerifyLimits = {
  sourceMaxFiles: 2_000,
  sourceMaxBytes: 50 * MB,
  distMaxFiles: 500,
  distMaxBytes: 20 * MB,
  testsMaxFiles: 50,
  testsMaxBytes: 2 * MB,
  screenshotMaxBytes: 15 * MB,
  phoneOverflowAllowedPx: 8,
  installTimeoutMs: 5 * MINUTE,
  registryInstallTimeoutMs: 8 * MINUTE,
  buildTimeoutMs: 5 * MINUTE,
  contractTimeoutMs: 3 * MINUTE,
  appSmokeTimeoutMs: 4 * MINUTE,
};

/** Where the tools the verifier needs live on this Mac. Worked out at run time; tests override them. */
export interface VerifierPlaces {
  home: string;
  /** The node_modules folder that holds our Playwright. */
  toolsDir: string;
  /** Playwright's browser cache. */
  browsersDir: string;
  /** The shared npm cache, used read-only. */
  npmCacheDir: string;
  profileFile: string;
  /** Our harness sources (src/harness). They are copied into each run folder. */
  harnessSourceDir: string;
  sandboxExec: string;
}

export interface SandboxedVerifierOptions {
  paths: DataPaths;
  logger: Logger;
  /** The folder holding the `node` and `npm` to run the app with. Default: the Node running us. */
  nodeBinDir?: string;
  run?: CommandRunner;
  limits?: Partial<VerifyLimits>;
  places?: Partial<VerifierPlaces>;
  findFreePort?: () => Promise<number>;
  startRegistryProxy?: () => Promise<RegistryProxy>;
  /** The strings that name this Mac or its owner and must not be published. Default: asked of the system. */
  privateStrings?: () => Promise<string[]>;
  /** Default: process.platform. The sandbox exists on macOS only. */
  platform?: string;
}

/** Folders of a workspace that are never copied: they are rebuilt, or are not part of the app. */
export const SOURCE_SKIP_NAMES = ["node_modules", "dist", ".git", "test-results"] as const;

/** Our own files only. Nothing an agent wrote is ever put in the folder the contract test runs from. */
const CONTRACT_HARNESS_FILES = ["static-server.ts", "serve-and-test.ts", "contract.spec.ts", "contract.config.ts"] as const;
/** The harness for the app's own smoke test: our server and our settings, with the app's tests folder next to them. */
const SMOKE_HARNESS_FILES = ["static-server.ts", "serve-and-test.ts", "app-smoke.config.ts"] as const;

/** Why a verification ended early when Overnight was told to stop. */
export const VERIFY_STOPPED_REASON = "Verification was stopped before it finished.";
const NOT_CONFIRMED_GONE = "Overnight could not confirm that every program started while checking the app had ended, so the check was abandoned.";
const FOLDER_REPLACED = "A folder Overnight uses to check the app was replaced while the app's code ran, so the check was abandoned.";

/** serve-and-test.ts exits with this when our own server could not take its port. */
const EXIT_SERVER_FAILED = 97;

const STEP_LOG_KEEP_BYTES = 200 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IDEA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

const packageJsonSchema = z.looseObject({ type: z.string().optional(), scripts: z.record(z.string(), z.unknown()).optional() });

/** Thrown inside verify() to stop with a reason for the wearer. Never carries tool output. */
class VerifyStop extends Error {
  readonly step: string;
  constructor(step: string, reason: string) {
    super(reason);
    this.step = step;
  }
}

/** Thrown inside verify() when the stop signal has fired. */
class VerifyStopped extends Error {}

/** A folder only we can create, holding the folders that sandboxed steps may write. */
interface Box {
  dir: string;
  /** False once the box has been taken away (renamed out of every sandbox's reach). */
  open: boolean;
}

/** What to say when a step goes wrong in one of the ways every step can. */
interface StepWords {
  /** The sandbox itself could not be started. */
  start: string;
  /** The step ran into its time limit. */
  slow: string;
  /** The step left a program running outside its own process group. */
  stray: string;
}

function defaultPlaces(): VerifierPlaces {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Our own Playwright, wherever npm put it: <somewhere>/node_modules/@playwright/test/package.json.
  const playwrightManifest = createRequire(import.meta.url).resolve("@playwright/test/package.json");
  const home = homedir();
  return {
    home,
    toolsDir: path.resolve(path.dirname(playwrightManifest), "..", ".."),
    browsersDir: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(home, "Library", "Caches", "ms-playwright"),
    npmCacheDir: path.join(home, ".npm"),
    profileFile: path.resolve(here, "..", "sandbox", "deliver.sb"),
    harnessSourceDir: path.join(here, "harness"),
    sandboxExec: SANDBOX_EXEC,
  };
}

function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / MINUTE));
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}

/** Copy one file we expect to be a plain PNG that the sandboxed browser wrote. Never follows a link. */
function copyScreenshot(from: string, to: string, maxBytes: number): boolean {
  let fd: number;
  try {
    fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size < PNG_SIGNATURE.length || stat.size > maxBytes) return false;
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const count = readSync(fd, data, read, data.length - read, null);
      if (count === 0) break;
      read += count;
    }
    if (read !== data.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
    rmSync(to, { force: true });
    writeFileSync(to, data, { mode: 0o600, flag: "wx" });
    return true;
  } finally {
    closeSync(fd);
  }
}

export function createSandboxedVerifier(options: SandboxedVerifierOptions): Verifier {
  const { paths } = options;
  const run = options.run ?? runCommand;
  const limits: VerifyLimits = { ...DEFAULT_VERIFY_LIMITS, ...options.limits };
  const pickPort = options.findFreePort ?? findFreePort;
  const startProxy = options.startRegistryProxy ?? (() => startRegistryProxy());
  const privateStrings = options.privateStrings ?? localPrivateStrings;
  const platform = options.platform ?? process.platform;

  async function verify(job: VerifyJob): Promise<VerifyResult> {
    const logger = options.logger.child({ ideaId: job.ideaId });
    const signal = job.signal;
    const startedAt = Date.now();
    const checks: VerifyChecks = {};
    /** Every box made so far. Whatever is still open at the end is taken away then. */
    const boxes: Box[] = [];
    /** Throwaway folders to delete at the end. None of them is at a path a sandbox may write. */
    const trash: string[] = [];

    const stopIfAsked = () => {
      if (signal?.aborted) throw new VerifyStopped();
    };

    const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const from = Date.now();
      try {
        return await work();
      } finally {
        checks[`${name}Ms`] = Date.now() - from;
      }
    };

    try {
      stopIfAsked();
      if (!IDEA_ID.test(job.ideaId)) throw new VerifyStop("setup", "The idea's id cannot be used as a file name.");
      if (platform !== "darwin") throw new VerifyStop("setup", "Verification needs the macOS sandbox, which this computer does not have.");

      // ---- where everything is, as real paths ----
      const places: VerifierPlaces = { ...defaultPlaces(), ...options.places };
      if (!existsSync(places.sandboxExec)) throw new VerifyStop("setup", "Verification needs the macOS sandbox (sandbox-exec), which is missing on this Mac.");
      if (!existsSync(places.profileFile)) throw new VerifyStop("setup", "Overnight's sandbox rules file is missing.");
      const nodeBin = realDir(options.nodeBinDir ?? path.dirname(process.execPath), "Node");
      if (!existsSync(path.join(nodeBin, "node")) || !existsSync(path.join(nodeBin, "npm"))) throw new VerifyStop("setup", "Node and npm were not found where Overnight expected them.");
      const toolsDir = realDir(places.toolsDir, "Overnight's copy of Playwright");
      if (!existsSync(path.join(toolsDir, "@playwright", "test", "cli.js"))) throw new VerifyStop("setup", "Overnight's copy of Playwright is missing.");
      const browsersDir = realDir(places.browsersDir, "Playwright's browser");
      if (!readdirSync(browsersDir).some((name) => name.startsWith("chromium_headless_shell-"))) {
        throw new VerifyStop("setup", "Playwright's headless browser is not installed on this Mac.");
      }

      if (!path.isAbsolute(job.runDir)) throw new VerifyStop("setup", "The run folder must be a full path.");
      mkdirSync(job.runDir, { recursive: true, mode: 0o700 });
      if (readdirSync(job.runDir).length > 0) throw new VerifyStop("setup", "The run folder is not empty.");
      const here = realDir(job.runDir, "The run folder");
      const logsDir = path.join(here, "logs");
      const siteDir = path.join(here, "site");
      const contractHarness = path.join(here, "harness-contract");
      const smokeHarness = path.join(here, "harness-smoke");
      const distBuilt = path.join(here, "dist-built");
      for (const dir of [logsDir, siteDir, contractHarness, smokeHarness]) mkdirSync(dir, { mode: 0o700 });
      trash.push(contractHarness, smokeHarness);

      /** A new box. Only our own code, outside every sandbox, can create or rename one. */
      const openBox = (name: string): Box => {
        const box: Box = { dir: path.join(here, name), open: true };
        mkdirSync(box.dir, { mode: 0o700 });
        boxes.push(box);
        return box;
      };
      /**
       * Take a box away: after the rename no sandboxed program can write what is in it any more,
       * whether it is still running or not. Returns where the box is now.
       */
      const sealBox = (box: Box): string => {
        if (!box.open) return box.dir;
        const moved = moveAside(box.dir);
        if (moved === null) throw new Error("A run folder disappeared while it was in use.");
        box.open = false;
        box.dir = moved;
        trash.push(moved);
        // Out of every sandbox's reach now, so it can be made writable again for the clean-up.
        chmodSync(moved, 0o700);
        return moved;
      };
      /** Which folder each sandbox-writable path was when we made it. */
      const made = new Map<string, { dev: number; ino: number }>();
      const remember = (dir: string) => {
        const stat = lstatSync(dir);
        made.set(dir, { dev: stat.dev, ino: stat.ino });
      };
      /** True when the path still holds the very folder we made there: not a link, not another folder moved into its place. */
      const stillOurs = (dir: string): boolean => {
        try {
          const stat = lstatSync(dir);
          const was = made.get(dir);
          return was !== undefined && stat.isDirectory() && stat.dev === was.dev && stat.ino === was.ino;
        } catch {
          return false;
        }
      };

      // The shared npm cache is used read-only. Without one, every install gets an empty cache of
      // its own, the offline install fails with ENOTCACHED, and that sends us to the registry.
      const sharedCache = existsSync(places.npmCacheDir) ? realDir(places.npmCacheDir, "The npm cache") : null;
      const common = {
        home: realDir(places.home, "The home folder"),
        dataDir: realDir(paths.root, "Overnight's data folder"),
        siteDir,
        nodeDir: path.dirname(nodeBin),
        toolsDir,
        browsersDir,
      };

      let commandCount = 0;
      /**
       * Run one command inside the sandbox, with temp and results folders made fresh for it, keep
       * what it printed in logs/, and never log it. When it returns, the command and everything
       * it is known to have started are dead.
       */
      const sandboxed = async (spec: {
        /** Names the log file and the scratch folder. */
        step: string;
        /** The part of the verification this belongs to: what `failedStep` says if it goes wrong here. */
        stage: string;
        box: Box;
        /** The one folder, besides its scratch folder, that the command may write. */
        workspace: string;
        harnessDir: string;
        cwd: string;
        argv: string[];
        timeoutMs: number;
        ports?: Partial<SandboxPorts>;
        env?: (scratch: string) => Record<string, string>;
        /** Give npm a cache of its own that it may write, instead of the shared read-only one. */
        ownNpmCache?: boolean;
        /** A browser step: Playwright gives the browser a process group of its own, which is expected. */
        browser?: boolean;
      }): Promise<{ result: CommandResult; scratch: string }> => {
        stopIfAsked();
        commandCount += 1;
        const scratch = path.join(spec.box.dir, `scratch-${commandCount}-${spec.step}`);
        chmodSync(spec.box.dir, 0o700);
        for (const dir of [scratch, path.join(scratch, "tmp"), path.join(scratch, "out"), path.join(scratch, "npm-cache")]) mkdirSync(dir, { mode: 0o700 });
        remember(scratch);
        // Read-only while the step runs: nothing in the box can be moved, removed or put in its place.
        chmodSync(spec.box.dir, 0o500);
        // Checked once the box is locked again, so that what is checked is what the step gets.
        if (!stillOurs(spec.workspace)) throw new VerifyStop(spec.stage, FOLDER_REPLACED);
        const stepPlaces: SandboxPlaces = {
          ...common,
          workspace: spec.workspace,
          runDir: scratch,
          harnessDir: spec.harnessDir,
          npmCache: spec.ownNpmCache === true || sharedCache === null ? path.join(scratch, "npm-cache") : sharedCache,
        };
        const ports = { port: spec.ports?.port ?? null, proxyPort: spec.ports?.proxyPort ?? null };
        const { command, args } = sandboxCommand(places.profileFile, stepPlaces, ports, spec.argv, places.sandboxExec);
        const result = await run(command, args, {
          cwd: spec.cwd,
          env: sandboxEnv(stepPlaces, spec.env?.(scratch)),
          timeoutMs: spec.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
          // The box was made for this run, so anything still at home in it afterwards came from the step.
          track: { expectUnder: spec.browser === true ? [browsersDir] : [], livesUnder: [spec.box.dir] },
        });
        try {
          const left = result.leftovers;
          const leftText = left === undefined ? "not tracked" : `escaped=${left.escaped} expected=${left.expected} unconfirmed=${left.unconfirmed}`;
          const text = `exit=${result.exitCode} timedOut=${result.timedOut} stopped=${result.stopped === true} leftovers: ${leftText}\n--- stdout\n${result.stdout.slice(-STEP_LOG_KEEP_BYTES)}\n--- stderr\n${result.stderr.slice(-STEP_LOG_KEEP_BYTES)}\n`;
          writeFileSync(path.join(logsDir, `${spec.step}.log`), text, { mode: 0o600 });
        } catch {
          // The step log is a debugging aid only.
        }
        logger.debug("sandboxed step finished", { step: spec.step, exitCode: result.exitCode, timedOut: result.timedOut, escaped: result.leftovers?.escaped ?? 0, unconfirmed: result.leftovers?.unconfirmed ?? false });
        if (result.stopped === true) throw new VerifyStopped();
        stopIfAsked();
        // Before our own code reads anything the step wrote: are its folders still the ones we made?
        if (!stillOurs(spec.workspace) || !stillOurs(scratch)) {
          logger.error("a folder a sandboxed step may write was replaced while the step ran", { step: spec.step });
          throw new VerifyStop(spec.stage, FOLDER_REPLACED);
        }
        return { result, scratch };
      };

      /** The ways every step can go wrong, checked in the order that gives the most useful reason. */
      const settle = (step: string, result: CommandResult, words: StepWords) => {
        if (result.error !== undefined) throw new VerifyStop(step, words.start);
        if (result.timedOut) throw new VerifyStop(step, words.slow);
        const left = result.leftovers;
        if (left !== undefined && (left.escaped > 0 || left.unconfirmed)) {
          checks.leftoverPrograms = left.escaped;
          logger.warn("a sandboxed step left something running", { step, escaped: left.escaped, unconfirmed: left.unconfirmed });
          throw new VerifyStop(step, left.escaped > 0 ? words.stray : NOT_CONFIRMED_GONE);
        }
      };
      const npm = path.join(nodeBin, "npm");
      const node = path.join(nodeBin, "node");

      // ---- 1. a clean copy of the workspace, made by us, outside the sandbox ----
      const buildBox = openBox("build");
      const appDir = path.join(buildBox.dir, "app");
      const source = await timed("copy", async () =>
        copyPlainTree(job.workspace, appDir, "The app's folder", {
          maxFiles: limits.sourceMaxFiles,
          maxBytes: limits.sourceMaxBytes,
          skipNames: SOURCE_SKIP_NAMES,
          keepExecutable: true,
        }),
      );
      checks.sourceFiles = source.files;
      checks.sourceBytes = source.bytes;
      if (!source.ok) throw new VerifyStop("copy", source.reason);
      remember(appDir);

      let appPackage: z.infer<typeof packageJsonSchema>;
      try {
        appPackage = packageJsonSchema.parse(JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")));
      } catch {
        throw new VerifyStop("copy", "The app has no readable package.json.");
      }
      if (!existsSync(path.join(appDir, "package-lock.json"))) throw new VerifyStop("copy", "The app has no package-lock.json, so its packages cannot be installed exactly.");
      if (typeof appPackage.scripts?.build !== "string") throw new VerifyStop("copy", 'The app\'s package.json has no "build" script.');
      const hasAppSmoke = existsSync(path.join(appDir, "tests", "smoke.spec.ts"));
      checks.appSmokePresent = hasAppSmoke;
      if (!hasAppSmoke) throw new VerifyStop("copy", "The app does not ship its smoke test (tests/smoke.spec.ts).");

      // ---- the two harness folders: our files and our Playwright; the app's own tests go in the second one only ----
      for (const [dir, files] of [
        [contractHarness, CONTRACT_HARNESS_FILES],
        [smokeHarness, SMOKE_HARNESS_FILES],
      ] as const) {
        for (const file of files) copyFileSync(path.join(places.harnessSourceDir, file), path.join(dir, file));
        writeFileSync(path.join(dir, "package.json"), '{ "private": true, "type": "module" }\n');
        symlinkSync(toolsDir, path.join(dir, "node_modules"));
      }
      // Copied now, from our clean copy, before any of the app's code has run.
      const appSmokeDir = path.join(smokeHarness, "app-smoke");
      const tests = copyPlainTree(path.join(appDir, "tests"), path.join(appSmokeDir, "tests"), "The app's tests folder", {
        maxFiles: limits.testsMaxFiles,
        maxBytes: limits.testsMaxBytes,
        skipNames: SOURCE_SKIP_NAMES,
      });
      if (!tests.ok) throw new VerifyStop("copy", tests.reason);
      // The test file is read as the same kind of module as in the app.
      writeFileSync(path.join(appSmokeDir, "package.json"), `{ "private": true, "type": "${appPackage.type === "module" ? "module" : "commonjs"}" }\n`);

      // ---- 2. inside the sandbox: install, with no network if the shared cache has everything ----
      const installWords = (limitMs: number): StepWords => ({
        start: "The sandbox could not be started to install the app's packages.",
        slow: `Installing the app's packages took longer than ${minutes(limitMs)} and was stopped.`,
        stray: "Installing the app's packages left a program running in the background, which is not allowed.",
      });
      await timed("install", async () => {
        const offline = await sandboxed({ step: "npm-ci-offline", stage: "install", box: buildBox, workspace: appDir, harnessDir: smokeHarness, cwd: appDir, argv: [npm, "ci", "--offline"], timeoutMs: limits.installTimeoutMs });
        checks.installUsedRegistry = false;
        settle("install", offline.result, installWords(limits.installTimeoutMs));
        if (offline.result.exitCode === 0) return;
        if (!/\bENOTCACHED\b/.test(offline.result.stdout + offline.result.stderr)) throw new VerifyStop("install", "Installing the app's packages (npm ci) failed.");

        // A package is missing from the cache: once more, through our registry-only proxy, with a
        // cache of its own that the sandbox may write.
        checks.installUsedRegistry = true;
        let proxy: RegistryProxy;
        try {
          proxy = await startProxy();
        } catch {
          throw new VerifyStop("install", "A package is missing from the npm cache, and Overnight's registry-only proxy could not start to fetch it.");
        }
        let online;
        try {
          const proxyUrl = `http://127.0.0.1:${proxy.port}`;
          online = await sandboxed({
            step: "npm-ci-registry",
            stage: "install",
            box: buildBox,
            workspace: appDir,
            harnessDir: smokeHarness,
            cwd: appDir,
            argv: [npm, "ci"],
            timeoutMs: limits.registryInstallTimeoutMs,
            ports: { proxyPort: proxy.port },
            ownNpmCache: true,
            env: () => ({ npm_config_proxy: proxyUrl, npm_config_https_proxy: proxyUrl }),
          });
        } finally {
          const counts = await proxy.close();
          checks.registryConnections = counts.allowed;
          checks.registryRefused = counts.refused;
        }
        settle("install", online.result, installWords(limits.registryInstallTimeoutMs));
        if (online.result.exitCode !== 0) throw new VerifyStop("install", "Installing the app's packages (npm ci) failed.");
      });
      checks.installOk = true;

      // ---- inside the sandbox: build ----
      await timed("build", async () => {
        const build = await sandboxed({ step: "npm-run-build", stage: "build", box: buildBox, workspace: appDir, harnessDir: smokeHarness, cwd: appDir, argv: [npm, "run", "build"], timeoutMs: limits.buildTimeoutMs });
        settle("build", build.result, {
          start: "The sandbox could not be started to build the app.",
          slow: `Building the app took longer than ${minutes(limits.buildTimeoutMs)} and was stopped.`,
          stray: "The app's build left a program running in the background, which is not allowed.",
        });
        if (build.result.exitCode !== 0) throw new VerifyStop("build", "The app's build command (npm run build) failed.");
      });
      checks.buildOk = true;

      // ---- 3. dist: moved out of the build's reach, then our own copy, plain files only, within the caps ----
      // From here on everything the install and the build wrote is treated as hostile. The rename
      // puts dist where no sandboxed program may write; taking the box away does the same for
      // the rest (node_modules, caches, temp files), which is never read again.
      let moved = false;
      try {
        if (!stillOurs(appDir)) throw new VerifyStop("dist", FOLDER_REPLACED);
        // The build may have locked the app folder; it is ours and cannot have been swapped (its box is read-only).
        chmodSync(appDir, 0o700);
        if (lstatSync(path.join(appDir, "dist")).isDirectory()) {
          renameSync(path.join(appDir, "dist"), distBuilt);
          trash.push(distBuilt);
          moved = true;
        }
      } catch (error) {
        if (error instanceof VerifyStop) throw error;
        moved = false;
      }
      sealBox(buildBox);
      let hasIndex = false;
      try {
        hasIndex = moved && lstatSync(distBuilt).isDirectory() && lstatSync(path.join(distBuilt, "index.html")).isFile();
      } catch {
        hasIndex = false;
      }
      checks.distHasIndex = hasIndex;
      if (!hasIndex) throw new VerifyStop("dist", "The build did not produce dist/index.html.");
      const dist = copyPlainTree(distBuilt, siteDir, "The built app (dist)", { maxFiles: limits.distMaxFiles, maxBytes: limits.distMaxBytes, refuseNames: DIST_REFUSE_NAMES });
      checks.distFiles = dist.files;
      checks.distBytes = dist.bytes;
      if (!dist.ok) throw new VerifyStop("dist", dist.reason);
      // Everything in site/ becomes public: it must not name this Mac or its owner.
      const privateHits = scanForPrivateStrings(siteDir, await privateStrings()).filesWithHits;
      checks.distNamesThisMac = privateHits > 0;
      if (privateHits > 0) throw new VerifyStop("dist", "The built app contains this computer's name or the path of its home folder, which must not be published.");

      /** Serve our copy of dist and run one of our Playwright configs against it, all inside the sandbox, in a box of its own. */
      const browserStep = async (step: string, box: Box, harnessDir: string, configFile: string, timeoutMs: number, words: StepWords) => {
        const work = path.join(box.dir, "work");
        mkdirSync(work, { mode: 0o700 });
        remember(work);
        for (let attempt = 1; ; attempt += 1) {
          const port = await pickPort();
          const ran = await sandboxed({
            step,
            stage: step,
            box,
            workspace: work,
            harnessDir,
            cwd: harnessDir,
            argv: [node, path.join(harnessDir, "serve-and-test.ts"), siteDir, String(port), path.join(harnessDir, configFile)],
            timeoutMs,
            ports: { port },
            browser: true,
            // Playwright keeps compiled copies of the test files in its cache folder and runs
            // those: the cache must be as fresh, and as much this step's own, as the rest.
            env: (scratch) => ({ SHOT_DIR: path.join(scratch, "out"), PW_OUT: path.join(scratch, "out", "results"), PWTEST_CACHE_DIR: path.join(scratch, "pw-cache") }),
          });
          settle(step, ran.result, words);
          if (ran.result.exitCode !== EXIT_SERVER_FAILED) return ran;
          // Something else took the port between our picking it and the server starting: pick again, once.
          if (attempt === 2) throw new VerifyStop(step, "Overnight's own test server could not start on this Mac.");
        }
      };

      // ---- 4. inside the sandbox: our contract test, from folders no agent-written code could ever write ----
      // Playwright would run any test file it finds under the harness folder, so that folder must
      // hold exactly what we put there. No sandbox may write it; this guards our own later edits.
      const expectedHarness = [...CONTRACT_HARNESS_FILES, "node_modules", "package.json"].sort();
      if (readdirSync(contractHarness).sort().join("\n") !== expectedHarness.join("\n")) throw new Error("The contract test's folder holds something it should not.");
      const contractBox = openBox("contract");
      const contract = await timed("contract", async () => {
        const ran = await browserStep("contract", contractBox, contractHarness, "contract.config.ts", limits.contractTimeoutMs, {
          start: "The sandbox could not be started to test the page.",
          slow: `Testing the page took longer than ${minutes(limits.contractTimeoutMs)} and was stopped.`,
          stray: "Testing the page left a program running that should have ended, so the result cannot be trusted.",
        });
        const measure = parseContractOutput(ran.result.stdout);
        if (measure === null || ran.result.exitCode !== 0) throw new VerifyStop("contract", "The page could not be tested in the browser.");
        const verdict = judgeContract(measure, { phoneOverflowAllowedPx: limits.phoneOverflowAllowedPx });
        Object.assign(checks, verdict.checks);
        if (!verdict.ok) throw new VerifyStop("contract", `The page did not pass Overnight's checks: ${verdict.problems.join("; ")}.`);
        return ran;
      });
      checks.contractOk = true;

      // ---- the two screenshots, copied out by us once the step's folders are out of every sandbox's reach ----
      const shotDir = path.join(sealBox(contractBox), path.basename(contract.scratch), "out");
      mkdirSync(paths.screenshots, { recursive: true, mode: 0o700 });
      const screenshotPhone = path.join(paths.screenshots, `${job.ideaId}.png`);
      const screenshotDesktop = path.join(paths.screenshots, `${job.ideaId}-desktop.png`);
      const plainShotDir = isPlainFolder(shotDir);
      const gotPhone = plainShotDir && copyScreenshot(path.join(shotDir, "phone.png"), screenshotPhone, limits.screenshotMaxBytes);
      const gotDesktop = plainShotDir && copyScreenshot(path.join(shotDir, "desktop.png"), screenshotDesktop, limits.screenshotMaxBytes);
      checks.screenshotsSaved = gotPhone && gotDesktop;
      if (!gotPhone || !gotDesktop) throw new VerifyStop("contract", "The screenshots of the page could not be saved.");

      // ---- inside the sandbox: the app's own smoke test, with our Playwright and our settings ----
      const smokeBox = openBox("smoke");
      await timed("appSmoke", async () => {
        const ran = await browserStep("app-smoke", smokeBox, smokeHarness, "app-smoke.config.ts", limits.appSmokeTimeoutMs, {
          start: "The sandbox could not be started to run the app's own smoke test.",
          slow: `The app's own smoke test took longer than ${minutes(limits.appSmokeTimeoutMs)} and was stopped.`,
          stray: "The app's own smoke test left a program running in the background, which is not allowed.",
        });
        if (ran.result.exitCode !== 0) throw new VerifyStop("app-smoke", "The app's own smoke test (tests/smoke.spec.ts) failed.");
      });
      checks.appSmokeOk = true;
      sealBox(smokeBox);
      stopIfAsked();

      checks.totalMs = Date.now() - startedAt;
      logger.info("verified a built app", { files: dist.files, bytes: dist.bytes, ms: checks.totalMs, usedRegistry: checks.installUsedRegistry === true });
      return { ok: true, distDir: siteDir, screenshotPhone, screenshotDesktop, checks };
    } catch (error) {
      checks.totalMs = Date.now() - startedAt;
      if (error instanceof VerifyStopped || signal?.aborted === true) {
        checks.failedStep = "stopped";
        logger.warn("verification was stopped before it finished", { ms: checks.totalMs });
        return { ok: false, reason: VERIFY_STOPPED_REASON, checks, stopped: true };
      }
      if (error instanceof VerifyStop) {
        checks.failedStep = error.step;
        logger.warn("a built app did not pass verification", { step: error.step, ms: checks.totalMs });
        return { ok: false, reason: error.message, checks };
      }
      checks.failedStep = "unexpected";
      if (error instanceof SandboxSetupError) {
        logger.error("could not set up the sandbox", { error: errorSummary(error) });
        return { ok: false, reason: error.message, checks };
      }
      logger.error("verification stopped on an unexpected error", { error: errorSummary(error) });
      return { ok: false, reason: "Verification could not be completed because of an unexpected error.", checks };
    } finally {
      // First take away every box that is still open (a cheap rename each), so that nothing left
      // running can write there again. Then delete the throwaway folders. site/ and logs/ stay
      // for the publisher and for debugging.
      for (const box of boxes) {
        if (!box.open) continue;
        try {
          const moved = moveAside(box.dir);
          box.open = false;
          if (moved !== null) {
            trash.push(moved);
            chmodSync(moved, 0o700);
          }
        } catch {
          trash.push(box.dir);
        }
      }
      // When we are being stopped there are seconds left, and deleting an app's node_modules can
      // take longer: the folders stay, under names no sandbox can write, for the next run to clear.
      if (signal?.aborted !== true) {
        for (const dir of trash) removeTree(dir);
      }
    }
  }

  return { verify };
}

/** True for a real folder that is its own real path: nothing in the path to it is a link. */
function isPlainFolder(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory() && realpathSync(dir) === dir;
  } catch {
    return false;
  }
}
