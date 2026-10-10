// Shared helper for the Kiro spikes: run `kiro-cli chat --no-interactive` with a hard timeout,
// a scrubbed environment (no tokens are passed through) and a chosen working folder.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export function kiroBinary(): string {
  const candidates = [
    path.join(homedir(), ".local", "bin", "kiro-cli"),
    "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli",
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`kiro-cli not found. Looked in: ${candidates.join(", ")}`);
  return found;
}

export type KiroRun = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; ms: number; error?: string };

// Kiro runs in its own process group so a timeout can kill everything it started. That also
// means Ctrl-C or a kill aimed at this script would not reach it, so pass those on ourselves.
const liveKiro = new Set<number>();
function killLiveKiro(): void {
  for (const pid of liveKiro) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  liveKiro.clear();
}
process.once("exit", killLiveKiro);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.once(signal, () => {
    killLiveKiro();
    process.exit(code);
  });
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
}

// Kiro has no per-run timeout flag and can hang (open bug), so the timeout and kill live here.
export function runKiro(args: string[], options: { cwd: string; kiroHome?: string; timeoutMs: number; extraPath?: string[] }): Promise<KiroRun> {
  const started = Date.now();
  // Only what kiro-cli needs. Nothing from the parent environment leaks into the agent's shell.
  const env: Record<string, string> = {
    HOME: homedir(),
    PATH: [...(options.extraPath ?? []), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    TMPDIR: tmpdir(),
    NO_COLOR: "1",
  };
  if (options.kiroHome) env.KIRO_HOME = options.kiroHome;

  return new Promise((resolve) => {
    const child = spawn(kiroBinary(), args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) liveKiro.add(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group: kiro-cli starts helpers and shell commands of its own.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    const finish = (exitCode: number | null, error?: string) => {
      clearTimeout(timer);
      if (child.pid) liveKiro.delete(child.pid);
      resolve({ stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode, timedOut, ms: Date.now() - started, error });
    };
    child.once("error", (error) => finish(null, `could not start kiro-cli: ${error.message}`));
    child.once("close", (code) => finish(code));
  });
}

// `/usage` prints a line like "Credits (12.34 of 1000 covered in plan)".
export async function creditsUsed(cwd: string): Promise<number | undefined> {
  const run = await runKiro(["chat", "--no-interactive", "/usage"], { cwd, timeoutMs: 90_000 });
  const match = run.stdout.match(/Credits \(([\d.]+) of/);
  return match ? Number(match[1]) : undefined;
}
