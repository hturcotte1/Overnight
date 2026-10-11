// Synthetic test data: the account, repo, app files and links in this file are made up.
// Nothing here talks to GitHub: "gh" and "git" are played by a fake runner, the web by a fake fetch.
// (publisher-git.test.ts runs the same publisher with the real git program against a local folder.)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPaths, ensureDataDirs, parseConfig } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { createPagesPublisher, GIT_SAFETY, PUBLISH_STOPPED_REASON, scrubbedEnv } from "../src/index.ts";
import type { CommandRunner } from "../src/index.ts";
import { collectingLogger, tempDir, writeTree } from "./helpers.ts";

type RunResult = Awaited<ReturnType<CommandRunner>>;
interface Call {
  /** A short name for the command, such as "git push" or "gh api user". */
  key: string;
  command: string;
  /** The arguments without the safety settings that go in front of every git command. */
  args: string[];
  /** Those safety settings, as given. */
  safety: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

const OWNER = "made-up-owner";
const REPO = "overnight-apps";
const REMOTE = `https://github.com/${OWNER}/${REPO}.git`;
const EMAIL = `4242+${OWNER}@users.noreply.github.com`;
const IDEA_ID = "idea_20261010_feedc0de";
const SLUG = "tip-splitter";
const MARKER = `${IDEA_ID}-mfx3k2-0a1b2c3d`;
const URL_LIVE = `https://${OWNER}.github.io/${REPO}/${SLUG}/`;
const MAIN_AT = "0123456789abcdef0123456789abcdef01234567";
/** The environment Overnight itself was started with, in these tests: full of things git and gh must never see. */
const OUR_ENV = {
  HOME: "/made-up/home",
  PATH: "/made-up/bin:/usr/bin:/bin",
  USER: "zebra",
  LOGNAME: "zebra",
  GH_TOKEN: "made-up-token-1",
  GITHUB_TOKEN: "made-up-token-2",
  GIT_AUTHOR_NAME: "Someone Else",
  GIT_AUTHOR_EMAIL: "someone-else@made-up.example",
  GIT_COMMITTER_NAME: "Someone Else",
  GIT_COMMITTER_EMAIL: "someone-else@made-up.example",
  EMAIL: "someone-else@made-up.example",
  GIT_DIR: "/made-up/another-repo/.git",
  GIT_SSH_COMMAND: "made-up-ssh",
  SSH_AUTH_SOCK: "/made-up/agent.sock",
  EDITOR: "made-up-editor",
  OVERNIGHT_DATA_DIR: "/made-up/data",
};
const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
const failed = (exitCode = 1): RunResult => ({ stdout: "", stderr: "fatal: MADE-UP-TOOL-OUTPUT\n", exitCode, timedOut: false });
const hung = (): RunResult => ({ stdout: "", stderr: "", exitCode: null, timedOut: true });

/** Splits off the "-c name=value" pairs in front of a git command. */
function splitSafety(args: string[]): { safety: string[]; rest: string[] } {
  let at = 0;
  while (args[at] === "-c") at += 2;
  return { safety: args.slice(0, at), rest: args.slice(at) };
}

function keyOf(command: string, rest: string[]): string {
  if (command === "gh") return `gh ${rest.slice(0, 2).join(" ")}`;
  if (rest[0] === "rev-parse") return rest.includes("refs/remotes/origin/main") ? "git remote-main" : "git has-commits";
  if (rest[0] === "config") return `git config ${rest[1]}`;
  if (rest[0] === "remote") return "git remote get-url";
  return `git ${rest[0]}`;
}

/** The id git gives a file's content. Worked out here the way git documents it, apart from the publisher's own code. */
function gitBlobId(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest("hex");
}

function filesUnder(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path.join(current, entry.name));
    }
  };
  walk(dir, "");
  return files;
}

