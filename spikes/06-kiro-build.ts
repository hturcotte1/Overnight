// Spike 6: can `kiro-cli chat --no-interactive` build a hello-world Vite app in an empty folder?
//
// Usage: node spikes/06-kiro-build.ts [model=auto] [timeoutMinutes=15]
// - Kiro works in a fresh folder under ~/.overnight/spikes/ (outside the repo).
// - Tools are limited to read, write and shell. Neither Kiro nor our own npm check afterwards is
//   given our environment (only HOME, PATH, TMPDIR), so no token held in an environment variable
//   reaches agent-written code. Both still run as the Mac user, outside any sandbox (SPEC §6).
// - We do not trust Kiro's exit code or its own report: afterwards this script runs
//   `npm ci && npm run build` itself and checks the app contract (SPEC §6).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { creditsUsed, runKiro } from "./lib/kiro.ts";
import { saveRaw, spikeDataDir, stamp } from "./lib/util.ts";

const model = process.argv[2] ?? "auto";
const timeoutMinutes = Number(process.argv[3] ?? 15);
const nodeBin = path.dirname(process.execPath);
const workspace = path.join(spikeDataDir(), "06-hello-vite");
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });

const PROMPT = `Build a tiny "hello world" web app in the current folder. Work only inside the current folder.

Requirements:
- A static single-page app built with Vite and vanilla TypeScript. No backend, no API keys, no login, no tracking.
- The page shows the heading "Hello from Overnight" and a button that counts clicks. The count is kept in localStorage.
- vite.config.ts sets base to './' so the built app works from a subfolder.
- "npm run build" writes the app to dist/ with index.html at its root.
- Include a short README.md.
- When you are done, run "npm install" and "npm run build" and make sure the build succeeds.
- Finally write BUILD_NOTES.md with three lines: what you built, how you checked it, and anything left undone.

Do not run a dev server, do not open a browser, and do not use git.`;

const before = await creditsUsed(workspace);
console.log(`${stamp()} asking Kiro (model ${model}) to build in ${workspace}. Hard limit ${timeoutMinutes} min.`);

const run = await runKiro(["chat", "--no-interactive", "--model", model, "--trust-tools", "read,write,shell", PROMPT], {
  cwd: workspace,
  timeoutMs: timeoutMinutes * 60_000,
  extraPath: [nodeBin],
});
saveRaw("06-kiro-build.jsonl", { at: stamp(), exitCode: run.exitCode, timedOut: run.timedOut, ms: run.ms, error: run.error, stdout: run.stdout.slice(-20_000), stderr: run.stderr.slice(-20_000) });
if (run.error) {
  console.error(`${stamp()} ${run.error}`);
  process.exit(1);
}

const toolLines = run.stderr.split("\n").filter((line) => line.startsWith("[tool]"));
console.log(
  JSON.stringify({
    at: stamp(),
    label: "kiro finished",
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    minutes: Number((run.ms / 60_000).toFixed(1)),
    toolLines: toolLines.length,
    refusedOrDenied: run.stderr.split("\n").filter((line) => /denied|refused|not allowed|rejected/i.test(line)).slice(0, 5),
    replyTail: run.stdout.trim().split("\n").slice(-6),
  }, null, 2),
);

// Our own check of the result. It runs code the agent wrote (package.json scripts,
// vite.config.ts, install scripts), so it gets the same stripped-down environment as Kiro.
const checkEnv = { HOME: homedir(), PATH: `${nodeBin}:/usr/bin:/bin`, TMPDIR: tmpdir(), NO_COLOR: "1" };
function sh(cmd: string, args: string[]): { ok: boolean; tail: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: workspace, timeout: 300_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: checkEnv });
    return { ok: true, tail: out.trim().split("\n").slice(-3).join(" | ") };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { ok: false, tail: (e.stderr || e.message).trim().split("\n").slice(-3).join(" | ").slice(0, 400) };
  }
}

const has = (file: string) => existsSync(path.join(workspace, file));
const read = (file: string) => {
  const full = path.join(workspace, file);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : "";
};
const filesUnder = (dir: string) => (has(dir) ? readdirSync(path.join(workspace, dir), { recursive: true }).map((name) => path.join(dir, String(name))) : []);
const files = existsSync(workspace) ? readdirSync(workspace).filter((name) => name !== "node_modules") : [];

rmSync(path.join(workspace, "dist"), { recursive: true, force: true });
const install = has("package-lock.json") ? sh("npm", ["ci", "--no-fund", "--no-audit"]) : sh("npm", ["install", "--no-fund", "--no-audit"]);
const build = install.ok ? sh("npm", ["run", "build"]) : { ok: false, tail: "skipped: install failed" };
const html = read("dist/index.html");
const viteConfig = read("vite.config.ts") + read("vite.config.js");

const checks = {
  files,
  hasPackageLock: has("package-lock.json"),
  installOk: install.ok,
  buildOk: build.ok,
  buildTail: build.tail,
  distIndexHtml: html.length > 0,
  baseIsRelative: /base:\s*['"]\.\/['"]/.test(viteConfig),
  assetPathsRelative: html.length > 0 && !/(src|href)="\//.test(html),
  headingInBuiltApp: /Hello from Overnight/.test(html + filesUnder(path.join("dist", "assets")).map(read).join("")),
  hasReadme: has("README.md"),
  hasBuildNotes: has("BUILD_NOTES.md"),
  usesLocalStorage: filesUnder("src").some((file) => /localStorage/.test(read(file))),
};
const after = await creditsUsed(workspace);
const passed = checks.installOk && checks.buildOk && checks.distIndexHtml && checks.baseIsRelative && checks.assetPathsRelative;
console.log(JSON.stringify({ at: stamp(), label: "our checks", passed, ...checks, creditsBefore: before, creditsAfter: after }, null, 2));
process.exit(passed ? 0 : 1);
