// Synthetic test data: the app, its files and everything the fake tools print are made up.
// Nothing here starts a real program: the command runner is a fake that plays npm and Playwright.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPaths, ensureDataDirs, finishedBuildDir } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { CONTRACT_MARKER } from "../src/contract.ts";
import type { ContractMeasure, ViewMeasure } from "../src/contract.ts";
import { createSandboxedVerifier, VERIFY_STOPPED_REASON } from "../src/index.ts";
import type { CommandRunner, Leftovers, TrackOptions, VerifyLimits } from "../src/index.ts";
import { collectingLogger, tempDir, writeTree } from "./helpers.ts";

type RunResult = Awaited<ReturnType<CommandRunner>>;
type Step = "npm-ci-offline" | "npm-ci-registry" | "build" | "contract" | "app-smoke" | "unknown";

interface Call {
  step: Step;
  command: string;
  /** The -D values handed to the sandbox. */
  defines: Record<string, string>;
  profile: string;
  /** What runs inside the sandbox. */
  argv: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  track: TrackOptions | undefined;
}

const PROFILE = fileURLToPath(new URL("../sandbox/deliver.sb", import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("made-up pixels")]);
const IDEA_ID = "idea_20261010_feedc0de";
const MINUTE = 60_000;

const cleanView: ViewMeasure = {
  loaded: true,
  status: 200,
  headingVisible: true,
  visibleTextChars: 120,
  overflowPx: 0,
  requests: 3,
  nonLocalRequests: 0,
  failedRequests: 0,
  consoleErrors: 0,
  pageErrors: 0,
  screenshot: true,
  ms: 800,
};
const contractLine = (measure: ContractMeasure) => `Running 1 test using 1 worker\n\n${CONTRACT_MARKER}${JSON.stringify(measure)}\n  1 passed (2.1s)\n`;
const TIDY: Leftovers = { escaped: 0, expected: 0, unconfirmed: false };
const done = (exitCode: number, stdout = "", stderr = "", leftovers: Leftovers = TIDY): RunResult => ({ stdout, stderr, exitCode, timedOut: false, leftovers });
const timedOut = (): RunResult => ({ stdout: "", stderr: "", exitCode: null, timedOut: true, leftovers: TIDY });
/** Made-up strings standing in for "this Mac's name" and "its home folder". */
const PRIVATE = ["Zebras-MacBook-Pro", "/Users/zebra"];

function parseCall(command: string, args: string[], options: Parameters<CommandRunner>[2]): Call {
  const defines: Record<string, string> = {};
  let i = 0;
  while (args[i] === "-D") {
    const [key, ...rest] = (args[i + 1] ?? "").split("=");
    defines[key ?? ""] = rest.join("=");
    i += 2;
  }
  if (args[i] !== "-f") throw new Error("The sandbox command line has no -f <profile> after its -D values.");
  const profile = args[i + 1] ?? "";
  const argv = args.slice(i + 2);
  const joined = argv.join(" ");
  const step: Step = joined.endsWith("npm ci --offline")
    ? "npm-ci-offline"
    : joined.endsWith("npm ci")
      ? "npm-ci-registry"
      : joined.endsWith("npm run build")
        ? "build"
        : joined.endsWith("contract.config.ts")
          ? "contract"
          : joined.endsWith("app-smoke.config.ts")
            ? "app-smoke"
            : "unknown";
  return { step, command, defines, profile, argv, cwd: options.cwd, env: options.env ?? {}, timeoutMs: options.timeoutMs, signal: options.signal, track: options.track };
}

type Behaviour = Partial<Record<Step, (call: Call) => RunResult | Promise<RunResult>>>;

function makeRig(options: { behaviour?: Behaviour; limits?: Partial<VerifyLimits>; platform?: string; workspaceFiles?: Record<string, string> } = {}) {
  const root = tempDir();
  const paths = dataPaths(path.join(root, "data"));
  ensureDataDirs(paths);
  const nodeBin = path.join(root, "node-install", "bin");
  writeTree(nodeBin, { node: "", npm: "" });
  const toolsDir = path.join(root, "tools", "node_modules");
  writeTree(toolsDir, { "@playwright/test/cli.js": "// made-up\n" });
  const browsersDir = path.join(root, "browsers");
  mkdirSync(path.join(browsersDir, "chromium_headless_shell-1"), { recursive: true });
  const npmCacheDir = path.join(root, "npm-cache");
  mkdirSync(npmCacheDir);
  const home = path.join(root, "home");
  mkdirSync(home);
  const sandboxExec = path.join(root, "sandbox-exec");
  writeFileSync(sandboxExec, "");

  const workspace = path.join(paths.workspaces, IDEA_ID);
  writeTree(
    workspace,
    options.workspaceFiles ?? {
      "package.json": JSON.stringify({ name: "made-up-app", type: "module", scripts: { build: "tsc && vite build" } }),
      "package-lock.json": "{}\n",
      "index.html": "<div id=app></div>\n",
      "src/main.ts": "export {};\n",
      "tests/smoke.spec.ts": "// the app's own made-up test\n",
      "node_modules/vite/index.js": "// never copied\n",
      "dist/index.html": "<h1>stale build from the agent</h1>\n",
      "BUILD_STATUS.json": '{"status":"built"}\n',
    },
  );
  const runDir = path.join(paths.deliverRuns, IDEA_ID);
  /** Where the folders of a run are, by the names the verifier gives them. */
  const at = {
    app: path.join(runDir, "build", "app"),
    buildBox: path.join(runDir, "build"),
    contractBox: path.join(runDir, "contract"),
    smokeBox: path.join(runDir, "smoke"),
    site: path.join(runDir, "site"),
    contractHarness: path.join(runDir, "harness-contract"),
    smokeHarness: path.join(runDir, "harness-smoke"),
    distBuilt: path.join(runDir, "dist-built"),
  };

  const calls: Call[] = [];
  /** What each step saw on disk at the moment it ran. */
  const seen: Record<string, unknown> = {};
  const defaults: Required<Pick<Behaviour, "npm-ci-offline" | "npm-ci-registry" | "build" | "contract" | "app-smoke">> = {
    "npm-ci-offline": () => done(0, "added 20 packages in 313ms\n"),
    "npm-ci-registry": () => done(0, "added 20 packages in 3s\n"),
    build: (call) => {
      writeTree(path.join(call.cwd ?? "", "dist"), { "index.html": "<h1>made-up app</h1>\n", "assets/app.js": "console.log(1)\n" });
      return done(0, "built in 187ms\n");
    },
    contract: (call) => {
      writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
      writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), PNG);
      return done(0, contractLine({ phone: cleanView, desktop: cleanView }));
    },
    "app-smoke": () => done(0, "1 passed (345ms)\n"),
  };
  const run: CommandRunner = async (command, args, runOptions) => {
    const call = parseCall(command, args, runOptions);
    calls.push(call);
    if (call.step === "build") {
      seen.appAtBuild = readdirSync(call.cwd ?? "").sort();
      seen.runDirAtBuild = readdirSync(runDir).sort();
    }
    if (call.step === "contract") {
      const harness = call.defines.HARNESS_DIR ?? "";
      seen.harness = readdirSync(harness).sort();
      seen.toolsLink = readlinkSync(path.join(harness, "node_modules"));
      seen.site = readdirSync(call.defines.SITE_DIR ?? "").sort();
      seen.runDirAtContract = readdirSync(runDir).sort();
      seen.contractWork = readdirSync(call.defines.WORKSPACE ?? "");
      seen.contractScratch = readdirSync(call.defines.RUN_DIR ?? "").sort();
    }
    if (call.step === "app-smoke") {
      const harness = call.defines.HARNESS_DIR ?? "";
      seen.smokeHarness = readdirSync(harness).sort();
      seen.appSmoke = readFileSync(path.join(harness, "app-smoke/tests/smoke.spec.ts"), "utf8");
      seen.appSmokePackage = JSON.parse(readFileSync(path.join(harness, "app-smoke/package.json"), "utf8"));
      seen.runDirAtSmoke = readdirSync(runDir).sort();
    }
    const play = options.behaviour?.[call.step] ?? (call.step === "unknown" ? undefined : defaults[call.step]);
    if (!play) throw new Error(`The fake runner was asked to run something unexpected: ${call.argv.join(" ")}`);
    return play(call);
  };

  let nextPort = 50_001;
  const proxy = { started: 0, closed: 0 };
  const { logger, lines } = collectingLogger();
  const verifier = createSandboxedVerifier({
    paths,
    logger,
    nodeBinDir: nodeBin,
    run,
    platform: options.platform ?? "darwin",
    ...(options.limits ? { limits: options.limits } : {}),
    places: { home, toolsDir, browsersDir, npmCacheDir, profileFile: PROFILE, sandboxExec },
    privateStrings: async () => PRIVATE,
    findFreePort: async () => nextPort++,
    startRegistryProxy: async () => {
      proxy.started += 1;
      return {
        port: 51_000,
        close: async () => {
          proxy.closed += 1;
          return { allowed: 15, refused: 1 };
        },
      };
    },
  });
  /** The call that ran a step (the first one, when a step ran twice). */
  const call = (step: Step): Call => {
    const found = calls.find((entry) => entry.step === step);
    if (!found) throw new Error(`The step ${step} never ran.`);
    return found;
  };
  const verify = (signal?: AbortSignal) => verifier.verify({ ideaId: IDEA_ID, workspace, runDir, ...(signal ? { signal } : {}) });
  return { root, paths, nodeBin, toolsDir, browsersDir, npmCacheDir, home, sandboxExec, workspace, runDir, at, calls, call, seen, proxy, logLines: lines, verifier, verify };
}