/** What a real clone folder has at the least: a .git folder with HEAD and refs. */
const GIT_FOLDER = { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/.keep": "" };

function makeRig(options: { cloned?: boolean; remoteFiles?: Record<string, string>; pollMs?: number; liveTimeoutMs?: number; privateStrings?: string[] } = {}) {
  const root = tempDir();
  const config = parseConfig({ OVERNIGHT_DATA_DIR: path.join(root, "data"), GITHUB_PAGES_REPO: REPO });
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const cloneDir = path.join(paths.pagesClone, REPO);
  const distDir = path.join(root, "site");
  writeTree(distDir, { "index.html": "<h1>made-up app</h1>\n", "assets/app-Ab12.js": "console.log(1)\n", "assets/_chunk.css": "body{}\n" });

  const remoteFiles = options.remoteFiles ?? { ".nojekyll": "", "README.md": "# made-up apps\n" };
  if (options.cloned) writeTree(cloneDir, { ...GIT_FOLDER, ...remoteFiles });

  const calls: Call[] = [];
  /** Scripted answers by key, one per call; the default answer is used once they run out. */
  const answers: Record<string, RunResult[]> = {};
  /** Called at the start of a command, by key. For tests that need something to happen mid-way. */
  const hooks: Record<string, (call: Call) => void> = {};
  const state = {
    user: JSON.stringify({ login: OWNER, id: 4242 }),
    origin: REMOTE,
    /** Whether our clone has any commit. A fresh clone has them exactly when GitHub has a main branch. */
    hasCommits: true,
    /** Whether GitHub has a main branch. */
    remoteMain: true,
    /** What "git ls-remote" prints when GitHub has no main branch. */
    otherRemoteRefs: "",
  };
  /** What each push sent: the files under the app's folder at that moment. */
  const pushes: Array<Record<string, string>> = [];
  /** The folder named in the latest "git add": the app being published. */
  let lastAdded = "";

  const run: CommandRunner = async (command, args, runOptions) => {
    const { safety, rest } = command === "git" ? splitSafety(args) : { safety: [], rest: args };
    const key = keyOf(command, rest);
    const call: Call = { key, command, args: rest, safety, cwd: runOptions.cwd, env: runOptions.env, timeoutMs: runOptions.timeoutMs, signal: runOptions.signal };
    calls.push(call);
    hooks[key]?.(call);
    const scripted = answers[key]?.shift();
    if (scripted) return scripted;
    switch (key) {
      case "gh api user":
        return ok(`${state.user}\n`);
      case "git clone":
        writeTree(rest[2] ?? "", { ...GIT_FOLDER, ...(state.remoteMain ? remoteFiles : {}) });
        state.hasCommits = state.remoteMain;
        return ok();
      case "git remote get-url":
        return ok(`${state.origin}\n`);
      case "git has-commits":
        return state.hasCommits ? ok(`${MAIN_AT}\n`) : failed();
      case "git remote-main":
        return state.remoteMain ? ok(`${MAIN_AT}\n`) : failed();
      case "git ls-remote":
        return ok(state.remoteMain ? `${MAIN_AT}\trefs/heads/main\n` : state.otherRemoteRefs);
      case "git add":
        lastAdded = rest[3] ?? "";
        return ok();
      case "git ls-files": {
        const slug = rest.at(-1) ?? "";
        const staged = Object.entries(filesUnder(path.join(runOptions.cwd ?? "", slug))).map(([name, content]) => `100644 ${gitBlobId(content)} 0\t${slug}/${name}`);
        return ok(staged.map((entry) => `${entry}\0`).join(""));
      }
      case "git log": {
        // Like git: the names and addresses come from the four variables in its environment.
        const env = runOptions.env ?? {};
        return ok(`${env.GIT_AUTHOR_NAME}\n${env.GIT_AUTHOR_EMAIL}\n${env.GIT_COMMITTER_NAME}\n${env.GIT_COMMITTER_EMAIL}\n${state.remoteMain ? MAIN_AT : ""}\n`);
      }
      case "git push": {
        const files = Object.fromEntries(Object.entries(filesUnder(path.join(runOptions.cwd ?? "", lastAdded))).map(([name, content]) => [name, content.toString("utf8")]));
        pushes.push(files);
        return ok();
      }
      default:
        return ok();
    }
  };

  const fetched: string[] = [];
  /** What the web answers, one per look; "not found" once they run out. */
  const web: Array<{ status: number; body: string } | Error> = [];
  const live = (marker = MARKER, id = IDEA_ID) => ({ status: 200, body: JSON.stringify({ id, marker }) });
  /** Called at the start of every look at the web. */
  const onFetch: { hook: () => void } = { hook: () => {} };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    fetched.push(String(input));
    onFetch.hook();
    if (init?.signal?.aborted) throw new Error("made-up: the request was aborted");
    const next = web.shift() ?? { status: 404, body: "<html>made-up 404 page</html>" };
    if (next instanceof Error) throw next;
    return new Response(next.body, { status: next.status });
  }) as typeof fetch;

  const { logger, lines } = collectingLogger();
  const publisher = createPagesPublisher({
    paths,
    config,
    logger,
    run,
    fetchFn,
    pollMs: options.pollMs ?? 1,
    liveTimeoutMs: options.liveTimeoutMs ?? 2_000,
    privateStrings: async () => options.privateStrings ?? [],
    env: OUR_ENV,
  });
  const publish = (overrides: Partial<{ ideaId: string; slug: string; distDir: string; marker: string; signal: AbortSignal }> = {}) => publisher.publish({ ideaId: IDEA_ID, slug: SLUG, distDir, marker: MARKER, ...overrides });
  const byKey = (key: string) => calls.find((call) => call.key === key);
  /** Folders next to our clone: clones that were set aside, and temporary clones. */
  const beside = () => readdirSync(paths.pagesClone).filter((name) => name !== REPO);
  return { root, paths, cloneDir, distDir, calls, answers, hooks, state, pushes, fetched, web, live, onFetch, logLines: lines, publish, byKey, beside, keys: () => calls.map((call) => call.key) };
}

const FIRST_PUBLISH = [
  "gh api user",
  "git clone",
  "git remote-main",
  "git symbolic-ref",
  "git reset",
  "git clean",
  "git config user.name",
  "git config user.email",
  "git add",
  "git status",
  "git ls-files",
  "git commit",
  "git log",
  "git push",
];
const LATER_PUBLISH = ["gh api user", "git has-commits", "git remote get-url", "git fetch", ...FIRST_PUBLISH.slice(2)];

