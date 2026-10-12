// Synthetic test data: the account, repo, app files, addresses and links in this file are made up.
// The real publisher with the REAL git program, against a folder on this Mac that stands in for
// GitHub (a bare repo in a temp folder). Nothing leaves the machine: "gh" is answered here, the
// web is a fake that reads the stand-in repo, and git gets a made-up home folder, so the settings
// and the logins of whoever runs the tests are never read.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPaths, ensureDataDirs, parseConfig } from "@overnight/core";
import { describe, expect, it } from "vitest";
import { createPagesPublisher, NOT_SEEN_LIVE_NOTE, PUSHED_UNCONFIRMED_NOTE, reportPath, runCommand, runDeliver } from "../src/index.ts";
import type { CommandRunner } from "../src/index.ts";
import { collectingLogger, makeRig as makeDeliverRig, tempDir, TITLE, writeTree } from "./helpers.ts";

const OWNER = "made-up-owner";
const REPO = "overnight-apps";
const REMOTE = `https://github.com/${OWNER}/${REPO}.git`;
const EMAIL = `4242+${OWNER}@users.noreply.github.com`;
const IDEA_ID = "idea_20261010_feedc0de";
const SLUG = "tip-splitter";
const marker = (n: number) => `${IDEA_ID}-m${n}-0a1b2c3d`;

