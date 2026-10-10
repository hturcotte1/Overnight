// Spike 5: is Kiro Crew healthy, and does a scheduled job run a shell command at a set time?
//
// Usage: node spikes/05-crew-scheduled-job.ts
// Needs the Kiro Crew gateway running (`kirocrew gateway` or `kirocrew service install`).
// Uses zero-credit "command" jobs, which run a fixed shell line inside Crew's sandbox with no
// agent and no model. Each job appends one line to ~/.overnight/spikes/05-crew-cron.txt.
// The probes report only counts and status codes, never a secret or a file name.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { beeBinary, spikeDataDir, stamp } from "./lib/util.ts";

const kirocrew = path.join(homedir(), ".local", "bin", "kirocrew");
const nodeBin = path.dirname(process.execPath);
const out = path.join(spikeDataDir(), "05-crew-cron.txt");
writeFileSync(out, "");

// Quote a path for the `sh -c` line that Kiro Crew runs.
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function crew(args: string[]): { ok: boolean; text: string } {
  try {
    const text = execFileSync(kirocrew, args, {
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // The gateway inherits PATH from whoever starts it; these calls only talk to it.
      env: { HOME: homedir(), PATH: `${path.dirname(kirocrew)}:${nodeBin}:/usr/bin:/bin`, NO_COLOR: "1" },
    });
    return { ok: true, text };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, text: `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message };
  }
}
const lines = () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : []);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(marker: string, seconds: number): Promise<string | undefined> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const hit = lines().find((line) => line.startsWith(marker));
    if (hit) return hit;
    await sleep(1000);
  }
  return undefined;
}
function addJob(name: string, schedule: string[], command: string): string | undefined {
  const added = crew(["cron", "add", name, "", ...schedule, "--command", command, "--timeout", "30", "--timeout-secs", "60", "--no-persistent-session", "--minimal-context"]);
  // `cron add` prints "Added job: <id> (<name>) [...]", or an "Error: ..." line when it refuses the command.
  const id = added.text.match(/Added job: ([0-9a-f]+)/)?.[1];
  if (!id) {
    // Prefer Crew's own "Error: ..." line over any warning it printed first.
    const replyLines = added.text.trim().split("\n");
    const reason = replyLines.find((line) => line.startsWith("Error:")) ?? replyLines[0] ?? "";
    console.log(JSON.stringify({ at: stamp(), label: `job refused: ${name}`, reason: reason.slice(0, 200) }));
  }
  return id;
}
// `cron remove` (like `cron trigger`) exits 0 even when it fails, so read its reply.
function removeJob(id: string): void {
  const removed = crew(["cron", "remove", id]);
  if (!/Removed job/.test(removed.text)) console.log(JSON.stringify({ at: stamp(), label: "could not remove job", id, reply: removed.text.trim().slice(0, 120) }));
}

// 1. Health check. Exit code 0, a "ready" line and a running gateway mean a clean bill of health.
//    (Doctor says "ready" even when the gateway is stopped, so check that row ourselves.)
const doctor = crew(["doctor"]);
const doctorLines = doctor.text.split("\n");
const gatewayUp = doctorLines.some((line) => /^\s*gateway:/.test(line) && /running/.test(line) && !/not running/.test(line));
console.log(
  JSON.stringify({
    at: stamp(),
    label: "kirocrew doctor",
    clean: doctor.ok && /Kiro Crew is ready/.test(doctor.text) && gatewayUp,
    rows: doctorLines.filter((line) => /^\s*(kiro-cli|kiro auth|backend|approval|gateway):|Fix these issues/.test(line)).map((line) => line.trim()),
  }, null, 2),
);
if (!gatewayUp) {
  console.error("The Kiro Crew gateway is not running, so scheduled jobs cannot run. Start it with `kirocrew gateway` (or `kirocrew service install`) and run this again.");
  process.exit(1);
}

// 2. A one-shot job two minutes from now. Does it run, and on time?
const requestedAt = Date.now();
const oneShot = addJob("overnight-spike5-oneshot", ["--at", "in 2 minutes"], `date -u +oneshot-%H:%M:%SZ >> ${q(out)}`);
console.log(JSON.stringify({ at: stamp(), label: "one-shot job added", id: oneShot }));
const ran = oneShot ? await waitFor("oneshot-", 200) : undefined;
console.log(JSON.stringify({ at: stamp(), label: "one-shot job", ran: ran ?? "did not run within 200 s", secondsAfterRequest: ran ? Math.round((Date.now() - requestedAt) / 1000) : undefined }));
if (!ran) {
  process.exitCode = 1;
  if (oneShot) removeJob(oneShot); // a one-shot job that never fired stays in the store
}

// 3. A daily job set for 3:00 a.m., run on demand with `cron trigger`. This is how our own timer
//    can start the nightly build at an exact time (daily jobs otherwise start up to 59 min late).
//    The schedule must not be due now: a job already waiting out its delay answers HTTP 409.
const daily = addJob("overnight-spike5-trigger", ["--cron", "0 3 * * *", "--timezone", "America/Boise"], `date -u +triggered-%H:%M:%SZ >> ${q(out)}`);
if (daily) {
  const triggeredAt = Date.now();
  const trigger = crew(["cron", "trigger", daily]);
  const hit = await waitFor("triggered-", 30);
  console.log(JSON.stringify({ at: stamp(), label: "cron trigger", reply: trigger.text.trim().slice(0, 120), ran: hit ?? "did not run within 30 s", seconds: hit ? Math.round((Date.now() - triggeredAt) / 1000) : undefined }));
  if (!hit) process.exitCode = 1;
  removeJob(daily);
} else {
  process.exitCode = 1;
}

// 4. What can a job inside Crew's default sandbox reach? (Counts only; nothing secret is printed.)
const probes: Array<[string, string]> = [
  ["node", `node --version >> ${q(out)} 2>&1`],
  ["gh", `gh auth token 2>/dev/null | wc -c >> ${q(out)}; echo probe-gh-token-bytes-above >> ${q(out)}`],
  ["bee", `${q(beeBinary())} me --json 2>/dev/null | wc -c >> ${q(out)}; echo probe-bee-bytes-above >> ${q(out)}`],
  ["net", `curl -s -o /dev/null -w probe-net-http-%{http_code} --max-time 10 https://registry.npmjs.org/vite >> ${q(out)}; echo >> ${q(out)}`],
  // Crew refuses this one when the job is added, because the command names a credential folder.
  ["ssh", `ls ${q(path.join(homedir(), ".ssh"))} 2>/dev/null | wc -l >> ${q(out)}; echo probe-ssh-entries-above >> ${q(out)}`],
];
const added = probes.map(([name, command]) => [name, addJob(`overnight-probe-${name}`, ["--at", "in 1 minute"], command)] as const);
const netRan = await waitFor("probe-net-http-", 150);
await sleep(3000);
if (!netRan) {
  // The probes did not all fire. Remove whatever is still scheduled.
  process.exitCode = 1;
  for (const [, id] of added) if (id) removeJob(id);
}
console.log(JSON.stringify({ at: stamp(), label: "sandbox probes", acceptedJobs: added.filter(([, id]) => id).map(([name]) => name), output: lines().filter((line) => !/^(oneshot|triggered)-/.test(line)) }, null, 2));
