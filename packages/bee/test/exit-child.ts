// Synthetic: used only by real-library.test.ts. It never talks to Bee.
//
// Started as `node exit-child.ts <path of fake-bee.ts>` with FAKE_BEE_PID_FILE set. It starts one
// bee command and one stream against stand-in programs that never finish, waits until both have
// noted their process ids, and then exits. The test checks that neither stand-in outlives it.
import { existsSync, readFileSync } from "node:fs";
import { createBeeClient } from "@beeai/cli/lib";
import { createBeeGateway } from "../src/index.ts";

const fakeBee = process.argv[2] ?? "";
const pidFile = process.env.FAKE_BEE_PID_FILE ?? "";
const gatewayFor = (scenario: string) => createBeeGateway({ client: createBeeClient({ command: process.execPath, baseArgs: ["--no-warnings", fakeBee, scenario] }), timeoutMs: 60_000 });

gatewayFor("hang").todoStatus(11).catch(() => {});
gatewayFor("stream-waits").stream(() => {});

const noted = (): number => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).length : 0);
const startedAt = Date.now();
const check = setInterval(() => {
  if (noted() < 2 && Date.now() - startedAt < 10_000) return;
  clearInterval(check);
  // What the listener does when its stop grace runs out, with both programs still running.
  process.exit(noted() === 2 ? 0 : 1);
}, 25);
