// Spike 7: does copying a dist/ folder into <slug>/ of a public repo with GitHub Pages turned on
// give a working link, how long does it take, and do we need a .nojekyll file?
//
// Usage: node spikes/07-pages-publish.ts [slug=hello-spike]
// Uses the GitHub CLI login for everything. No token is read, printed or stored by this script.
// The clone lives in ~/.overnight/spikes/<repo>, outside this repo.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spikeDataDir, stamp } from "./lib/util.ts";

const slug = process.argv[2] ?? "hello-spike";
const repoName = process.env.GITHUB_PAGES_REPO || "overnight-apps";
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hello-dist");

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 60_000): string {
  try {
    return execFileSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(e.stderr || e.message).trim().slice(0, 400)}`);
  }
}
function tryRun(cmd: string, args: string[], cwd?: string): string | undefined {
  try {
    return run(cmd, args, cwd);
  } catch {
    return undefined;
  }
}
const log = (label: string, detail: unknown = "") => console.log(JSON.stringify({ at: stamp(), label, detail }));

const owner = run("gh", ["api", "user", "--jq", ".login"]);
const email = run("gh", ["api", "user", "--jq", '"\\(.id)+\\(.login)@users.noreply.github.com"']);
const full = `${owner}/${repoName}`;
const siteUrl = `https://${owner}.github.io/${repoName}/${slug}/`;
const cloneDir = path.join(spikeDataDir(), repoName);

// 1. Create the repo if it is missing.
if (tryRun("gh", ["repo", "view", full, "--json", "name"]) === undefined) {
  run("gh", ["repo", "create", full, "--public", "--description", "Small web apps built overnight by Overnight. Each folder is one app."]);
  log("repo created", full);
} else {
  log("repo already exists", full);
}

// 2. Clone it (or reuse the clone) and make sure we are on main.
if (!existsSync(path.join(cloneDir, ".git"))) {
  run("git", ["clone", `https://github.com/${full}.git`, cloneDir], undefined, 120_000);
}
run("git", ["config", "user.name", "Overnight"], cloneDir);
run("git", ["config", "user.email", email], cloneDir);
if (tryRun("git", ["rev-parse", "--verify", "HEAD"], cloneDir) === undefined) {
  // Empty repo: no commits yet. Name the branch-to-be "main" whatever git's local default is.
  run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], cloneDir);
  writeFileSync(
    path.join(cloneDir, "README.md"),
    "# overnight-apps\n\nSmall web apps built overnight by [Overnight](https://github.com/" + owner + "/Overnight). Each folder is one app, served by GitHub Pages.\n",
  );
} else {
  run("git", ["pull", "--ff-only"], cloneDir, 120_000);
}

function publish(marker: string, message: string): number {
  const target = path.join(cloneDir, slug);
  rmSync(target, { recursive: true, force: true });
  cpSync(fixture, target, { recursive: true });
  const indexPath = path.join(target, "index.html");
  writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace("__BUILD_MARKER__", marker));
  run("git", ["add", "-A"], cloneDir);
  run("git", ["commit", "-m", message], cloneDir);
  run("git", ["push", "-u", "origin", "main"], cloneDir, 120_000);
  return Date.now();
}

async function status(url: string): Promise<{ code: number; body: string }> {
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    return { code: res.status, body: await res.text() };
  } catch {
    return { code: 0, body: "" };
  }
}

async function waitLive(marker: string, pushedAt: number, timeoutMin = 10): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    const { code, body } = await status(siteUrl);
    if (code === 200 && body.includes(marker)) return Math.round((Date.now() - pushedAt) / 1000);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return undefined;
}

async function report(phase: string, marker: string, pushedAt: number): Promise<void> {
  const seconds = await waitLive(marker, pushedAt);
  const script = await status(`${siteUrl}assets/app.js`);
  const probe = await status(`${siteUrl}assets/_probe.txt`);
  const build = tryRun("gh", ["api", `repos/${full}/pages/builds/latest`, "--jq", "{status, duration, error: .error.message}"]);
  log(phase, {
    url: siteUrl,
    liveAfterSeconds: seconds ?? "not live after 10 min",
    relativeScriptStatus: script.code,
    underscoreFileStatus: probe.code,
    latestBuild: build ? JSON.parse(build) : "unavailable",
  });
}

// 3. Phase A: publish WITHOUT .nojekyll, then turn Pages on.
rmSync(path.join(cloneDir, ".nojekyll"), { force: true });
const markerA = `A-${Date.now()}`;
const pushedA = publish(markerA, `Publish ${slug} (spike 7, phase A: no .nojekyll)`);
log("pushed phase A", markerA);

const existing = tryRun("gh", ["api", `repos/${full}/pages`, "--jq", "{status, html_url, build_type, source}"]);
if (existing === undefined) {
  const made = run("gh", ["api", "-X", "POST", `repos/${full}/pages`, "-f", "source[branch]=main", "-f", "source[path]=/", "--jq", "{status, html_url, build_type, source}"]);
  log("pages enabled", JSON.parse(made));
} else {
  log("pages already enabled", JSON.parse(existing));
}
await report("phase A result (no .nojekyll)", markerA, pushedA);

// 4. Phase B: add .nojekyll and publish again.
writeFileSync(path.join(cloneDir, ".nojekyll"), "");
const markerB = `B-${Date.now()}`;
const pushedB = publish(markerB, `Publish ${slug} (spike 7, phase B: with .nojekyll)`);
log("pushed phase B", markerB);
await report("phase B result (with .nojekyll)", markerB, pushedB);

log("pages settings", JSON.parse(run("gh", ["api", `repos/${full}/pages`, "--jq", "{status, html_url, build_type, source, https_enforced}"])));