function gitWorks(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function makeRig(options: { emptyRemote?: boolean; userGitConfig?: string; ourEnv?: Record<string, string> } = {}) {
  const root = tempDir("overnight-publish-");
  const home = path.join(root, "home");
  mkdirSync(home);
  if (options.userGitConfig !== undefined) writeFileSync(path.join(home, ".gitconfig"), options.userGitConfig);
  // The environment for the test's own git calls: a made-up home, no system-wide settings.
  const cleanEnv = { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-such-gitconfig"), LC_ALL: "C" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });

  // "GitHub": a bare repo, with one commit on main unless the test wants it empty.
  const bare = path.join(root, "github.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", bare);
  const seed = path.join(root, "seed");
  if (!options.emptyRemote) {
    mkdirSync(seed);
    git(seed, "init", "--quiet", "-b", "main");
    writeFileSync(path.join(seed, ".nojekyll"), "");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=Seed", "-c", "user.email=seed@made-up.example", "commit", "--quiet", "-m", "seed");
    git(seed, "push", "--quiet", bare, "main");
  }

  const config = parseConfig({ OVERNIGHT_DATA_DIR: path.join(root, "data"), GITHUB_PAGES_REPO: REPO });
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const cloneDir = path.join(paths.pagesClone, REPO);
  const dist = path.join(root, "site");
  writeTree(dist, { "index.html": "<h1>made-up app</h1>\n", "assets/app-Ab12.js": "console.log(1)\n" });

  /** Names of the git commands that failed, for telling a refusal from a crash. */
  const failures: string[] = [];
  /** Called before a git command of the given name (clone, push, ...) runs. */
  const before: Record<string, () => void> = {};
  const run: CommandRunner = async (command, args, runOptions) => {
    if (command === "gh") return { stdout: `{"login":"${OWNER}","id":4242}\n`, stderr: "", exitCode: 0, timedOut: false };
    const verb = args.find((arg, index) => arg !== "-c" && args[index - 1] !== "-c") ?? "";
    // Our clone's origin really is the stand-in folder; the publisher is told it is the GitHub address.
    if (verb === "remote") return { stdout: `${REMOTE}\n`, stderr: "", exitCode: 0, timedOut: false };
    before[verb]?.();
    const result = await runCommand(
      command,
      args.map((arg) => (arg === REMOTE ? bare : arg)),
      { ...runOptions, env: { ...runOptions.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    if (result.exitCode !== 0) failures.push(verb);
    return result;
  };
  /**
   * The stand-in for GitHub Pages. While `shows` is true it serves what is on "GitHub" at that
   * moment; switched off, it stays on "not found" however long anyone waits. `onLook` is called
   * on every look, which can only happen once a push has gone through.
   */
  const web = { shows: true, looks: 0, onLook: () => {} };
  const fetchFn = (async (input: string | URL | Request) => {
    web.looks += 1;
    web.onLook();
    // https://<owner>.github.io/<repo>/<slug>/overnight.json?cb=...
    const file = new URL(String(input)).pathname.split("/").slice(2).join("/");
    try {
      if (!web.shows) throw new Error("not yet");
      return new Response(git(bare, "show", `main:${file}`), { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;

  const { logger, lines } = collectingLogger();
  const publisher = createPagesPublisher({ paths, config, logger, run, fetchFn, pollMs: 5, liveTimeoutMs: 300, privateStrings: async () => [], env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.ourEnv } });
  const publish = (n: number, signal?: AbortSignal) => publisher.publish({ ideaId: IDEA_ID, slug: SLUG, distDir: dist, marker: marker(n), ...(signal ? { signal } : {}) });
  /** The commits on "GitHub", newest first, as "author <address> | committer <address> | subject". */
  const commits = () => {
    try {
      return git(bare, "log", "--format=%an <%ae> | %cn <%ce> | %s", "main").trim().split("\n");
    } catch {
      return [];
    }
  };
  const published = (file: string) => git(bare, "show", `main:${file}`);
  const publishedFiles = () => git(bare, "ls-tree", "-r", "--name-only", "main").trim().split("\n").filter(Boolean);
  const beside = () => readdirSync(paths.pagesClone).filter((name) => name !== REPO);
  return { root, home, bare, seed, paths, cloneDir, dist, git, publisher, publish, commits, published, publishedFiles, beside, failures, before, web, logLines: lines };
}

const OURS = `Overnight <${EMAIL}> | Overnight <${EMAIL}> | Publish ${SLUG}`;
const SEED = "Seed <seed@made-up.example> | Seed <seed@made-up.example> | seed";

describe.skipIf(!gitWorks())("the Pages publisher with the real git program", () => {
  it("publishes, and publishes again, as fast-forward commits by Overnight with the noreply address", async () => {
    const rig = makeRig();
    expect(await rig.publish(1)).toMatchObject({ ok: true, url: `https://${OWNER}.github.io/${REPO}/${SLUG}/` });
    expect(rig.commits()).toEqual([OURS, SEED]);
    expect(rig.publishedFiles()).toEqual([".nojekyll", `${SLUG}/assets/app-Ab12.js`, `${SLUG}/index.html`, `${SLUG}/overnight.json`]);
    expect(JSON.parse(rig.published(`${SLUG}/overnight.json`))).toEqual({ id: IDEA_ID, marker: marker(1) });

    // A new build of the same idea: the folder is replaced completely.
    writeTree(rig.dist, { "index.html": "<h1>made-up app, second build</h1>\n", "assets/app-Cd34.js": "console.log(2)\n" });
    execFileSync("/bin/rm", [path.join(rig.dist, "assets/app-Ab12.js")]);
    expect((await rig.publish(2)).ok).toBe(true);
    expect(rig.commits()).toEqual([OURS, OURS, SEED]);
    expect(rig.publishedFiles()).toEqual([".nojekyll", `${SLUG}/assets/app-Cd34.js`, `${SLUG}/index.html`, `${SLUG}/overnight.json`]);
    expect(rig.published(`${SLUG}/index.html`)).toBe("<h1>made-up app, second build</h1>\n");
    expect(rig.failures).toEqual([]);
    expect(rig.beside()).toEqual([]);
  });

  it("uses the noreply address even when the environment Overnight was started in names someone else", async () => {
    // The review's finding: git's identity variables override the clone's settings.
    const rig = makeRig({
      ourEnv: { GIT_AUTHOR_NAME: "Someone Else", GIT_AUTHOR_EMAIL: "someone-else@made-up.example", GIT_COMMITTER_NAME: "Someone Else", GIT_COMMITTER_EMAIL: "someone-else@made-up.example", EMAIL: "someone-else@made-up.example" },
    });
    expect((await rig.publish(1)).ok).toBe(true);
    expect(rig.commits()).toEqual([OURS, SEED]);
  });

  it("is not steered by the user's own git settings: another identity, hooks, signing, ignore lists, line-ending conversion", async () => {
    const root = tempDir("overnight-hooks-");
    const hooks = path.join(root, "hooks");
    const ran = path.join(root, "a-hook-ran.txt");
    mkdirSync(hooks);
    // Each hook writes down its name and the repo it ran in.
    for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push", "post-checkout", "post-merge", "reference-transaction", "pre-auto-gc"]) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho "${hook} in $(basename "$PWD")" >> '${ran}'\n`);
      chmodSync(path.join(hooks, hook), 0o755);
    }
    const ignore = path.join(root, "global-ignore");
    writeFileSync(ignore, "overnight.json\n*.js\n");
    const attributes = path.join(root, "global-attributes");
    writeFileSync(attributes, "*.txt text eol=lf\n");
    const rig = makeRig({
      userGitConfig: [
        "[user]\n\tname = Someone Else\n\temail = someone-else@made-up.example\n",
        `[core]\n\thooksPath = ${hooks}\n\texcludesFile = ${ignore}\n\tattributesFile = ${attributes}\n\tautocrlf = true\n`,
        "[commit]\n\tgpgsign = true\n",
        "[gpg]\n\tprogram = /usr/bin/false\n",
        "[init]\n\tdefaultBranch = trunk\n",
      ].join(""),
    });
    const windowsText = "line one\r\nline two\r\n";
    writeTree(rig.dist, { "notes.txt": windowsText });

    expect(await rig.publish(1)).toMatchObject({ ok: true });

    expect(rig.commits()).toEqual([OURS, SEED]);
    // No hook ran in our clone, or anywhere else on our side. (The stand-in for GitHub is a folder
    // on this Mac, so ITS side of the push reads the same made-up settings and runs the hook that
    // watches its own branches; the real GitHub runs on GitHub's computers.)
    const hooksRun = existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : [];
    expect(hooksRun.filter((line) => line !== "reference-transaction in github.git")).toEqual([]);
    // Every file went up, byte for byte, the ignored names and the Windows line endings included.
    expect(rig.publishedFiles()).toEqual([".nojekyll", `${SLUG}/assets/app-Ab12.js`, `${SLUG}/index.html`, `${SLUG}/notes.txt`, `${SLUG}/overnight.json`]);
    expect(rig.published(`${SLUG}/notes.txt`)).toBe(windowsText);
    expect(rig.failures).toEqual([]);
  });

  it("recovers from a first clone that was cut off: sets it aside, clones again, and never makes a root commit next to history", async () => {
    // What "git clone" leaves when it is killed right after it set the folder up (our time limit uses SIGKILL).
    const rig = makeRig();
    mkdirSync(rig.cloneDir, { recursive: true });
    rig.git(rig.cloneDir, "init", "--quiet", "-b", "main");
    rig.git(rig.cloneDir, "remote", "add", "origin", rig.bare);

    for (const n of [1, 2, 3]) expect(await rig.publish(n), `publish ${n}`).toMatchObject({ ok: true });

    expect(rig.commits()).toEqual([OURS, OURS, OURS, SEED]);
    const aside = rig.beside();
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^overnight-apps\.aside-/);
    expect(existsSync(path.join(rig.paths.pagesClone, aside[0] ?? "", ".git"))).toBe(true);
  });

  it("recovers from a clone that a killed git left locked", async () => {
    const rig = makeRig();
    expect((await rig.publish(1)).ok).toBe(true);
    writeFileSync(path.join(rig.cloneDir, ".git", "index.lock"), "");
    expect(await rig.publish(2)).toMatchObject({ ok: true });
    expect(rig.commits()).toEqual([OURS, OURS, SEED]);
    expect(rig.beside()).toHaveLength(1);
  });

  it("is safe to repeat after dying between the push and the record: the next publish replaces that version cleanly", async () => {
    const rig = makeRig();
    // Run 1 pushes, then "dies" while waiting for the page: stopped, with the push already on GitHub.
    const stop = new AbortController();
    rig.before.push = () => setTimeout(() => stop.abort(), 150);
    const first = await rig.publish(1, stop.signal);
    // (Whether the stop caught it during the wait or just after the page showed up, the push went through.)
    expect(rig.commits()).toEqual([OURS, SEED]);
    expect(JSON.parse(rig.published(`${SLUG}/overnight.json`))).toEqual({ id: IDEA_ID, marker: marker(1) });
    if (!first.ok) expect(first).toMatchObject({ stopped: true, pushed: true });

    // Run 2 knows nothing of run 1 except what is in the clone and on GitHub.
    rig.before.push = () => {};
    expect(await rig.publish(2)).toMatchObject({ ok: true });
    expect(rig.commits()).toEqual([OURS, OURS, SEED]);
    expect(JSON.parse(rig.published(`${SLUG}/overnight.json`))).toEqual({ id: IDEA_ID, marker: marker(2) });
    expect(rig.failures).toEqual([]);
  });

  it("drops a commit an earlier run made but never pushed, even when GitHub has moved on since", async () => {
    const rig = makeRig();
    expect((await rig.publish(1)).ok).toBe(true);
    // An earlier run died after its commit: our clone is one commit ahead with stale content ...
    writeTree(rig.cloneDir, { "never-pushed-app/index.html": "<h1>never pushed</h1>\n" });
    rig.git(rig.cloneDir, "add", "-A");
    rig.git(rig.cloneDir, "-c", `user.name=Overnight`, "-c", `user.email=${EMAIL}`, "commit", "--quiet", "-m", "never pushed");
    // ... and meanwhile someone else pushed to GitHub, so the two histories have parted.
    rig.git(rig.seed, "pull", "--quiet", rig.bare, "main");
    writeFileSync(path.join(rig.seed, "README.md"), "# made-up apps\n");
    rig.git(rig.seed, "add", "-A");
    rig.git(rig.seed, "-c", "user.name=Seed", "-c", "user.email=seed@made-up.example", "commit", "--quiet", "-m", "readme");
    rig.git(rig.seed, "push", "--quiet", rig.bare, "main");

    expect(await rig.publish(2)).toMatchObject({ ok: true });

    expect(rig.commits()).toEqual([OURS, "Seed <seed@made-up.example> | Seed <seed@made-up.example> | readme", OURS, SEED]);
    expect(rig.publishedFiles()).not.toContain("never-pushed-app/index.html");
    expect(rig.beside()).toEqual([]);
  });

  it("when the apps repo's own ignore rules would drop a file, publishes nothing, says why, and says the same on a retry", async () => {
    const rig = makeRig();
    // Someone committed a .gitignore at the root of the apps repo that names our marker file.
    rig.git(rig.seed, "pull", "--quiet", rig.bare, "main");
    writeFileSync(path.join(rig.seed, ".gitignore"), "overnight.json\n");
    rig.git(rig.seed, "add", "-A");
    rig.git(rig.seed, "-c", "user.name=Seed", "-c", "user.email=seed@made-up.example", "commit", "--quiet", "-m", "ignore");
    rig.git(rig.seed, "push", "--quiet", rig.bare, "main");

    const reason = "The apps repo's ignore rules would leave some of the app's files out, so nothing was published.";
    expect(await rig.publish(1)).toEqual({ ok: false, reason });
    expect(await rig.publish(2)).toEqual({ ok: false, reason });
    expect(rig.publishedFiles()).toEqual([".gitignore", ".nojekyll"]);
    expect(rig.commits()).toHaveLength(2);
    // Nothing of the app is left lying in our clone either.
    expect(existsSync(path.join(rig.cloneDir, SLUG))).toBe(false);
  });

  it("refuses a dist that carries its own .gitignore, before git sees any of it", async () => {
    const rig = makeRig();
    writeFileSync(path.join(rig.dist, ".gitignore"), "overnight.json\n");
    expect(await rig.publish(1)).toEqual({ ok: false, reason: 'The built app (dist) contains an entry named ".gitignore", which is not allowed.' });
    expect(rig.commits()).toEqual([SEED]);
  });

  it("makes the first commit in a truly empty repo, on main, and builds on it afterwards", async () => {
    const rig = makeRig({ emptyRemote: true, userGitConfig: "[init]\n\tdefaultBranch = trunk\n" });
    expect(await rig.publish(1)).toMatchObject({ ok: true });
    expect(rig.commits()).toEqual([OURS]);
    expect(rig.publishedFiles()).toEqual([".nojekyll", `${SLUG}/assets/app-Ab12.js`, `${SLUG}/index.html`, `${SLUG}/overnight.json`]);
    expect((await rig.publish(2)).ok).toBe(true);
    expect(rig.commits()).toEqual([OURS, OURS]);
  });

  it("refuses a repo that has history but no main branch, and pushes nothing", async () => {
    const rig = makeRig({ emptyRemote: true });
    mkdirSync(rig.seed);
    rig.git(rig.seed, "init", "--quiet", "-b", "gh-pages");
    writeFileSync(path.join(rig.seed, "index.html"), "<h1>hand-made</h1>\n");
    rig.git(rig.seed, "add", "-A");
    rig.git(rig.seed, "-c", "user.name=Seed", "-c", "user.email=seed@made-up.example", "commit", "--quiet", "-m", "seed");
    rig.git(rig.seed, "push", "--quiet", rig.bare, "gh-pages");

    expect(await rig.publish(1)).toEqual({ ok: false, reason: "The apps repo on GitHub has no main branch although it is not empty. Overnight does not create one." });
    expect(rig.git(rig.bare, "for-each-ref", "--format=%(refname)").trim()).toBe("refs/heads/gh-pages");
  });

  it("a push GitHub refuses is never forced: the answer is a failure and GitHub keeps what it had", async () => {
    const rig = makeRig();
    // The stand-in "GitHub" refuses every push, the way a protected branch would.
    const hook = path.join(rig.bare, "hooks", "pre-receive");
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    expect(await rig.publish(1)).toEqual({ ok: false, reason: "Could not push the new version to GitHub." });
    expect(rig.commits()).toEqual([SEED]);
    // Our clone was put back to what GitHub has, so the refused commit cannot ride along later.
    expect(rig.git(rig.cloneDir, "log", "--format=%s").trim()).toBe("seed");
    expect(readFileSync(path.join(rig.cloneDir, ".nojekyll"), "utf8")).toBe("");
    expect(existsSync(path.join(rig.cloneDir, SLUG))).toBe(false);
  });
  it("pushed, but the page never shows it: the push is on GitHub, the answer says 'not seen live' with the link, and a later publish builds on it", async () => {
    const rig = makeRig();
    rig.web.shows = false;

    const first = await rig.publish(1);

    expect(first).toEqual({ ok: true, url: `https://${OWNER}.github.io/${REPO}/${SLUG}/`, liveAfterMs: null, confirmedLive: false, waitedMs: expect.any(Number) });
    // It looked more than once, and it really is on "GitHub".
    expect(rig.web.looks).toBeGreaterThan(1);
    expect(rig.commits()).toEqual([OURS, SEED]);
    expect(JSON.parse(rig.published(`${SLUG}/overnight.json`))).toEqual({ id: IDEA_ID, marker: marker(1) });
    // Our clone is left as it is after any successful push: at what GitHub has, with nothing lying about.
    expect(rig.git(rig.cloneDir, "status", "--porcelain").trim()).toBe("");
    expect(rig.git(rig.cloneDir, "rev-parse", "HEAD").trim()).toBe(rig.git(rig.bare, "rev-parse", "main").trim());

    // Later the page catches up, and a new build of the same idea goes out as usual.
    rig.web.shows = true;
    expect(await rig.publish(2)).toMatchObject({ ok: true, confirmedLive: true });
    expect(rig.commits()).toEqual([OURS, OURS, SEED]);
    expect(rig.failures).toEqual([]);
    expect(rig.beside()).toEqual([]);
  });

  describe("through runDeliver: the three ways a push can end", () => {
    /** The morning run with the real publisher and real git; the verifier, Bee and the clock are the usual fakes. */
    function morning() {
      const git = makeRig();
      const deliver = makeDeliverRig();
      const idea = deliver.idea("built");
      const link = `https://${OWNER}.github.io/${REPO}/${idea.slug}/`;
      const deps = { ...deliver.deps, publish: git.publisher };
      const onGitHub = () => JSON.parse(git.published(`${idea.slug}/overnight.json`)) as { id: string; marker: string };
      const report = () => JSON.parse(readFileSync(reportPath(deliver.paths, idea.id), "utf8")) as Record<string, unknown>;
      return { git, deliver, idea, link, deps, onGitHub, report };
    }
    const publishCommit = (slug: string | null) => `Overnight <${EMAIL}> | Overnight <${EMAIL}> | Publish ${slug}`;

    it("seen live: published, told, and the report says it was seen", async () => {
      const m = morning();
      expect(await runDeliver(m.deps)).toEqual({ delivered: [m.idea.id], failed: [], notified: [] });
      expect(m.git.commits()).toEqual([publishCommit(m.idea.slug), SEED]);
      expect(m.deliver.store.getIdea(m.idea.id)).toMatchObject({ state: "delivered", publishedUrl: m.link, note: null });
      expect(m.report()).toMatchObject({ ok: true, url: m.link, confirmedLive: true, timings: { liveAfterMs: expect.any(Number) } });
      expect(m.deliver.bee.todoCalls.map((call) => call.text)).toEqual([`☀️ Built overnight: ${TITLE} → ${m.link}`]);
    });

    it("pushed but not seen live in time: published with a note, told as usual, never 'couldn't finish', and not pushed again", async () => {
      const m = morning();
      m.git.web.shows = false;

      expect(await runDeliver(m.deps)).toEqual({ delivered: [m.idea.id], failed: [], notified: [], notSeenLive: [m.idea.id] });

      expect(m.git.commits()).toEqual([publishCommit(m.idea.slug), SEED]);
      expect(m.onGitHub().id).toBe(m.idea.id);
      expect(m.deliver.store.getIdea(m.idea.id)).toMatchObject({ state: "delivered", publishedUrl: m.link, note: NOT_SEEN_LIVE_NOTE, failureReason: null, failureNotifiedAt: null });
      expect(m.report()).toMatchObject({ ok: true, url: m.link, confirmedLive: false, note: NOT_SEEN_LIVE_NOTE, timings: { liveAfterMs: null } });
      expect(m.deliver.bee.todoCalls.map((call) => call.text)).toEqual([`☀️ Built overnight: ${TITLE} → ${m.link}`]);
      expect(m.deliver.logLines.join("\n")).toContain("was not seen live before the wait ran out");

      // The next morning changes nothing: no second push, no second to-do.
      expect(await runDeliver(m.deps)).toEqual({ delivered: [], failed: [], notified: [] });
      expect(m.git.commits()).toHaveLength(2);
      expect(m.deliver.bee.todoCalls).toHaveLength(1);
    });

    it("stopped after the push: stays built with the note, nobody is told, and the next run publishes again and tells once", async () => {
      const m = morning();
      const stop = new AbortController();
      m.git.web.shows = false;
      // The first look at the page can only happen after the push went through: stop right then.
      m.git.web.onLook = () => stop.abort();

      expect(await runDeliver({ ...m.deps, signal: stop.signal })).toEqual({ delivered: [], failed: [], notified: [], stopped: true });

      expect(m.git.commits()).toEqual([publishCommit(m.idea.slug), SEED]);
      const firstMarker = m.onGitHub().marker;
      expect(m.deliver.store.getIdea(m.idea.id)).toMatchObject({ state: "built", publishedUrl: null, note: PUSHED_UNCONFIRMED_NOTE, failureReason: null, failureNotifiedAt: null });
      expect(m.deliver.bee.todoCalls).toEqual([]);
      expect(existsSync(reportPath(m.deliver.paths, m.idea.id))).toBe(false);

      m.git.web.onLook = () => {};
      m.git.web.shows = true;
      expect(await runDeliver(m.deps)).toEqual({ delivered: [m.idea.id], failed: [], notified: [] });
      expect(m.git.commits()).toEqual([publishCommit(m.idea.slug), publishCommit(m.idea.slug), SEED]);
      expect(m.onGitHub().marker).not.toBe(firstMarker);
      expect(m.deliver.store.getIdea(m.idea.id)).toMatchObject({ state: "delivered", publishedUrl: m.link, note: null });
      expect(m.report()).toMatchObject({ confirmedLive: true });
      expect(m.deliver.bee.todoCalls).toHaveLength(1);
      expect(m.git.failures).toEqual([]);
    });

    it("stopped while the push itself was running, with nothing on GitHub: the note says the push was started, not that it was pushed", async () => {
      const m = morning();
      const stop = new AbortController();
      // "GitHub" takes the push in and then keeps it waiting: a hook of the stand-in repo, which
      // runs before anything is accepted. The stop lands right then, in the middle of the push.
      // (Left alone, the hook gives up after 20 seconds and refuses the push.)
      const reached = path.join(m.git.root, "push-reached-github");
      const hook = path.join(m.git.bare, "hooks", "pre-receive");
      mkdirSync(path.dirname(hook), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\n: > "${reached}"\nn=0\nwhile [ "$n" -lt 200 ]; do sleep 0.1; n=$((n + 1)); done\nexit 1\n`);
      chmodSync(hook, 0o755);
      let over = false;
      const stopMidPush = (async () => {
        while (!over && !existsSync(reached)) await new Promise((resolve) => setTimeout(resolve, 5));
        stop.abort();
      })();

      const summary = await runDeliver({ ...m.deps, signal: stop.signal });
      over = true;
      await stopMidPush;

      expect(summary).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
      // The push was under way, and nothing came of it: "GitHub" has no new version.
      expect(existsSync(reached)).toBe(true);
      expect(m.git.commits()).toEqual([SEED]);
      expect(m.git.web.looks).toBe(0);
      // Nobody can know that from this side, so the publisher counts a push as possibly out from
      // the moment it starts. The note may say the push was started, and no more than that.
      const note = m.deliver.store.getIdea(m.idea.id)?.note;
      expect(note).toBe(PUSHED_UNCONFIRMED_NOTE);
      expect(note).toBe("the push to GitHub was started, but Overnight was stopped before the link was confirmed; the next run publishes it again");
      expect(note).not.toMatch(/\bpushed\b/);
      expect(m.deliver.store.getIdea(m.idea.id)).toMatchObject({ state: "built", publishedUrl: null, failureReason: null, failureNotifiedAt: null });
      expect(m.deliver.bee.todoCalls).toEqual([]);
      expect(m.git.failures).toEqual(["push"]);

      // The next run publishes it, as the note promised: for the first time here, and told once.
      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      expect(await runDeliver(m.deps)).toEqual({ delivered: [m.idea.id], failed: [], notified: [] });
      expect(m.git.commits()).toEqual([publishCommit(m.idea.slug), SEED]);
      expect(m.deliver.store.getIdea(m.idea.id)).toMatchObject({ state: "delivered", publishedUrl: m.link, note: null });
      expect(m.deliver.bee.todoCalls).toHaveLength(1);
      expect(m.git.failures).toEqual(["push"]);
    });
  });
});