describe("the Pages publisher: a first publish", () => {
  it("clones the apps repo, copies dist under the slug with its marker file, pushes to main and waits for the marker", async () => {
    const rig = makeRig();
    rig.web.push({ status: 404, body: "not yet" }, rig.live());

    const result = await rig.publish();

    expect(result).toMatchObject({ ok: true, url: URL_LIVE });
    expect(rig.keys()).toEqual(FIRST_PUBLISH);
    expect(rig.byKey("gh api user")?.args).toEqual(["api", "user", "--jq", "{login: .login, id: .id}"]);
    // Cloned into a temporary folder, which only gets the clone's real name once the clone is complete.
    const clone = rig.byKey("git clone");
    expect(clone).toMatchObject({ args: ["clone", REMOTE, expect.stringMatching(/\/\.tmp-clone-\d+-[0-9a-f]{8}$/)], cwd: rig.paths.pagesClone });
    expect(path.dirname(clone?.args[2] ?? "")).toBe(rig.paths.pagesClone);
    expect(existsSync(path.join(rig.cloneDir, ".git"))).toBe(true);
    expect(rig.beside()).toEqual([]);
    // Brought to exactly what GitHub has on main, without a pull that could merge or get stuck.
    expect(rig.byKey("git symbolic-ref")?.args).toEqual(["symbolic-ref", "HEAD", "refs/heads/main"]);
    expect(rig.byKey("git reset")).toMatchObject({ args: ["reset", "--hard", "origin/main"], cwd: rig.cloneDir });
    expect(rig.byKey("git clean")?.args).toEqual(["clean", "-fdx"]);
    expect(rig.keys()).not.toContain("git pull");
    expect(rig.byKey("git add")?.args).toEqual(["add", "-A", "--", SLUG, ".nojekyll"]);
    expect(rig.byKey("git commit")?.args).toEqual(["commit", "-m", `Publish ${SLUG}`]);
    expect(rig.byKey("git push")).toMatchObject({ args: ["push", "-u", "origin", "main"], cwd: rig.cloneDir });

    // What went up: the app's files, plus the file that says which idea and which publish this is.
    expect(rig.pushes).toEqual([
      {
        "index.html": "<h1>made-up app</h1>\n",
        "assets/app-Ab12.js": "console.log(1)\n",
        "assets/_chunk.css": "body{}\n",
        "overnight.json": `${JSON.stringify({ id: IDEA_ID, marker: MARKER })}\n`,
      },
    ]);
    expect(existsSync(path.join(rig.cloneDir, ".nojekyll"))).toBe(true);

    // It looked at the marker file, with a different cache-busting query each time, until the marker was there.
    expect(rig.fetched).toHaveLength(2);
    for (const url of rig.fetched) expect(url.startsWith(`${URL_LIVE}overnight.json?cb=`)).toBe(true);
    expect(new Set(rig.fetched).size).toBe(2);
  });

  it("only ever runs gh and git by name, with time limits, with prompts switched off, and never forces anything", async () => {
    const rig = makeRig();
    rig.web.push(rig.live());
    await rig.publish();
    for (const call of rig.calls) {
      expect(["gh", "git"]).toContain(call.command);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(120_000);
      expect(call.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
      // No token is ever asked for or passed along, and nothing is ever forced.
      expect([...call.safety, ...call.args].join(" ")).not.toMatch(/token|--force|-f\b|\+main/);
    }
  });

  it("puts the same safety settings in front of every git command: no hooks, no signing, nothing that drops or rewrites files", async () => {
    const rig = makeRig();
    rig.web.push(rig.live());
    await rig.publish();
    expect([...GIT_SAFETY]).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "push.gpgSign=false", "-c", "core.excludesFile=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false"]);
    const git = rig.calls.filter((call) => call.command === "git");
    expect(git.length).toBeGreaterThan(10);
    for (const call of git) expect(call.safety, call.key).toEqual([...GIT_SAFETY]);
    for (const call of rig.calls.filter((entry) => entry.command === "gh")) expect(call.safety).toEqual([]);
  });

  it("adds .nojekyll when the repo does not have it yet", async () => {
    const rig = makeRig({ remoteFiles: { "README.md": "# made-up apps\n" } });
    rig.web.push(rig.live());
    expect((await rig.publish()).ok).toBe(true);
    expect(readFileSync(path.join(rig.cloneDir, ".nojekyll"), "utf8")).toBe("");
  });
});