describe("the sandboxed verifier: a good app", () => {
  it("runs install, build, our contract test and the app's own test inside the sandbox, in that order", async () => {
    const rig = makeRig();
    const result = await rig.verify();

    expect(result.ok).toBe(true);
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build", "contract", "app-smoke"]);

    const { app, site, contractHarness, smokeHarness } = rig.at;
    const scratch = {
      install: path.join(rig.at.buildBox, "scratch-1-npm-ci-offline"),
      build: path.join(rig.at.buildBox, "scratch-2-npm-run-build"),
      contract: path.join(rig.at.contractBox, "scratch-3-contract"),
      smoke: path.join(rig.at.smokeBox, "scratch-4-app-smoke"),
    };
    const common = {
      HOME: rig.home,
      DATA_DIR: rig.paths.root,
      SITE_DIR: site,
      NODE_DIR: path.dirname(rig.nodeBin),
      TOOLS_DIR: rig.toolsDir,
      PW_BROWSERS: rig.browsersDir,
      NPM_CACHE: rig.npmCacheDir,
    };
    const envFor = (runDir: string) => ({
      HOME: rig.home,
      PATH: `${rig.nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: path.join(runDir, "tmp"),
      NO_COLOR: "1",
      PLAYWRIGHT_BROWSERS_PATH: rig.browsersDir,
      npm_config_cache: rig.npmCacheDir,
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
    });
    const browserEnv = (runDir: string) => ({ ...envFor(runDir), SHOT_DIR: path.join(runDir, "out"), PW_OUT: path.join(runDir, "out", "results"), PWTEST_CACHE_DIR: path.join(runDir, "pw-cache") });
    const npm = path.join(rig.nodeBin, "npm");
    const node = path.join(rig.nodeBin, "node");

    // Every command is the sandbox, with our profile, and nothing else.
    for (const call of rig.calls) {
      expect(call.command).toBe(rig.sandboxExec);
      expect(call.profile).toBe(PROFILE);
    }
    // Install and build: no port of any kind (1 means "none"), the shared npm cache, the app copy
    // as the working folder and the one folder they may write besides their own scratch folder.
    expect(rig.calls[0]).toMatchObject({
      argv: [npm, "ci", "--offline"],
      cwd: app,
      defines: { ...common, WORKSPACE: app, RUN_DIR: scratch.install, HARNESS_DIR: smokeHarness, PORT: "1", PROXY_PORT: "1" },
      env: envFor(scratch.install),
      timeoutMs: 5 * MINUTE,
    });
    expect(rig.calls[1]).toMatchObject({
      argv: [npm, "run", "build"],
      cwd: app,
      defines: { ...common, WORKSPACE: app, RUN_DIR: scratch.build, HARNESS_DIR: smokeHarness, PORT: "1", PROXY_PORT: "1" },
      env: envFor(scratch.build),
      timeoutMs: 5 * MINUTE,
    });
    // The two browser runs: one fresh local port each, served from OUR copy of dist, each from its
    // own harness folder, each with an empty work folder and a scratch folder of its own.
    expect(rig.calls[2]).toMatchObject({
      argv: [node, path.join(contractHarness, "serve-and-test.ts"), site, "50001", path.join(contractHarness, "contract.config.ts")],
      cwd: contractHarness,
      defines: { ...common, WORKSPACE: path.join(rig.at.contractBox, "work"), RUN_DIR: scratch.contract, HARNESS_DIR: contractHarness, PORT: "50001", PROXY_PORT: "1" },
      env: browserEnv(scratch.contract),
      timeoutMs: 3 * MINUTE,
    });
    expect(rig.calls[3]).toMatchObject({
      argv: [node, path.join(smokeHarness, "serve-and-test.ts"), site, "50002", path.join(smokeHarness, "app-smoke.config.ts")],
      cwd: smokeHarness,
      defines: { ...common, WORKSPACE: path.join(rig.at.smokeBox, "work"), RUN_DIR: scratch.smoke, HARNESS_DIR: smokeHarness, PORT: "50002", PROXY_PORT: "1" },
      env: browserEnv(scratch.smoke),
      timeoutMs: 4 * MINUTE,
    });
    // The environment is exactly what we list: nothing of ours is inherited.
    for (const call of rig.calls) expect(Object.keys(call.env).sort()).toEqual([...Object.keys(envFor("")), ...(call.env.SHOT_DIR ? ["SHOT_DIR", "PW_OUT", "PWTEST_CACHE_DIR"] : [])].sort());
    // Everything each command started is hunted down afterwards. Only the browser steps expect
    // processes outside their own group, and only from the browser's own folder.
    expect(rig.calls.map((call) => call.track)).toEqual([
      { expectUnder: [], livesUnder: [rig.at.buildBox] },
      { expectUnder: [], livesUnder: [rig.at.buildBox] },
      { expectUnder: [rig.browsersDir], livesUnder: [rig.at.contractBox] },
      { expectUnder: [rig.browsersDir], livesUnder: [rig.at.smokeBox] },
    ]);
  });

  it("builds from a clean copy: no node_modules, no stale dist, no test results from the agent", async () => {
    const rig = makeRig();
    await rig.verify();
    expect(rig.seen.appAtBuild).toEqual(["BUILD_STATUS.json", "index.html", "package-lock.json", "package.json", "src", "tests"]);
    // The agent's own workspace is never touched.
    expect(readFileSync(path.join(rig.workspace, "dist/index.html"), "utf8")).toContain("stale build");
  });

  it("gives the tests our Playwright and the app's own smoke test, and serves our checked copy of dist", async () => {
    const rig = makeRig();
    await rig.verify();
    expect(rig.seen.harness).toEqual(["contract.config.ts", "contract.spec.ts", "node_modules", "package.json", "serve-and-test.ts", "static-server.ts"]);
    expect(rig.seen.toolsLink).toBe(rig.toolsDir);
    expect(rig.seen.smokeHarness).toEqual(["app-smoke", "app-smoke.config.ts", "node_modules", "package.json", "serve-and-test.ts", "static-server.ts"]);
    expect(rig.seen.appSmoke).toBe("// the app's own made-up test\n");
    expect(rig.seen.appSmokePackage).toMatchObject({ type: "module" });
    expect(rig.seen.site).toEqual(["assets", "index.html"]);
  });

  it("returns our copy of dist, both screenshots, and checks made of yes/no, counts and timings only", async () => {
    const rig = makeRig();
    const result = await rig.verify();
    if (!result.ok) throw new Error(result.reason);

    expect(result.distDir).toBe(path.join(rig.runDir, "site"));
    expect(readFileSync(path.join(result.distDir, "index.html"), "utf8")).toBe("<h1>made-up app</h1>\n");
    expect(result.screenshotPhone).toBe(path.join(rig.paths.screenshots, `${IDEA_ID}.png`));
    expect(result.screenshotDesktop).toBe(path.join(rig.paths.screenshots, `${IDEA_ID}-desktop.png`));
    expect(readFileSync(result.screenshotPhone).equals(PNG)).toBe(true);
    expect(readFileSync(result.screenshotDesktop).equals(PNG)).toBe(true);

    expect(result.checks).toMatchObject({
      sourceFiles: 6,
      appSmokePresent: true,
      installOk: true,
      installUsedRegistry: false,
      buildOk: true,
      distHasIndex: true,
      distFiles: 2,
      distBytes: 36,
      contractOk: true,
      phoneLoaded: true,
      phoneFits: true,
      phoneConsoleErrors: 0,
      desktopLoaded: true,
      screenshotsSaved: true,
      appSmokeOk: true,
    });
    for (const [key, value] of Object.entries(result.checks)) expect(["boolean", "number"], key).toContain(typeof value);
    for (const key of ["copyMs", "installMs", "buildMs", "contractMs", "appSmokeMs", "totalMs"]) expect(result.checks[key], key).toBeTypeOf("number");
  });

  it("afterwards keeps only our copy of dist and the step logs; what the tools printed never reaches the log", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(0, "MADE-UP-TOOL-OUTPUT added 20 packages\n") } });
    await rig.verify();
    expect(readdirSync(rig.runDir).sort()).toEqual(["logs", "site"]);
    expect(readdirSync(path.join(rig.runDir, "logs")).sort()).toEqual(["app-smoke.log", "contract.log", "npm-ci-offline.log", "npm-run-build.log"]);
    expect(readFileSync(path.join(rig.runDir, "logs/npm-ci-offline.log"), "utf8")).toContain("MADE-UP-TOOL-OUTPUT");
    expect(rig.logLines.join("\n")).not.toContain("MADE-UP-TOOL-OUTPUT");
  });
});

describe("the sandboxed verifier: the clean copy", () => {
  it("verifies a finished build kept in built/<id> just like one in workspaces/<id>, only ever reads it, and tells no sandboxed step where it is", async () => {
    const usual = makeRig();
    const usualResult = await usual.verify();

    const rig = makeRig();
    // What the builder does once an idea is recorded as built: one rename, out of the build jobs' reach.
    const sealed = path.join(rig.paths.built, IDEA_ID);
    renameSync(rig.workspace, sealed);
    expect(finishedBuildDir(rig.paths, IDEA_ID)).toBe(sealed);
    /** Every file and folder in the sealed build: its name, its mode and, for a file, what is in it. */
    const snapshot = () =>
      (readdirSync(sealed, { recursive: true }) as string[]).sort().map((name) => {
        const stat = lstatSync(path.join(sealed, name));
        return [name, stat.mode, stat.isFile() ? readFileSync(path.join(sealed, name), "utf8") : null];
      });
    const before = snapshot();
    expect(before.map((entry) => entry[0])).toContain(path.join("dist", "index.html"));

    const result = await rig.verifier.verify({ ideaId: IDEA_ID, workspace: finishedBuildDir(rig.paths, IDEA_ID), runDir: rig.runDir });

    if (!result.ok || !usualResult.ok) throw new Error("Both verifications should have passed.");
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build", "contract", "app-smoke"]);
    // The same clean copy, the same counts and the same site as from a workspace.
    expect(rig.seen.appAtBuild).toEqual(usual.seen.appAtBuild);
    expect(rig.seen.site).toEqual(usual.seen.site);
    for (const key of ["sourceFiles", "sourceBytes", "distFiles", "distBytes", "appSmokePresent", "installOk", "buildOk", "contractOk", "appSmokeOk"]) expect(result.checks[key], key).toBe(usualResult.checks[key]);
    expect(readFileSync(path.join(result.distDir, "index.html"), "utf8")).toBe("<h1>made-up app</h1>\n");
    // The sandbox is given our copy under tmp/deliver, as always. Nothing it is handed names the folder of finished builds.
    for (const call of rig.calls) {
      expect(call.defines.WORKSPACE?.startsWith(`${rig.runDir}${path.sep}`), call.step).toBe(true);
      expect(JSON.stringify([call.defines, call.argv, call.cwd, call.env]), call.step).not.toContain(rig.paths.built);
    }
    // The sealed build is exactly as it was, stale dist and all, and nothing was put back where the workspace used to be.
    expect(snapshot()).toEqual(before);
    expect(readdirSync(rig.paths.built)).toEqual([IDEA_ID]);
    expect(existsSync(rig.workspace)).toBe(false);
  });

  it("refuses a workspace with a symbolic link in it, before anything runs", async () => {
    const rig = makeRig();
    symlinkSync("/etc/hosts", path.join(rig.workspace, "src/hosts"));
    const result = await rig.verify();
    expect(result).toMatchObject({ ok: false, reason: "The app's folder contains a symbolic link, which is not allowed.", checks: { failedStep: "copy" } });
    expect(rig.calls).toEqual([]);
  });

  it("refuses a workspace over the file cap or the size cap", async () => {
    const tooMany = makeRig({ limits: { sourceMaxFiles: 3 } });
    expect(await tooMany.verify()).toMatchObject({ ok: false, reason: "The app's folder has more than 3 files." });
    const tooBig = makeRig({ limits: { sourceMaxBytes: 50 } });
    expect(await tooBig.verify()).toMatchObject({ ok: false, reason: "The app's folder is larger than 50 bytes." });
    expect([...tooMany.calls, ...tooBig.calls]).toEqual([]);
  });

  it("uses the real caps by default: 2,000 files and 50 MB of source, 500 files and 20 MB of dist", async () => {
    const { DEFAULT_VERIFY_LIMITS } = await import("../src/index.ts");
    expect(DEFAULT_VERIFY_LIMITS).toMatchObject({ sourceMaxFiles: 2_000, sourceMaxBytes: 50 * 1024 * 1024, distMaxFiles: 500, distMaxBytes: 20 * 1024 * 1024 });
  });

  it("refuses an app that breaks the contract's basics, in plain words", async () => {
    const base = { "package.json": JSON.stringify({ scripts: { build: "vite build" } }), "package-lock.json": "{}\n", "tests/smoke.spec.ts": "//\n" };
    const without = (key: string) => Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));

    const noPackage = makeRig({ workspaceFiles: without("package.json") });
    expect(await noPackage.verify()).toMatchObject({ ok: false, reason: "The app has no readable package.json." });
    const noLock = makeRig({ workspaceFiles: without("package-lock.json") });
    expect(await noLock.verify()).toMatchObject({ ok: false, reason: "The app has no package-lock.json, so its packages cannot be installed exactly." });
    const noBuild = makeRig({ workspaceFiles: { ...base, "package.json": JSON.stringify({ scripts: { dev: "vite" } }) } });
    expect(await noBuild.verify()).toMatchObject({ ok: false, reason: 'The app\'s package.json has no "build" script.' });
    const noSmoke = makeRig({ workspaceFiles: without("tests/smoke.spec.ts") });
    expect(await noSmoke.verify()).toMatchObject({ ok: false, reason: "The app does not ship its smoke test (tests/smoke.spec.ts).", checks: { appSmokePresent: false } });
    expect([...noPackage.calls, ...noLock.calls, ...noBuild.calls, ...noSmoke.calls]).toEqual([]);
  });

  it("says so when the workspace is missing", async () => {
    const rig = makeRig({ workspaceFiles: {} });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "The app's folder does not exist." });
  });
});

describe("the sandboxed verifier: install", () => {
  it("fails when npm ci fails for any reason other than a missing package", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(1, "", "npm error code EUSAGE\nMADE-UP-TOOL-OUTPUT\n") } });
    const result = await rig.verify();
    expect(result).toMatchObject({ ok: false, reason: "Installing the app's packages (npm ci) failed.", checks: { failedStep: "install", installUsedRegistry: false } });
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline"]);
    expect(rig.proxy.started).toBe(0);
    expect(rig.logLines.join("\n")).not.toContain("MADE-UP-TOOL-OUTPUT");
  });

  it("only when the cache lacks a package: retries through the registry-only proxy with a cache of its own", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(1, "", "npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/vite failed\n") } });
    const result = await rig.verify();

    expect(result.ok).toBe(true);
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "npm-ci-registry", "build", "contract", "app-smoke"]);
    const retry = rig.calls[1];
    // A cache of its own, inside this one command's scratch folder (which no other command shares).
    const privateCache = path.join(rig.at.buildBox, "scratch-2-npm-ci-registry", "npm-cache");
    expect(retry?.argv).toEqual([path.join(rig.nodeBin, "npm"), "ci"]);
    expect(retry?.defines).toMatchObject({ PORT: "1", PROXY_PORT: "51000", NPM_CACHE: privateCache, RUN_DIR: path.dirname(privateCache) });
    expect(retry?.env).toMatchObject({ npm_config_cache: privateCache, npm_config_proxy: "http://127.0.0.1:51000", npm_config_https_proxy: "http://127.0.0.1:51000" });
    expect(retry?.timeoutMs).toBe(8 * MINUTE);
    // The proxy is open for that one command only.
    expect(rig.proxy).toEqual({ started: 1, closed: 1 });
    expect(rig.calls[2]?.defines).toMatchObject({ PROXY_PORT: "1", NPM_CACHE: rig.npmCacheDir });
    expect(result.checks).toMatchObject({ installUsedRegistry: true, registryConnections: 15, registryRefused: 1 });
  });

  it("closes the proxy and fails when the install through the registry fails too", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(1, "", "npm error code ENOTCACHED\n"), "npm-ci-registry": () => done(1, "", "npm error code E404\n") } });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "Installing the app's packages (npm ci) failed.", checks: { installUsedRegistry: true, failedStep: "install" } });
    expect(rig.proxy).toEqual({ started: 1, closed: 1 });
  });

  it("says so when a package is missing and the registry proxy cannot start", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(1, "", "npm error code ENOTCACHED\n") } });
    const { logger } = collectingLogger();
    const verifier = createSandboxedVerifier({
      paths: rig.paths,
      logger,
      nodeBinDir: rig.nodeBin,
      platform: "darwin",
      run: async () => done(1, "", "npm error code ENOTCACHED\n"),
      places: { home: rig.home, toolsDir: rig.toolsDir, browsersDir: rig.browsersDir, npmCacheDir: rig.npmCacheDir, profileFile: PROFILE, sandboxExec: rig.sandboxExec },
      privateStrings: async () => PRIVATE,
      startRegistryProxy: async () => {
        throw new Error("made-up: no port");
      },
    });
    expect(await verifier.verify({ ideaId: IDEA_ID, workspace: rig.workspace, runDir: rig.runDir })).toMatchObject({
      ok: false,
      reason: "A package is missing from the npm cache, and Overnight's registry-only proxy could not start to fetch it.",
      checks: { failedStep: "install" },
    });
  });

  it("fails with the time limit in the reason when the install is stopped", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => timedOut() } });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "Installing the app's packages took longer than 5 minutes and was stopped." });
  });

  it("fails when the sandbox itself cannot be started", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => ({ stdout: "", stderr: "", exitCode: null, timedOut: false, error: "Could not start sandbox-exec (ENOENT)." }) } });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "The sandbox could not be started to install the app's packages." });
  });
});

describe("the sandboxed verifier: build and dist", () => {
  it("fails when the build command fails or is stopped", async () => {
    const failed = makeRig({ behaviour: { build: () => done(2, "", "error TS2307: MADE-UP-TOOL-OUTPUT\n") } });
    expect(await failed.verify()).toMatchObject({ ok: false, reason: "The app's build command (npm run build) failed.", checks: { installOk: true, failedStep: "build" } });
    expect(failed.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
    expect(failed.logLines.join("\n")).not.toContain("MADE-UP-TOOL-OUTPUT");

    const slow = makeRig({ behaviour: { build: () => timedOut() } });
    expect(await slow.verify()).toMatchObject({ ok: false, reason: "Building the app took longer than 5 minutes and was stopped." });
  });

  it("fails when the build leaves no dist/index.html", async () => {
    const nothing = makeRig({ behaviour: { build: () => done(0) } });
    expect(await nothing.verify()).toMatchObject({ ok: false, reason: "The build did not produce dist/index.html.", checks: { buildOk: true, distHasIndex: false, failedStep: "dist" } });
    const wrongPlace = makeRig({
      behaviour: {
        build: (call) => {
          writeTree(path.join(call.cwd ?? "", "dist"), { "public/index.html": "x\n" });
          return done(0);
        },
      },
    });
    expect(await wrongPlace.verify()).toMatchObject({ ok: false, reason: "The build did not produce dist/index.html." });
  });

  it("refuses a dist with a symbolic link in it, and never serves or tests it", async () => {
    const rig = makeRig({
      behaviour: {
        build: (call) => {
          const dist = path.join(call.cwd ?? "", "dist");
          writeTree(dist, { "index.html": "<h1>x</h1>\n" });
          symlinkSync("/etc/hosts", path.join(dist, "leak.txt"));
          return done(0);
        },
      },
    });
    const result = await rig.verify();
    expect(result).toMatchObject({ ok: false, reason: "The built app (dist) contains a symbolic link, which is not allowed.", checks: { failedStep: "dist" } });
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
  });

  it("refuses a dist whose index.html is itself a link", async () => {
    const rig = makeRig({
      behaviour: {
        build: (call) => {
          mkdirSync(path.join(call.cwd ?? "", "dist"));
          symlinkSync("/etc/hosts", path.join(call.cwd ?? "", "dist/index.html"));
          return done(0);
        },
      },
    });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "The build did not produce dist/index.html." });
  });

  it("refuses a dist over the file cap or the size cap", async () => {
    const tooMany = makeRig({ limits: { distMaxFiles: 1 } });
    expect(await tooMany.verify()).toMatchObject({ ok: false, reason: "The built app (dist) has more than 1 files.", checks: { failedStep: "dist" } });
    const tooBig = makeRig({ limits: { distMaxBytes: 10 } });
    expect(await tooBig.verify()).toMatchObject({ ok: false, reason: "The built app (dist) is larger than 10 bytes." });
    expect(tooBig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
  });
});

describe("the sandboxed verifier: the browser tests", () => {
  it("fails with counts when the page breaks the contract", async () => {
    const rig = makeRig({
      behaviour: {
        contract: (call) => {
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), PNG);
          return done(0, contractLine({ phone: { ...cleanView, consoleErrors: 2, nonLocalRequests: 1, failedRequests: 1 }, desktop: cleanView }));
        },
      },
    });
    const result = await rig.verify();
    expect(result).toMatchObject({
      ok: false,
      reason:
        "The page did not pass Overnight's checks: 1 request to somewhere other than its own files on a phone-sized screen; 1 failed request on a phone-sized screen; 2 console errors on a phone-sized screen.",
      checks: { failedStep: "contract", phoneConsoleErrors: 2, phoneNonLocalRequests: 1, desktopConsoleErrors: 0 },
    });
    // A page that fails our test is not handed to the app's own test, and gets no screenshots on the dashboard.
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build", "contract"]);
    expect(existsSync(path.join(rig.paths.screenshots, `${IDEA_ID}.png`))).toBe(false);
  });

  it("fails when our test printed no result, printed something else, or did not exit cleanly", async () => {
    const silent = makeRig({ behaviour: { contract: () => done(0, "1 passed\n") } });
    expect(await silent.verify()).toMatchObject({ ok: false, reason: "The page could not be tested in the browser." });
    const garbled = makeRig({ behaviour: { contract: () => done(0, `${CONTRACT_MARKER}{"phone":"made-up text from a page"}\n`) } });
    expect(await garbled.verify()).toMatchObject({ ok: false, reason: "The page could not be tested in the browser." });
    const crashed = makeRig({ behaviour: { contract: () => done(1, contractLine({ phone: cleanView, desktop: cleanView })) } });
    expect(await crashed.verify()).toMatchObject({ ok: false, reason: "The page could not be tested in the browser." });
    const slow = makeRig({ behaviour: { contract: () => timedOut() } });
    expect(await slow.verify()).toMatchObject({ ok: false, reason: "Testing the page took longer than 3 minutes and was stopped." });
  });

  it("fails when a screenshot is missing, is not a picture, or is a link", async () => {
    const clean = contractLine({ phone: cleanView, desktop: cleanView });
    const missing = makeRig({ behaviour: { contract: () => done(0, clean) } });
    expect(await missing.verify()).toMatchObject({ ok: false, reason: "The screenshots of the page could not be saved.", checks: { screenshotsSaved: false } });

    const notPng = makeRig({
      behaviour: {
        contract: (call) => {
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), "made-up text, not a picture\n");
          return done(0, clean);
        },
      },
    });
    expect(await notPng.verify()).toMatchObject({ ok: false, reason: "The screenshots of the page could not be saved." });

    const linked = makeRig({
      behaviour: {
        contract: (call) => {
          const outside = path.join(call.defines.DATA_DIR ?? "", "made-up-private.png");
          writeFileSync(outside, PNG);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
          symlinkSync(outside, path.join(call.env.SHOT_DIR ?? "", "desktop.png"));
          return done(0, clean);
        },
      },
    });
    expect(await linked.verify()).toMatchObject({ ok: false, reason: "The screenshots of the page could not be saved." });
    expect(existsSync(path.join(linked.paths.screenshots, `${IDEA_ID}-desktop.png`))).toBe(false);
  });

  it("fails when the app's own smoke test fails or is stopped", async () => {
    const failed = makeRig({ behaviour: { "app-smoke": () => done(1, "1 failed\n") } });
    expect(await failed.verify()).toMatchObject({ ok: false, reason: "The app's own smoke test (tests/smoke.spec.ts) failed.", checks: { contractOk: true, failedStep: "app-smoke" } });
    const slow = makeRig({ behaviour: { "app-smoke": () => timedOut() } });
    expect(await slow.verify()).toMatchObject({ ok: false, reason: "The app's own smoke test took longer than 4 minutes and was stopped." });
  });

  it("picks another port, once, when our server could not take the first one", async () => {
    let tries = 0;
    const rig = makeRig({
      behaviour: {
        "app-smoke": () => {
          tries += 1;
          return tries === 1 ? done(97, "HARNESS server could not start\n") : done(0);
        },
      },
    });
    expect((await rig.verify()).ok).toBe(true);
    expect(rig.calls.filter((call) => call.step === "app-smoke").map((call) => call.defines.PORT)).toEqual(["50002", "50003"]);

    const never = makeRig({ behaviour: { "app-smoke": () => done(97) } });
    expect(await never.verify()).toMatchObject({ ok: false, reason: "Overnight's own test server could not start on this Mac.", checks: { failedStep: "app-smoke" } });
    expect(never.calls.filter((call) => call.step === "app-smoke")).toHaveLength(2);
  });
});

describe("the sandboxed verifier: set-up", () => {
  it("refuses to run agent code on a computer without the macOS sandbox", async () => {
    const rig = makeRig({ platform: "linux" });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "Verification needs the macOS sandbox, which this computer does not have.", checks: { failedStep: "setup" } });
    expect(rig.calls).toEqual([]);
  });

  it("refuses a run folder that already has something in it", async () => {
    const rig = makeRig();
    writeTree(rig.runDir, { "left-over.txt": "x\n" });
    expect(await rig.verify()).toMatchObject({ ok: false, reason: "The run folder is not empty." });
    expect(readdirSync(rig.runDir)).toEqual(["left-over.txt"]);
  });

  it("refuses an idea id that could not be a file name", async () => {
    const rig = makeRig();
    const { logger } = collectingLogger();
    const verifier = createSandboxedVerifier({ paths: rig.paths, logger, platform: "darwin" });
    expect(await verifier.verify({ ideaId: "../escape", workspace: rig.workspace, runDir: rig.runDir })).toMatchObject({ ok: false, reason: "The idea's id cannot be used as a file name." });
  });

  it("says what is missing when the headless browser is not installed", async () => {
    const rig = makeRig();
    const { logger } = collectingLogger();
    const emptyBrowsers = path.join(rig.root, "no-browsers");
    mkdirSync(emptyBrowsers);
    const verifier = createSandboxedVerifier({
      paths: rig.paths,
      logger,
      nodeBinDir: rig.nodeBin,
      platform: "darwin",
      run: async () => done(0),
      places: { home: rig.home, toolsDir: rig.toolsDir, browsersDir: emptyBrowsers, npmCacheDir: rig.npmCacheDir, profileFile: PROFILE, sandboxExec: rig.sandboxExec },
    });
    expect(await verifier.verify({ ideaId: IDEA_ID, workspace: rig.workspace, runDir: rig.runDir })).toMatchObject({ ok: false, reason: "Playwright's headless browser is not installed on this Mac." });
  });

  it("does not leave the app copy or its caches behind after a failure", async () => {
    const rig = makeRig({ behaviour: { build: () => done(2) } });
    await rig.verify();
    expect(readdirSync(rig.runDir).sort()).toEqual(["logs", "site"]);
    expect(lstatSync(path.join(rig.runDir, "site")).isDirectory()).toBe(true);
    expect(readdirSync(path.join(rig.runDir, "site"))).toEqual([]);
  });
});

describe("the sandboxed verifier: one step cannot decide the outcome of a later one", () => {
  it("gives every sandboxed command temp and results folders of its own, made fresh for it", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(1, "", "npm error code ENOTCACHED\n") } });
    expect((await rig.verify()).ok).toBe(true);
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "npm-ci-registry", "build", "contract", "app-smoke"]);

    const runDirs = rig.calls.map((call) => call.defines.RUN_DIR ?? "");
    const tempDirs = rig.calls.map((call) => call.env.TMPDIR ?? "");
    expect(new Set(runDirs).size).toBe(5);
    expect(new Set(tempDirs).size).toBe(5);
    for (const [index, call] of rig.calls.entries()) expect(call.env.TMPDIR).toBe(path.join(runDirs[index] ?? "", "tmp"));

    // The contract test's folders differ from the build's in every part: what it may write, where
    // its temp files and Playwright's compiled test files go, and where the screenshots land.
    const build = rig.call("build");
    const contract = rig.call("contract");
    for (const folder of [contract.defines.RUN_DIR, contract.defines.WORKSPACE, contract.env.TMPDIR, contract.env.SHOT_DIR, contract.env.PW_OUT, contract.env.PWTEST_CACHE_DIR]) {
      expect(folder).toBeTypeOf("string");
      for (const writableByTheBuild of [build.defines.WORKSPACE ?? "", build.defines.RUN_DIR ?? "", rig.at.buildBox]) {
        expect(folder === writableByTheBuild || (folder ?? "").startsWith(`${writableByTheBuild}/`), `${folder} is inside ${writableByTheBuild}`).toBe(false);
      }
    }
    expect(contract.env.PWTEST_CACHE_DIR?.startsWith(`${contract.defines.RUN_DIR}/`)).toBe(true);
    expect(contract.env.SHOT_DIR?.startsWith(`${contract.defines.RUN_DIR}/`)).toBe(true);
    // The same goes for the app's own smoke test, which runs agent-written code again.
    const smoke = rig.call("app-smoke");
    expect(smoke.defines.RUN_DIR?.startsWith(`${rig.at.smokeBox}/`)).toBe(true);
    expect(smoke.defines.WORKSPACE).toBe(path.join(rig.at.smokeBox, "work"));
  });

  it("the contract test's folders do not exist while the install and the build run, and are empty when it starts", async () => {
    const rig = makeRig();
    await rig.verify();
    expect(rig.seen.runDirAtBuild).toEqual(["build", "harness-contract", "harness-smoke", "logs", "site"]);
    expect(rig.seen.contractWork).toEqual([]);
    expect(rig.seen.contractScratch).toEqual(["npm-cache", "out", "tmp"]);
  });

  it("after the build, everything it wrote is taken away before our own test runs: only dist is carried forward", async () => {
    const rig = makeRig();
    await rig.verify();
    const during = rig.seen.runDirAtContract as string[];
    // The box the install and the build could write is no longer at its path (it waits, renamed, to be deleted) ...
    expect(during).not.toContain("build");
    expect(during.filter((name) => name.startsWith(".gone-build-"))).toHaveLength(1);
    // ... and dist was moved out of it by a rename before we copied it.
    expect(during).toContain("dist-built");
    expect(during).toEqual(expect.arrayContaining(["contract", "harness-contract", "harness-smoke", "logs", "site"]));
    // By the time the app's own test runs, the contract test's folders have been taken away as well.
    const later = rig.seen.runDirAtSmoke as string[];
    expect(later).not.toContain("contract");
    expect(later.filter((name) => name.startsWith(".gone-contract-"))).toHaveLength(1);
  });

  it("never puts anything from the app in the folder our contract test runs from, whatever the app's tests folder holds", async () => {
    const rig = makeRig({
      workspaceFiles: {
        "package.json": JSON.stringify({ name: "made-up-app", type: "module", scripts: { build: "vite build" } }),
        "package-lock.json": "{}\n",
        "tests/smoke.spec.ts": "// the app's own made-up test\n",
        // Playwright would pick this up as "our" test if it sat anywhere under the folder our test runs from.
        "tests/contract.spec.ts": "// made-up: prints a forged result line\n",
        "tests/contract.config.ts": "// made-up\n",
        "tests/nested/contract.spec.ts": "// made-up\n",
      },
    });
    expect((await rig.verify()).ok).toBe(true);
    expect(rig.seen.harness).toEqual(["contract.config.ts", "contract.spec.ts", "node_modules", "package.json", "serve-and-test.ts", "static-server.ts"]);
    // What is in it is byte for byte what we ship.
    const shipped = (name: string) => readFileSync(fileURLToPath(new URL(`../src/harness/${name}`, import.meta.url)), "utf8");
    const contract = rig.call("contract");
    expect(contract.defines.HARNESS_DIR).toBe(rig.at.contractHarness);
    expect(contract.cwd).toBe(rig.at.contractHarness);
    expect(contract.argv.slice(1)).toEqual([path.join(rig.at.contractHarness, "serve-and-test.ts"), rig.at.site, "50001", path.join(rig.at.contractHarness, "contract.config.ts")]);
    // (The harness folders are deleted afterwards, so the check on their content is made while the step runs.)
    const checked = makeRig({
      behaviour: {
        contract: (call) => {
          for (const name of ["contract.spec.ts", "contract.config.ts", "serve-and-test.ts", "static-server.ts"]) {
            if (readFileSync(path.join(call.defines.HARNESS_DIR ?? "", name), "utf8") !== shipped(name)) throw new Error(`${name} is not the file we ship`);
          }
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), PNG);
          return done(0, contractLine({ phone: cleanView, desktop: cleanView }));
        },
      },
    });
    expect((await checked.verify()).ok).toBe(true);
    // The app's tests are in the OTHER harness folder only.
    expect(rig.seen.smokeHarness).toContain("app-smoke");
  });

  it("takes the screenshots only from the contract step's own folder, and not through a link", async () => {
    const swapped = makeRig({
      behaviour: {
        contract: (call) => {
          // The results folder is replaced by a link to a folder holding ready-made pictures.
          const elsewhere = path.join(call.defines.WORKSPACE ?? "", "ready-made");
          mkdirSync(elsewhere);
          writeFileSync(path.join(elsewhere, "phone.png"), PNG);
          writeFileSync(path.join(elsewhere, "desktop.png"), PNG);
          rmSync(call.env.SHOT_DIR ?? "", { recursive: true });
          symlinkSync(elsewhere, call.env.SHOT_DIR ?? "");
          return done(0, contractLine({ phone: cleanView, desktop: cleanView }));
        },
      },
    });
    expect(await swapped.verify()).toMatchObject({ ok: false, reason: "The screenshots of the page could not be saved.", checks: { screenshotsSaved: false } });
    expect(existsSync(path.join(swapped.paths.screenshots, `${IDEA_ID}.png`))).toBe(false);
  });

  it("without a shared npm cache, every install gets an empty cache of its own", async () => {
    const rig = makeRig({ behaviour: { "npm-ci-offline": () => done(1, "", "npm error code ENOTCACHED\n") } });
    rmSync(rig.npmCacheDir, { recursive: true });
    expect((await rig.verify()).ok).toBe(true);
    const caches = rig.calls.map((call) => call.defines.NPM_CACHE ?? "");
    for (const [index, call] of rig.calls.entries()) expect(caches[index]).toBe(path.join(call.defines.RUN_DIR ?? "", "npm-cache"));
    expect(new Set(caches).size).toBe(rig.calls.length);
  });
});

describe("the sandboxed verifier: the folders a step may write cannot be swapped for others", () => {
  const REPLACED = "A folder Overnight uses to check the app was replaced while the app's code ran, so the check was abandoned.";

  it("keeps each step's box read-only while the step runs, so nothing in it can be moved away or put in its place", async () => {
    const modes: Record<string, string> = {};
    const note = (call: Call) => {
      const box = path.dirname(call.defines.RUN_DIR ?? "");
      modes[call.step] = (statSync(box).mode & 0o777).toString(8);
      // The box holds exactly the two folders the step may write (plus earlier steps' scratch folders).
      expect(path.dirname(call.defines.WORKSPACE ?? ""), call.step).toBe(box);
    };
    const rig = makeRig({
      behaviour: {
        "npm-ci-offline": (call) => {
          note(call);
          return done(0);
        },
        build: (call) => {
          note(call);
          writeTree(path.join(call.cwd ?? "", "dist"), { "index.html": "<h1>made-up app</h1>\n" });
          return done(0);
        },
        contract: (call) => {
          note(call);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), PNG);
          return done(0, contractLine({ phone: cleanView, desktop: cleanView }));
        },
        "app-smoke": (call) => {
          note(call);
          return done(0);
        },
      },
    });
    expect((await rig.verify()).ok).toBe(true);
    expect(modes).toEqual({ "npm-ci-offline": "500", build: "500", contract: "500", "app-smoke": "500" });
    // And everything was still deleted afterwards.
    expect(readdirSync(rig.runDir).sort()).toEqual(["logs", "site"]);
  });

  it("a build that swaps the app folder for a link to another folder is caught: nothing in that folder is moved, copied or published", async () => {
    // The real sandbox refuses the first line of this (it may not change the box); the check must hold even if it did not.
    const outside = tempDir();
    writeTree(outside, { "someone-elses-project/dist/index.html": "<h1>made-up private project</h1>\n" });
    const rig = makeRig({
      behaviour: {
        build: (call) => {
          const app = call.cwd ?? "";
          chmodSync(path.dirname(app), 0o700);
          renameSync(app, path.join(call.defines.RUN_DIR ?? "", "the-real-app"));
          symlinkSync(path.join(outside, "someone-elses-project"), app);
          return done(0);
        },
      },
    });
    const result = await rig.verify();
    expect(result).toMatchObject({ ok: false, reason: REPLACED, checks: { failedStep: "build" } });
    expect(result.checks.distHasIndex).toBeUndefined();
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
    // The other folder is exactly as it was, and none of it reached our copy.
    expect(readFileSync(path.join(outside, "someone-elses-project/dist/index.html"), "utf8")).toBe("<h1>made-up private project</h1>\n");
    expect(readdirSync(rig.at.site)).toEqual([]);
    expect(readdirSync(rig.runDir).sort()).toEqual(["logs", "site"]);
  });

  it("the same for a step's scratch folder, and for a folder moved into the app folder's place", async () => {
    const outside = tempDir();
    writeTree(outside, { "ready-made/out/phone.png": "x", "ready-made/out/desktop.png": "x" });
    const scratchSwapped = makeRig({
      behaviour: {
        contract: (call) => {
          const scratch = call.defines.RUN_DIR ?? "";
          chmodSync(path.dirname(scratch), 0o700);
          renameSync(scratch, path.join(call.defines.WORKSPACE ?? "", "the-real-scratch"));
          symlinkSync(path.join(outside, "ready-made"), scratch);
          return done(0, contractLine({ phone: cleanView, desktop: cleanView }));
        },
      },
    });
    expect(await scratchSwapped.verify()).toMatchObject({ ok: false, reason: REPLACED, checks: { failedStep: "contract" } });
    expect(existsSync(path.join(scratchSwapped.paths.screenshots, `${IDEA_ID}.png`))).toBe(false);

    const folderSwapped = makeRig({
      behaviour: {
        "npm-ci-offline": (call) => {
          const app = call.cwd ?? "";
          chmodSync(path.dirname(app), 0o700);
          renameSync(app, path.join(call.defines.RUN_DIR ?? "", "the-real-app"));
          // Not a link this time: a different, real folder under the same name.
          writeTree(app, { "package.json": "{}\n", "dist/index.html": "<h1>swapped in</h1>\n" });
          return done(0);
        },
      },
    });
    expect(await folderSwapped.verify()).toMatchObject({ ok: false, reason: REPLACED, checks: { failedStep: "install" } });
    expect(folderSwapped.calls.map((call) => call.step)).toEqual(["npm-ci-offline"]);
  });

  it("still takes dist from an app folder that the build made read-only", async () => {
    const rig = makeRig({
      behaviour: {
        build: (call) => {
          writeTree(path.join(call.cwd ?? "", "dist"), { "index.html": "<h1>made-up app</h1>\n" });
          chmodSync(call.cwd ?? "", 0o555);
          return done(0);
        },
      },
    });
    expect((await rig.verify()).ok).toBe(true);
    expect(readdirSync(rig.runDir).sort()).toEqual(["logs", "site"]);
  });
});

describe("the sandboxed verifier: programs left running", () => {
  const strayAfter = (step: "npm-ci-offline" | "build" | "contract" | "app-smoke", leftovers: Leftovers) =>
    makeRig({
      behaviour: {
        [step]: (call: Call) => {
          if (step === "build") writeTree(path.join(call.cwd ?? "", "dist"), { "index.html": "<h1>made-up app</h1>\n" });
          if (step === "contract") {
            writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
            writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), PNG);
            return done(0, contractLine({ phone: cleanView, desktop: cleanView }), "", leftovers);
          }
          return done(0, "", "", leftovers);
        },
      },
    });

  it("fails the verification when a step left a program running outside its own process group", async () => {
    const cases = [
      ["npm-ci-offline", "install", "Installing the app's packages left a program running in the background, which is not allowed."],
      ["build", "build", "The app's build left a program running in the background, which is not allowed."],
      ["contract", "contract", "Testing the page left a program running that should have ended, so the result cannot be trusted."],
      ["app-smoke", "app-smoke", "The app's own smoke test left a program running in the background, which is not allowed."],
    ] as const;
    for (const [step, failedStep, reason] of cases) {
      const rig = strayAfter(step, { escaped: 2, expected: 0, unconfirmed: false });
      expect(await rig.verify(), step).toMatchObject({ ok: false, reason, checks: { failedStep, leftoverPrograms: 2 } });
      // Nothing after that step runs, and nothing it wrote is read.
      expect(rig.calls.at(-1)?.step).toBe(step);
    }
  });

  it("the build's dist is not even looked at when the build left something running", async () => {
    const rig = strayAfter("build", { escaped: 1, expected: 0, unconfirmed: false });
    const result = await rig.verify();
    expect(result.checks.distHasIndex).toBeUndefined();
    expect(readdirSync(rig.at.site)).toEqual([]);
  });

  it("fails when it could not be confirmed that everything a step started has ended", async () => {
    const rig = strayAfter("build", { escaped: 0, expected: 0, unconfirmed: true });
    expect(await rig.verify()).toMatchObject({
      ok: false,
      reason: "Overnight could not confirm that every program started while checking the app had ended, so the check was abandoned.",
      checks: { failedStep: "build", leftoverPrograms: 0 },
    });
  });

  it("the browser's own processes outliving a browser step for a moment are expected, and are not a failure", async () => {
    const rig = strayAfter("contract", { escaped: 0, expected: 4, unconfirmed: false });
    const result = await rig.verify();
    expect(result.ok).toBe(true);
    expect(result.checks.leftoverPrograms).toBeUndefined();
  });

  it("a time limit or a failed start is still reported as such, whatever was left running", async () => {
    const slow = makeRig({ behaviour: { build: () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true, leftovers: { escaped: 3, expected: 0, unconfirmed: true } }) } });
    expect(await slow.verify()).toMatchObject({ ok: false, reason: "Building the app took longer than 5 minutes and was stopped." });
  });

  it("writes what was found into the step's log file, never into the log", async () => {
    const rig = strayAfter("build", { escaped: 1, expected: 0, unconfirmed: false });
    await rig.verify();
    expect(readFileSync(path.join(rig.runDir, "logs/npm-run-build.log"), "utf8").split("\n")[0]).toBe("exit=0 timedOut=false stopped=false leftovers: escaped=1 expected=0 unconfirmed=false");
  });
});

describe("the sandboxed verifier: what must not be published", () => {
  const buildWriting = (files: Record<string, string>) =>
    makeRig({
      behaviour: {
        build: (call) => {
          writeTree(path.join(call.cwd ?? "", "dist"), { "index.html": "<h1>made-up app</h1>\n", ...files });
          return done(0);
        },
      },
    });

  it("refuses a dist that names this Mac or the path of its home folder, and never serves or tests it", async () => {
    const leaks: Array<Record<string, string>> = [{ "assets/app.js": 'console.log("built on Zebras-MacBook-Pro")\n' }, { "assets/app.js.map": '{"sources":["/Users/zebra/.overnight/tmp/x/src/main.ts"]}\n' }];
    for (const files of leaks) {
      const rig = buildWriting(files);
      const result = await rig.verify();
      expect(result).toMatchObject({
        ok: false,
        reason: "The built app contains this computer's name or the path of its home folder, which must not be published.",
        checks: { failedStep: "dist", distNamesThisMac: true },
      });
      expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
      // The strings themselves never reach the log or the reason.
      for (const secret of PRIVATE) expect(rig.logLines.join("\n") + (result.ok ? "" : result.reason)).not.toContain(secret);
    }
  });

  it("refuses a dist holding a file that changes what git would publish", async () => {
    for (const [name, spelled] of [
      [".gitignore", ".gitignore"],
      ["assets/.gitattributes", ".gitattributes"],
      [".GitIgnore", ".gitignore"],
      [".gitmodules", ".gitmodules"],
      [".git/config", ".git"],
    ] as const) {
      const rig = buildWriting({ [name]: "overnight.json\n" });
      expect(await rig.verify(), name).toMatchObject({ ok: false, reason: `The built app (dist) contains an entry named "${spelled}", which is not allowed.`, checks: { failedStep: "dist" } });
      expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
    }
  });

  it("a clean dist is marked as not naming this Mac", async () => {
    const rig = makeRig();
    expect((await rig.verify()).checks).toMatchObject({ distNamesThisMac: false });
  });
});

describe("the sandboxed verifier: being stopped", () => {
  it("hands the stop signal to every command it runs", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    expect((await rig.verify(stop.signal)).ok).toBe(true);
    for (const call of rig.calls) expect(call.signal).toBe(stop.signal);
  });

  it("starts nothing when the signal has already fired", async () => {
    const stop = new AbortController();
    stop.abort();
    const rig = makeRig();
    expect(await rig.verify(stop.signal)).toMatchObject({ ok: false, stopped: true, reason: VERIFY_STOPPED_REASON, checks: { failedStep: "stopped" } });
    expect(rig.calls).toEqual([]);
    expect(existsSync(rig.runDir)).toBe(false);
  });

  it("stopped during the build: runs nothing more, says it was stopped (not that the app failed), and takes the folders away", async () => {
    const stop = new AbortController();
    const rig = makeRig({
      behaviour: {
        build: (call) => {
          writeTree(path.join(call.cwd ?? "", "dist"), { "index.html": "<h1>half-built</h1>\n" });
          stop.abort();
          return { stdout: "", stderr: "", exitCode: null, timedOut: false, stopped: true, leftovers: TIDY };
        },
      },
    });
    const result = await rig.verify(stop.signal);
    expect(result).toEqual({ ok: false, stopped: true, reason: VERIFY_STOPPED_REASON, checks: expect.objectContaining({ failedStep: "stopped", installOk: true }) });
    expect(result.checks.buildOk).toBeUndefined();
    expect(rig.calls.map((call) => call.step)).toEqual(["npm-ci-offline", "build"]);
    // No sandbox can write the app copy any more: its box was renamed. (Deleting it is left to the next run: there are only seconds.)
    const left = readdirSync(rig.runDir);
    expect(left).not.toContain("build");
    expect(left.filter((name) => name.startsWith(".gone-build-"))).toHaveLength(1);
    expect(readdirSync(rig.at.site)).toEqual([]);
    expect(rig.logLines.join("\n")).toContain("verification was stopped before it finished");
  });

  it("stopped while the page is being tested: no verdict on the page, no screenshots saved", async () => {
    const stop = new AbortController();
    const rig = makeRig({
      behaviour: {
        contract: (call) => {
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "phone.png"), PNG);
          writeFileSync(path.join(call.env.SHOT_DIR ?? "", "desktop.png"), PNG);
          stop.abort();
          // Even a result that looks complete is not used once we were told to stop.
          return done(0, contractLine({ phone: cleanView, desktop: cleanView }));
        },
      },
    });
    expect(await rig.verify(stop.signal)).toMatchObject({ ok: false, stopped: true, reason: VERIFY_STOPPED_REASON });
    expect(rig.calls.at(-1)?.step).toBe("contract");
    expect(existsSync(path.join(rig.paths.screenshots, `${IDEA_ID}.png`))).toBe(false);
  });
});
