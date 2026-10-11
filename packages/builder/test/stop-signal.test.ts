// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// A real stop signal sent to a real process in the middle of a build (fixtures/stop-night.ts).
// Kiro Crew, Kiro CLI and sandbox-exec are shell-script stand-ins written here into a temp folder.
// What must happen, within 10 seconds: the wait ends, the Kiro Crew run is cancelled and its job
// removed (or Kiro CLI's process group is killed), the idea is recorded as build_failed with the
// reason "the build was stopped", nothing further is started, and the process finishes by itself.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_SKILL_FILE } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "stop-night.ts");
const JOB_ID = "76be9f71";

interface Outcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** From the stop signal to the end of the process. */
  msToExit: number;
  result: { built: string[]; failed: string[]; skipped: string };
  ideas: Array<{ id: string; state: string; failureReason: string | null; buildBackend: string | null }>;
  cancels: Array<{ url: string; method: string; hasSecret: boolean }>;
  /** What the stand-in kirocrew was asked, in order. */
  crewLog: string[];
  tools: string;
}

function executable(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

/** Stand-ins for everything the builder starts. They only ever touch `tools`. */
function writeTools(tools: string): void {
  const crewHome = path.join(tools, "crew-home");
  for (const dir of [path.join(crewHome, "cron-running"), path.join(crewHome, "cron-history"), path.join(crewHome, "skills", "overnight-build"), path.join(crewHome, "run"), path.join(tools, "home"), path.join(tools, "repo")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(crewHome, "config.json"), JSON.stringify({ agent: { sandbox: "strict" } }));
  writeFileSync(path.join(crewHome, "crons.json"), JSON.stringify({ version: 2, jobs: [] }));
  writeFileSync(path.join(crewHome, "skills", "overnight-build", "SKILL.md"), readFileSync(BUILD_SKILL_FILE, "utf8"));
  writeFileSync(path.join(crewHome, ".local_secret"), "made-up-secret-0123456789abcdef\n");
  // kirocrew: answers as the real one does, logs what it was asked, and "runs" a triggered job
  // for ever (the running marker stays until the test folder is removed).
  executable(
    path.join(tools, "kirocrew"),
    `#!/bin/sh
echo "$1 $2 $3" | /usr/bin/cut -c1-40 >> "${tools}/crew.log"
case "$2" in
  add) echo "Added job: ${JOB_ID} ($3) [At 3:00 AM MDT]";;
  trigger) echo '{}' > "${crewHome}/cron-running/${JOB_ID}.b717fc944da04eb7b8b5429b10c7e51d.json"; echo "Triggered job: made-up (${JOB_ID})";;
  remove) echo "Removed job: $3";;
esac
`,
  );
  executable(path.join(tools, "kiro-cli"), "#!/bin/sh\n# stand-in: never run directly\n");
  // sandbox-exec: skips its own options, then stands in for kiro-cli. A "chat" starts a helper of
  // its own (as an agent starts npm, which starts a build tool) and never finishes.
  executable(
    path.join(tools, "sandbox-exec"),
    `#!/bin/sh
while [ "$1" = "-f" ] || [ "$1" = "-D" ]; do shift 2; done
shift
case "$1" in
  settings) echo "false (global)";;
  chat) /bin/sleep 300 & echo "$$ $!" > "${tools}/chat.pids"; wait;;
esac
`,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

/** Start the stand-in `overnight build`, wait until its build is under way, send the signal, wait for the end. */
async function stopDuringBuild(backend: "crew" | "cli", handler: "own" | "none", signal: NodeJS.Signals): Promise<Outcome> {
  const tools = tempDir("overnight-stop-test-");
  const dataDir = path.join(tools, "data");
  writeTools(tools);
  const child = spawn(process.execPath, [FIXTURE, dataDir, backend, handler, tools], { stdio: ["ignore", "ignore", "pipe"], env: { HOME: path.join(tools, "home"), PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp" } });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ended = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal })));

  // The build is under way: Kiro Crew's job is triggered and being waited for, or Kiro CLI's chat runs.
  const crewLog = () => (existsSync(path.join(tools, "crew.log")) ? readFileSync(path.join(tools, "crew.log"), "utf8").trim().split("\n") : []);
  const underWay = backend === "crew" ? () => crewLog().some((line) => line.startsWith("cron trigger")) : () => existsSync(path.join(tools, "chat.pids"));
  if (!(await until(underWay, 20_000))) {
    child.kill("SIGKILL");
    throw new Error(`the stand-in build never got under way: ${stderr.slice(0, 500)}`);
  }
  // A moment more, so the night flow is inside its wait and not just past the trigger.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const sentAt = Date.now();
  child.kill(signal);
  const end = await Promise.race([ended, new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000))]);
  const msToExit = Date.now() - sentAt;
  if (end === null) {
    child.kill("SIGKILL");
    throw new Error(`the process was still running 15 seconds after ${signal}: ${stderr.slice(0, 500)}`);
  }
  if (!existsSync(path.join(tools, "result.json"))) throw new Error(`the process ended (code ${end.exitCode}, signal ${end.signal}) without finishing its night: ${stderr.slice(0, 500)}`);
  const written = JSON.parse(readFileSync(path.join(tools, "result.json"), "utf8")) as Pick<Outcome, "result" | "ideas" | "cancels">;
  return { ...end, msToExit, ...written, crewLog: crewLog(), tools };
}

function expectStopped(outcome: Outcome, backend: "kiro-crew" | "kiro-cli"): void {
  // It finished by itself, with its results written: not killed, not exited from under the build.
  expect(outcome.signal).toBeNull();
  expect(outcome.exitCode).toBe(0);
  expect(outcome.msToExit).toBeLessThan(10_000);
  const [first, second] = outcome.ideas;
  expect(outcome.result).toEqual({ built: [], failed: [first?.id], skipped: "stopped" });
  expect(first).toMatchObject({ state: "build_failed", failureReason: "the build was stopped", buildBackend: backend });
  // The second idea was never started.
  expect(second).toMatchObject({ state: "approved", buildBackend: null });
}

describe.skipIf(process.platform === "win32")("a real stop signal during a Kiro Crew build", () => {
  for (const [handler, signal] of [
    ["own", "SIGTERM"],
    ["none", "SIGTERM"],
    ["none", "SIGINT"],
    ["none", "SIGHUP"],
  ] as const) {
    it(`${signal}, ${handler === "own" ? "passed on by the command line as deps.signal" : "with nobody else listening"}: cancels the run, removes the job, records the stop, within 10 seconds`, async () => {
      const outcome = await stopDuringBuild("crew", handler, signal);
      expectStopped(outcome, "kiro-crew");
      // The run was cancelled at the gateway (removing a job does not end its run), then the job was removed.
      expect(outcome.cancels).toEqual([{ url: `/api/crons/${JOB_ID}/cancel`, method: "POST", hasSecret: true }]);
      expect(outcome.crewLog).toEqual([expect.stringMatching(/^cron add overnight-build-idea_/), `cron trigger ${JOB_ID}`, `cron remove ${JOB_ID}`]);
      // The cut-off build was not handed to the other builder.
      expect(existsSync(path.join(outcome.tools, "chat.pids"))).toBe(false);
    }, 40_000);
  }
});

describe.skipIf(process.platform === "win32")("a real stop signal during a Kiro CLI build", () => {
  for (const handler of ["own", "none"] as const) {
    it(`SIGTERM, ${handler === "own" ? "passed on by the command line as deps.signal" : "with nobody else listening"}: kills Kiro and everything it started, records the stop, within 10 seconds`, async () => {
      const outcome = await stopDuringBuild("cli", handler, "SIGTERM");
      expectStopped(outcome, "kiro-cli");
      const [chat, helper] = readFileSync(path.join(outcome.tools, "chat.pids"), "utf8").trim().split(" ").map(Number);
      expect(chat).toBeGreaterThan(0);
      expect(helper).toBeGreaterThan(0);
      expect(await until(() => !isAlive(chat ?? 0) && !isAlive(helper ?? 0), 3_000)).toBe(true);
      expect(outcome.crewLog).toEqual([]);
    }, 40_000);
  }
});