describe("the Pages publisher: the environment git and gh run in", () => {
  it("is a short fixed list: nothing else of ours is passed on, least of all a token or an identity", async () => {
    const rig = makeRig();
    rig.web.push(rig.live());
    await rig.publish();
    const base = { HOME: "/made-up/home", PATH: "/made-up/bin:/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", LC_ALL: "C" };
    const identity = { GIT_AUTHOR_NAME: "Overnight", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "Overnight", GIT_COMMITTER_EMAIL: EMAIL };
    for (const call of rig.calls) expect(call.env, call.key).toEqual(call.command === "gh" ? base : { ...base, ...identity });
    const everything = JSON.stringify(rig.calls.map((call) => [call.env, call.args]));
    for (const leaked of ["made-up-token", "someone-else@", "Someone Else", "made-up-ssh", "agent.sock", "another-repo", "made-up-editor", "zebra"]) expect(everything).not.toContain(leaked);
  });

  it("scrubbedEnv passes on where gh keeps its login when that is set, and drops empty values", () => {
    expect(scrubbedEnv({ HOME: "/h", PATH: "/p", XDG_CONFIG_HOME: "/x", GH_CONFIG_DIR: "/g", USER: "zebra", LOGNAME: "zebra", GH_TOKEN: "made-up-token", GH_HOST: "made-up.example" })).toEqual({
      HOME: "/h",
      PATH: "/p",
      XDG_CONFIG_HOME: "/x",
      GH_CONFIG_DIR: "/g",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      LC_ALL: "C",
    });
    expect(scrubbedEnv({ HOME: "/h", PATH: "/p", XDG_CONFIG_HOME: "", GH_CONFIG_DIR: undefined })).toEqual({ HOME: "/h", PATH: "/p", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", LC_ALL: "C" });
  });
});

describe("the Pages publisher: whose name is on the commit", () => {
  it("commits as Overnight with the account's GitHub noreply address, set where nothing can override it", async () => {
    const rig = makeRig();
    rig.web.push(rig.live());
    await rig.publish();
    // The commit command's own environment carries all four values ...
    expect(rig.byKey("git commit")?.env).toMatchObject({ GIT_AUTHOR_NAME: "Overnight", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "Overnight", GIT_COMMITTER_EMAIL: EMAIL });
    // ... the clone's settings say the same ...
    expect(rig.byKey("git config user.name")?.args).toEqual(["config", "user.name", "Overnight"]);
    expect(rig.byKey("git config user.email")?.args).toEqual(["config", "user.email", EMAIL]);
    // ... and no other address appears anywhere.
    const addresses = rig.calls.flatMap((call) => [...call.args, ...Object.values(call.env ?? {})]).filter((text) => text.includes("@"));
    expect(new Set(addresses)).toEqual(new Set([EMAIL]));
  });

  it("looks at the finished commit and does not push it if any name or address on it is not Overnight's", async () => {
    for (const reported of [
      `Overnight\nsomeone-else@made-up.example\nOvernight\n${EMAIL}\n${MAIN_AT}\n`,
      `Overnight\n${EMAIL}\nOvernight\nsomeone-else@made-up.example\n${MAIN_AT}\n`,
      `Someone Else\n${EMAIL}\nOvernight\n${EMAIL}\n${MAIN_AT}\n`,
      `Overnight\n${EMAIL}\nSomeone Else\n${EMAIL}\n${MAIN_AT}\n`,
      "",
    ]) {
      const rig = makeRig({ cloned: true });
      rig.answers["git log"] = [ok(reported)];
      expect(await rig.publish()).toEqual({ ok: false, reason: "The new version's commit did not carry Overnight's GitHub no-reply address, so it was not pushed." });
      expect(rig.byKey("git log")?.args).toEqual(["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%P"]);
      expect(rig.keys()).not.toContain("git push");
      // The commit is taken back out of our copy.
      expect(rig.calls.slice(-2).map((call) => call.args)).toEqual([
        ["reset", "--hard", "origin/main"],
        ["clean", "-fdx"],
      ]);
      expect(rig.fetched).toEqual([]);
    }
  });

  it("does not push a commit that does not sit directly on what GitHub has", async () => {
    const rig = makeRig({ cloned: true });
    rig.answers["git log"] = [ok(`Overnight\n${EMAIL}\nOvernight\n${EMAIL}\n\n`)];
    expect(await rig.publish()).toEqual({ ok: false, reason: "The new version's commit does not follow what GitHub has, so it was not pushed." });
    expect(rig.keys()).not.toContain("git push");
  });
});

describe("the Pages publisher: a brand-new or odd apps repo", () => {
  it("makes the first commit, on main, only in a repo that has nothing in it at all", async () => {
    const rig = makeRig();
    rig.state.remoteMain = false;
    rig.web.push(rig.live());
    expect((await rig.publish()).ok).toBe(true);
    expect(rig.keys()).toEqual([
      "gh api user",
      "git clone",
      "git remote-main",
      "git ls-remote",
      "git has-commits",
      "git symbolic-ref",
      "git config user.name",
      "git config user.email",
      "git add",
      "git status",
      "git ls-files",
      "git commit",
      "git log",
      "git push",
    ]);
    expect(rig.byKey("git ls-remote")?.args).toEqual(["ls-remote", "origin"]);
    expect(rig.byKey("git push")?.args).toEqual(["push", "-u", "origin", "main"]);
  });

  it("never makes a first commit next to history: a repo that is not empty but has no main branch is refused", async () => {
    const rig = makeRig();
    rig.state.remoteMain = false;
    rig.state.otherRemoteRefs = `${MAIN_AT}\trefs/heads/gh-pages\n`;
    expect(await rig.publish()).toEqual({ ok: false, reason: "The apps repo on GitHub has no main branch although it is not empty. Overnight does not create one." });
    for (const key of ["git add", "git commit", "git push"]) expect(rig.keys()).not.toContain(key);
  });

  it("a first commit from an earlier try that was never pushed does not ride along: that clone is set aside", async () => {
    const rig = makeRig({ cloned: true });
    writeTree(rig.cloneDir, { "left-over-app/index.html": "<h1>never pushed</h1>\n" });
    rig.state.remoteMain = false;
    rig.state.hasCommits = true;
    rig.web.push(rig.live());
    expect((await rig.publish()).ok).toBe(true);
    expect(rig.keys()).toContain("git clone");
    expect(existsSync(path.join(rig.cloneDir, "left-over-app"))).toBe(false);
    // Set aside, never deleted.
    const aside = rig.beside();
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^overnight-apps\.aside-\d{8}T\d{6}-[0-9a-f]{6}$/);
    expect(readFileSync(path.join(rig.paths.pagesClone, aside[0] ?? "", "left-over-app/index.html"), "utf8")).toBe("<h1>never pushed</h1>\n");
  });
});

describe("the Pages publisher: publishing again", () => {
  it("reuses the clone, fetches, and replaces the app's folder completely", async () => {
    const rig = makeRig({ cloned: true });
    writeTree(path.join(rig.cloneDir, SLUG), { "index.html": "<h1>old</h1>\n", "assets/old-chunk.js": "old\n", "overnight.json": JSON.stringify({ id: IDEA_ID, marker: "an-older-marker" }) });
    writeTree(path.join(rig.cloneDir, "another-app"), { "index.html": "<h1>someone else</h1>\n" });
    rig.web.push(rig.live());

    const result = await rig.publish();

    expect(result.ok).toBe(true);
    expect(rig.keys()).toEqual(LATER_PUBLISH);
    expect(rig.byKey("git fetch")).toMatchObject({ args: ["fetch", "--prune", "origin"], cwd: rig.cloneDir });
    expect(Object.keys(rig.pushes[0] ?? {}).sort()).toEqual(["assets/_chunk.css", "assets/app-Ab12.js", "index.html", "overnight.json"]);
    expect(rig.pushes[0]?.["index.html"]).toBe("<h1>made-up app</h1>\n");
    // Other apps in the repo are not touched.
    expect(readFileSync(path.join(rig.cloneDir, "another-app/index.html"), "utf8")).toBe("<h1>someone else</h1>\n");
    expect(rig.beside()).toEqual([]);
  });

  it("is safe to repeat: a version an interrupted run already pushed is replaced by this one, with this publish's own marker", async () => {
    const rig = makeRig({ cloned: true });
    // What an earlier run pushed before it died, without the idea ever being recorded as published.
    writeTree(path.join(rig.cloneDir, SLUG), { "index.html": "<h1>made-up app</h1>\n", "overnight.json": `${JSON.stringify({ id: IDEA_ID, marker: `${IDEA_ID}-earlier-00000000` })}\n` });
    // GitHub Pages still serves the earlier marker for a moment: that is not "live".
    rig.web.push(rig.live(`${IDEA_ID}-earlier-00000000`), rig.live());

    const result = await rig.publish();

    expect(result).toMatchObject({ ok: true, url: URL_LIVE });
    expect(rig.pushes).toHaveLength(1);
    expect(rig.pushes[0]?.["overnight.json"]).toBe(`${JSON.stringify({ id: IDEA_ID, marker: MARKER })}\n`);
    expect(rig.fetched).toHaveLength(2);
    expect(rig.logLines.join("\n")).toContain("replacing the version of this app that is already in the apps repo");
  });

  it("refuses to overwrite a folder that belongs to a different app, or to nobody we know", async () => {
    const other = makeRig({ cloned: true });
    writeTree(path.join(other.cloneDir, SLUG), { "index.html": "<h1>theirs</h1>\n", "overnight.json": JSON.stringify({ id: "idea_20261001_00000000", marker: "x" }) });
    expect(await other.publish()).toEqual({ ok: false, reason: "The apps repo already has a different app under this folder name." });

    const unknown = makeRig({ cloned: true });
    writeTree(path.join(unknown.cloneDir, SLUG), { "index.html": "<h1>hand-made</h1>\n" });
    expect(await unknown.publish()).toEqual({ ok: false, reason: "The apps repo already has a different app under this folder name." });

    for (const rig of [other, unknown]) {
      expect(rig.keys()).not.toContain("git commit");
      expect(rig.keys()).not.toContain("git push");
    }
    expect(readFileSync(path.join(other.cloneDir, SLUG, "index.html"), "utf8")).toBe("<h1>theirs</h1>\n");
  });

  it("refuses a clone that points at a different repo", async () => {
    const elsewhere = makeRig({ cloned: true });
    elsewhere.state.origin = "https://github.com/someone-else/overnight-apps.git";
    expect(await elsewhere.publish()).toEqual({ ok: false, reason: "Our copy of the apps repo points at a different repo than the settings name." });
    expect(elsewhere.keys()).not.toContain("git push");
    expect(elsewhere.beside()).toEqual([]);
  });

  it("puts the clone back on main at what GitHub has, whatever branch or state it was left in", async () => {
    const rig = makeRig({ cloned: true });
    rig.web.push(rig.live());
    expect((await rig.publish()).ok).toBe(true);
    const sync = rig.calls.slice(rig.keys().indexOf("git fetch"), rig.keys().indexOf("git config user.name")).map((call) => call.args);
    expect(sync).toEqual([
      ["fetch", "--prune", "origin"],
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["reset", "--hard", "origin/main"],
      ["clean", "-fdx"],
    ]);
  });
});

describe("the Pages publisher: a clone that was cut off or damaged", () => {
  /** Publish with a clone folder in the given bad state and expect it set aside and replaced. */
  async function expectFreshClone(prepare: (rig: ReturnType<typeof makeRig>) => void) {
    const rig = makeRig({ cloned: true });
    writeTree(rig.cloneDir, { "left-over.txt": "from the broken clone\n" });
    prepare(rig);
    rig.web.push(rig.live());

    const result = await rig.publish();

    expect(result).toMatchObject({ ok: true, url: URL_LIVE });
    expect(rig.keys()).toContain("git clone");
    // The old folder was renamed aside, with everything in it, and never deleted.
    const aside = rig.beside();
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^overnight-apps\.aside-/);
    expect(readFileSync(path.join(rig.paths.pagesClone, aside[0] ?? "", "left-over.txt"), "utf8")).toBe("from the broken clone\n");
    // The fresh clone is what got published from, and it never made a first commit of its own.
    expect(existsSync(path.join(rig.cloneDir, "left-over.txt"))).toBe(false);
    expect(rig.keys()).not.toContain("git ls-remote");
    expect(rig.pushes).toHaveLength(1);
    expect(rig.logLines.join("\n")).toContain("our copy of the apps repo was not usable");
    return rig;
  }

  it("a clone with no commits (git was killed mid-clone) is set aside and cloned again", async () => {
    const rig = await expectFreshClone((r) => {
      r.answers["git has-commits"] = [failed()];
    });
    expect(rig.keys().slice(0, 4)).toEqual(["gh api user", "git has-commits", "git clone", "git remote-main"]);
  });

  it("so is a clone a killed git left locked", async () => {
    await expectFreshClone((r) => writeFileSync(path.join(r.cloneDir, ".git", "index.lock"), ""));
    await expectFreshClone((r) => writeTree(r.cloneDir, { ".git/refs/remotes/origin/main.lock": "" }));
  });

  it("so is a folder that is not a git clone at all, or has lost its origin", async () => {
    const noGit = makeRig();
    writeTree(noGit.cloneDir, { "stray.txt": "x\n" });
    noGit.web.push(noGit.live());
    expect((await noGit.publish()).ok).toBe(true);
    expect(noGit.beside()).toHaveLength(1);
    expect(readFileSync(path.join(noGit.paths.pagesClone, noGit.beside()[0] ?? "", "stray.txt"), "utf8")).toBe("x\n");

    await expectFreshClone((r) => {
      r.answers["git remote get-url"] = [failed(2)];
    });
  });

  it("so is a clone that cannot be brought to what GitHub has, once; a second failure is reported", async () => {
    const healed = await expectFreshClone((r) => {
      r.answers["git reset"] = [failed(128)];
    });
    expect(healed.keys().filter((key) => key === "git clone")).toHaveLength(1);

    const stuck = makeRig({ cloned: true });
    stuck.answers["git reset"] = [failed(128), failed(128)];
    expect(await stuck.publish()).toEqual({ ok: false, reason: "Our copy of the apps repo could not be cleaned up." });
    expect(stuck.keys().filter((key) => key === "git clone")).toHaveLength(1);
    expect(stuck.keys()).not.toContain("git push");
  });

  it("a fetch that fails is the network's fault, not the clone's: the clone stays where it is", async () => {
    const rig = makeRig({ cloned: true });
    rig.answers["git fetch"] = [failed(128)];
    expect(await rig.publish()).toEqual({ ok: false, reason: "Could not update our copy of the apps repo from GitHub." });
    expect(rig.beside()).toEqual([]);
    expect(rig.keys()).not.toContain("git clone");
    expect(rig.keys()).not.toContain("git push");
  });

  it("a clone that fails or is cut off never becomes 'our clone', and its temporary folder is removed", async () => {
    const rig = makeRig();
    rig.hooks["git clone"] = (call) => writeTree(call.args[2] ?? "", { ".git/HEAD": "ref: refs/heads/main\n", ".git/config": "[remote]\n" });
    rig.answers["git clone"] = [hung()];
    expect(await rig.publish()).toEqual({ ok: false, reason: "Could not copy the apps repo from GitHub." });
    expect(existsSync(rig.cloneDir)).toBe(false);
    expect(readdirSync(rig.paths.pagesClone)).toEqual([]);

    // The next publish simply clones again.
    rig.hooks["git clone"] = () => {};
    rig.web.push(rig.live());
    expect((await rig.publish()).ok).toBe(true);
  });

  it("removes a temporary clone that a killed run left behind", async () => {
    const rig = makeRig({ cloned: true });
    writeTree(path.join(rig.paths.pagesClone, ".tmp-clone-4242-0a1b2c3d"), { ".git/HEAD": "x\n", "half.txt": "x\n" });
    rig.web.push(rig.live());
    expect((await rig.publish()).ok).toBe(true);
    expect(rig.beside()).toEqual([]);
  });
});

describe("the Pages publisher: what is pushed is what was verified", () => {
  it("refuses a dist holding .git, .gitignore, .gitattributes or .gitmodules, in any spelling", async () => {
    for (const [name, spelled] of [
      [".gitignore", ".gitignore"],
      ["assets/.GITIGNORE", ".gitignore"],
      [".gitattributes", ".gitattributes"],
      [".gitmodules", ".gitmodules"],
      [".Git/config", ".git"],
    ] as const) {
      const rig = makeRig({ cloned: true });
      writeTree(rig.distDir, { [name]: "overnight.json\n" });
      expect(await rig.publish(), name).toEqual({ ok: false, reason: `The built app (dist) contains an entry named "${spelled}", which is not allowed.` });
      expect(rig.keys()).not.toContain("git add");
      expect(rig.keys()).not.toContain("git push");
    }
  });

  it("stops when the repo's own ignore rules would leave a file out, before anything is committed", async () => {
    const rig = makeRig({ cloned: true });
    rig.answers["git status"] = [ok(`A  ${SLUG}/index.html\n!! ${SLUG}/overnight.json\n`)];
    expect(await rig.publish()).toEqual({ ok: false, reason: "The apps repo's ignore rules would leave some of the app's files out, so nothing was published." });
    expect(rig.byKey("git status")?.args).toEqual(["status", "--porcelain", "--ignored", "--", SLUG]);
    expect(rig.keys()).not.toContain("git commit");
    expect(rig.keys()).not.toContain("git push");
    expect(rig.keys().slice(-2)).toEqual(["git reset", "git clean"]);
  });

  it("stops when what git staged is not, file for file and byte for byte, what was copied", async () => {
    const entry = (name: string, content: string) => `100644 ${gitBlobId(Buffer.from(content))} 0\t${SLUG}/${name}\0`;
    const all = entry("index.html", "<h1>made-up app</h1>\n") + entry("assets/app-Ab12.js", "console.log(1)\n") + entry("assets/_chunk.css", "body{}\n") + entry("overnight.json", `${JSON.stringify({ id: IDEA_ID, marker: MARKER })}\n`);
    const cases: Record<string, string> = {
      "a file is missing": all.replace(entry("assets/_chunk.css", "body{}\n"), ""),
      "a file was rewritten on the way in": all.replace(entry("assets/app-Ab12.js", "console.log(1)\n"), entry("assets/app-Ab12.js", "console.log(1)\r\n")),
      "there is an extra file": all + entry("extra.txt", "x\n"),
      "nothing is staged": "",
      "the listing cannot be read": "made-up nonsense\0",
    };
    for (const [what, staged] of Object.entries(cases)) {
      const rig = makeRig({ cloned: true });
      rig.answers["git ls-files"] = [ok(staged)];
      expect(await rig.publish(), what).toEqual({ ok: false, reason: "The files about to be published did not match the files that were tested, so nothing was published." });
      expect(rig.byKey("git ls-files")?.args).toEqual(["ls-files", "-s", "-z", "--", SLUG]);
      expect(rig.keys(), what).not.toContain("git commit");
    }
    // The same listing, complete and correct, goes through.
    const fine = makeRig({ cloned: true });
    fine.answers["git ls-files"] = [ok(all)];
    fine.web.push(fine.live());
    expect((await fine.publish()).ok).toBe(true);
  });

  it("refuses a dist that names this Mac or the path of its home folder", async () => {
    const rig = makeRig({ cloned: true, privateStrings: ["Zebras-MacBook-Pro", "/Users/zebra"] });
    writeTree(rig.distDir, { "assets/app.js.map": '{"sources":["/Users/zebra/x/src/main.ts"]}\n' });
    const result = await rig.publish();
    expect(result).toEqual({ ok: false, reason: "The built app contains this computer's name or the path of its home folder, which must not be published." });
    expect(rig.keys()).not.toContain("git add");
    expect(rig.logLines.join("\n")).not.toContain("zebra");
  });

  it("refuses a dist with a symbolic link in it, publishes nothing, and cleans the clone up", async () => {
    const rig = makeRig({ cloned: true });
    writeFileSync(path.join(rig.root, "made-up-private.txt"), "made-up private text\n");
    symlinkSync(path.join(rig.root, "made-up-private.txt"), path.join(rig.distDir, "leak.txt"));

    const result = await rig.publish();

    expect(result).toEqual({ ok: false, reason: "The built app (dist) contains a symbolic link, which is not allowed." });
    expect(rig.keys()).not.toContain("git add");
    expect(rig.keys()).not.toContain("git push");
    expect(rig.keys().slice(-2)).toEqual(["git reset", "git clean"]);
    expect(existsSync(path.join(rig.cloneDir, SLUG, "leak.txt"))).toBe(false);
  });

  it("refuses a dist with no index.html", async () => {
    const empty = makeRig({ cloned: true });
    mkdirSync(path.join(empty.root, "empty-site"));
    expect(await empty.publish({ distDir: path.join(empty.root, "empty-site") })).toEqual({ ok: false, reason: "The built app has no index.html." });
  });
});

describe("the Pages publisher: the slug guard", () => {
  it("refuses any slug that is not short, lowercase and boring, before running a single command", async () => {
    const rig = makeRig({ cloned: true });
    for (const slug of ["", "a", "-ab", "Tip-Splitter", "tip_splitter", "tip splitter", "../escape", "a/b", ".git", "..", "x".repeat(64), "tip-splitter\n"]) {
      const result = await rig.publish({ slug });
      expect(result, JSON.stringify(slug)).toEqual({ ok: false, reason: "The app's folder name is not one that can be published (lowercase letters, digits and dashes only)." });
    }
    expect(rig.calls).toEqual([]);
    expect(rig.fetched).toEqual([]);
  });

  it("accepts the shortest and the longest allowed slugs", async () => {
    for (const slug of ["ab", "9-lives", "x".repeat(63)]) {
      const rig = makeRig();
      rig.web.push(rig.live());
      expect(await rig.publish({ slug }), slug).toMatchObject({ ok: true, url: `https://${OWNER}.github.io/${REPO}/${slug}/` });
      expect(Object.keys(rig.pushes[0] ?? {})).toContain("overnight.json");
    }
  });

  it("refuses a made-up idea id or marker that could not be a file name", async () => {
    const rig = makeRig();
    expect((await rig.publish({ ideaId: "../x" })).ok).toBe(false);
    expect((await rig.publish({ marker: "short" })).ok).toBe(false);
    expect((await rig.publish({ marker: 'has"quotes-and-more' })).ok).toBe(false);
    expect(rig.calls).toEqual([]);
  });
});

describe("the Pages publisher: when something fails", () => {
  it("push refused: says so, never looks at the web, takes its commit back out of the clone, and knows nothing went up", async () => {
    const rig = makeRig({ cloned: true });
    rig.answers["git push"] = [failed(128)];

    const result = await rig.publish();

    expect(result).toEqual({ ok: false, reason: "Could not push the new version to GitHub." });
    expect(rig.fetched).toEqual([]);
    const afterPush = rig.calls.slice(rig.keys().indexOf("git push") + 1);
    expect(afterPush.map((call) => call.args)).toEqual([
      ["reset", "--hard", "origin/main"],
      ["clean", "-fdx"],
    ]);
    // What git printed is never logged and never becomes the reason.
    expect(rig.logLines.join("\n")).not.toContain("MADE-UP-TOOL-OUTPUT");
  });

  it("a push that hangs is stopped by its time limit, counts as failed, and is marked as possibly on GitHub", async () => {
    const rig = makeRig({ cloned: true });
    rig.answers["git push"] = [hung()];
    expect(await rig.publish()).toEqual({ ok: false, reason: "Could not push the new version to GitHub.", pushed: true });
  });

  it("pushed but never seen live: stops looking after the time limit and says exactly that, with the link; it is not a failed publish", async () => {
    const rig = makeRig({ cloned: true, pollMs: 5, liveTimeoutMs: 40 });

    const result = await rig.publish();

    expect(result).toEqual({ ok: true, url: URL_LIVE, liveAfterMs: null, confirmedLive: false, waitedMs: expect.any(Number) });
    if (result.ok && result.confirmedLive === false) {
      expect(result.waitedMs).toBeGreaterThanOrEqual(30);
      expect(result.waitedMs).toBeLessThan(5_000);
    }
    expect(rig.pushes).toHaveLength(1);
    expect(rig.fetched.length).toBeGreaterThanOrEqual(2);
    expect(rig.fetched.length).toBeLessThanOrEqual(9);
    // What was pushed stays: nothing is taken back out of our clone, and nothing is pushed twice.
    expect(rig.keys().slice(rig.keys().indexOf("git push") + 1)).toEqual([]);
    const log = rig.logLines.join("\n");
    expect(log).toContain("was not seen live before the wait ran out");
    expect(log).not.toContain("the new version is live");
  });

  it("seen live: says so explicitly, with how long it took", async () => {
    const rig = makeRig({ cloned: true });
    rig.web.push({ status: 404, body: "made-up 404" }, rig.live());
    const result = await rig.publish();
    expect(result).toEqual({ ok: true, url: URL_LIVE, liveAfterMs: expect.any(Number), confirmedLive: true });
    expect(rig.fetched).toHaveLength(2);
  });

  it("a page that only ever serves an OLDER version of this app is not seen live either", async () => {
    const rig = makeRig({ cloned: true, pollMs: 5, liveTimeoutMs: 30 });
    for (let look = 0; look < 20; look += 1) rig.web.push(rig.live("an-older-marker-000"));
    expect(await rig.publish()).toMatchObject({ ok: true, url: URL_LIVE, liveAfterMs: null, confirmedLive: false });
  });

  it("a push that could not be confirmed is still a failure: only a push that went through can be 'not seen live'", async () => {
    const rig = makeRig({ cloned: true, pollMs: 5, liveTimeoutMs: 30 });
    rig.answers["git push"] = [hung()];
    const result = await rig.publish();
    expect(result).toEqual({ ok: false, reason: "Could not push the new version to GitHub.", pushed: true });
    expect(rig.fetched).toEqual([]);
  });

  it("live means THIS build: an older marker, another idea's marker, a 200 that is not ours and a network error all mean 'not yet'", async () => {
    const rig = makeRig({ cloned: true });
    rig.web.push(
      rig.live("an-older-marker-000"),
      rig.live(MARKER, "idea_20261001_00000000"),
      { status: 200, body: "<html>made-up placeholder page</html>" },
      new Error("made-up network hiccup"),
      { status: 500, body: JSON.stringify({ id: IDEA_ID, marker: MARKER }) },
      rig.live(),
    );
    const result = await rig.publish();
    expect(result).toMatchObject({ ok: true, url: URL_LIVE });
    expect(rig.fetched).toHaveLength(6);
  });

  it("stops when gh is not logged in, or answers something that is not an account", async () => {
    const loggedOut = makeRig();
    loggedOut.answers["gh api user"] = [failed(1)];
    expect(await loggedOut.publish()).toEqual({ ok: false, reason: "GitHub did not say who is logged in. Is the GitHub CLI (gh) logged in on this Mac?" });

    const garbled = makeRig();
    garbled.answers["gh api user"] = [ok("not json at all\n")];
    expect(await garbled.publish()).toEqual({ ok: false, reason: "GitHub's answer about who is logged in could not be read." });

    const hostile = makeRig();
    hostile.answers["gh api user"] = [ok(`${JSON.stringify({ login: "evil/../../x", id: 1 })}\n`)];
    expect(await hostile.publish()).toEqual({ ok: false, reason: "GitHub's answer about who is logged in could not be read." });

    for (const rig of [loggedOut, garbled, hostile]) expect(rig.keys()).toEqual(["gh api user"]);
  });

  it("stops when the repo cannot be cloned", async () => {
    const noClone = makeRig();
    noClone.answers["git clone"] = [failed(128)];
    expect(await noClone.publish()).toEqual({ ok: false, reason: "Could not copy the apps repo from GitHub." });
    expect(noClone.keys()).not.toContain("git push");
  });
});

describe("the Pages publisher: being stopped", () => {
  it("runs nothing when the signal has already fired", async () => {
    const stop = new AbortController();
    stop.abort();
    const rig = makeRig({ cloned: true });
    expect(await rig.publish({ signal: stop.signal })).toEqual({ ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true });
    expect(rig.calls).toEqual([]);
  });

  it("hands the signal to every command except the ones that put our clone back in order", async () => {
    const stop = new AbortController();
    const rig = makeRig({ cloned: true });
    rig.answers["git push"] = [failed(1)];
    await rig.publish({ signal: stop.signal });
    const cleanUp = rig.calls.slice(-2);
    for (const call of rig.calls.slice(0, -2)) expect(call.signal, call.key).toBe(stop.signal);
    for (const call of cleanUp) expect(call.signal, call.key).toBeUndefined();
  });

  it("stopped before the push: nothing went up, the half-made commit is taken back, and it says it was stopped", async () => {
    const stop = new AbortController();
    const rig = makeRig({ cloned: true });
    rig.hooks["git commit"] = () => stop.abort();
    rig.answers["git commit"] = [{ stdout: "", stderr: "", exitCode: null, timedOut: false, stopped: true }];

    const result = await rig.publish({ signal: stop.signal });

    expect(result).toEqual({ ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true });
    expect(rig.keys()).not.toContain("git push");
    // Putting the clone back still happens, quickly: there are seconds left, not minutes.
    const cleanUp = rig.calls.slice(-2);
    expect(cleanUp.map((call) => call.args)).toEqual([
      ["reset", "--hard", "origin/main"],
      ["clean", "-fdx"],
    ]);
    for (const call of cleanUp) expect(call.timeoutMs).toBeLessThanOrEqual(3_000);
    expect(rig.fetched).toEqual([]);
  });

  it("stopped while the push was in flight: says so, and that the new version may be on GitHub", async () => {
    const stop = new AbortController();
    const rig = makeRig({ cloned: true });
    rig.hooks["git push"] = () => stop.abort();
    rig.answers["git push"] = [{ stdout: "", stderr: "", exitCode: null, timedOut: false, stopped: true }];
    expect(await rig.publish({ signal: stop.signal })).toEqual({ ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true, pushed: true });
    expect(rig.fetched).toEqual([]);
    expect(rig.keys().slice(-2)).toEqual(["git reset", "git clean"]);
  });

  it("stopped just as the wait for the page runs out: that is a stop, as before, never 'pushed but not seen live'", async () => {
    const stop = new AbortController();
    // One look only (the wait is shorter than the pause between looks), and the stop arrives during it.
    const rig = makeRig({ cloned: true, pollMs: 50, liveTimeoutMs: 10 });
    rig.onFetch.hook = () => stop.abort();
    const result = await rig.publish({ signal: stop.signal });
    expect(result).toEqual({ ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true, pushed: true });
    expect(rig.fetched).toHaveLength(1);
  });

  it("stopped while waiting for the page: returns at once instead of waiting out the ten minutes", async () => {
    const stop = new AbortController();
    const rig = makeRig({ cloned: true, pollMs: 60_000, liveTimeoutMs: 600_000 });
    rig.onFetch.hook = () => setTimeout(() => stop.abort(), 20);
    const started = Date.now();

    const result = await rig.publish({ signal: stop.signal });

    expect(result).toEqual({ ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true, pushed: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rig.fetched).toHaveLength(1);
    expect(rig.pushes).toHaveLength(1);
  });

  it("a page that is live the moment we are stopped still counts as published", async () => {
    const stop = new AbortController();
    const rig = makeRig({ cloned: true });
    rig.web.push(rig.live());
    rig.hooks["git push"] = () => setTimeout(() => stop.abort(), 0);
    const result = await rig.publish({ signal: stop.signal });
    // Either answer is right, depending on which came first; what must never happen is a third one.
    if (result.ok) expect(result.url).toBe(URL_LIVE);
    else expect(result).toEqual({ ok: false, reason: PUBLISH_STOPPED_REASON, stopped: true, pushed: true });
  });
});
