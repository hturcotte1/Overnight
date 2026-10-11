// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// A stand-in for `overnight build`, run as a process of its own by stop-signal.test.ts so that a
// real stop signal can be sent to it. It runs the real night flow with the real command runner on
// a temp data folder. Kiro Crew, Kiro CLI and sandbox-exec are shell-script stand-ins that the
// test wrote; nothing real is started and nothing leaves the temp folder.
//
//   node stop-night.ts <data dir> <backend: crew | cli> <handler: own | none> <tools dir>
//
// "own": this program listens for SIGTERM itself and aborts deps.signal, as the command line does.
// "none": it does not listen at all, and the night flow's own listeners have to do the work.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger, dataPaths, ensureDataDirs, parseConfig, Store } from "@overnight/core";
import { createKiroCliBackend, createKiroCrewBackend, runBuildNight } from "../../src/index.ts";

const [dataDir = "", backendName = "", handler = "", tools = ""] = process.argv.slice(2);
if (!path.isAbsolute(dataDir) || !path.isAbsolute(tools)) throw new Error("usage: stop-night.ts <data dir> <crew|cli> <own|none> <tools dir>");

const paths = dataPaths(dataDir);
ensureDataDirs(paths);
const store = new Store(paths.database);
const config = parseConfig({ OVERNIGHT_DATA_DIR: dataDir, PAUSED: "false", MAX_BUILDS_PER_NIGHT: "5" });
const logger = createLogger({ name: "stop-night", file: path.join(paths.logs, "build.log"), write: () => {} });

// Two approved ideas: the first is being built when the stop comes, the second must never start.
const at = "2026-10-09T22:00:00.000Z";
const ids: string[] = [];
for (const title of ["Coin Flipper", "Dice Roller"]) {
  const conversation = store.resolveConversation({ uuid: `conv-${title}` }, at);
  const idea = store.createIdea({ title, pitch: "A made-up app for a test.", quote: "made-up quote for a test", confidence: 0.9, conversationKey: conversation.key, detectorRunId: null }, at);
  store.transitionIdea(idea.id, "asked", { askedAt: at }, at);
  store.transitionIdea(idea.id, "approved", { answeredAt: new Date(Date.parse(at) + ids.length * 60_000).toISOString() }, at);
  ids.push(idea.id);
}

// A stand-in for the gateway's cancel address, on a port of its own. It notes what it was asked.
const cancels: Array<{ url: string; method: string; hasSecret: boolean }> = [];
const gateway = createServer((request, response) => {
  cancels.push({ url: request.url ?? "", method: request.method ?? "", hasSecret: request.headers["x-internal-secret"] === "made-up-secret-0123456789abcdef" });
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true,"name":"made-up"}');
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
process.env.KIROCREW_PORT = String((gateway.address() as AddressInfo).port);

const crewHome = path.join(tools, "crew-home");
const crew = createKiroCrewBackend({ paths, logger, sandboxMode: "crew", kirocrewBinary: path.join(tools, "kirocrew"), crewHome, pollMs: 5_000 });
const cli = createKiroCliBackend({ paths, logger, kiroBinary: path.join(tools, "kiro-cli"), sandboxExec: path.join(tools, "sandbox-exec"), home: path.join(tools, "home"), repoRoot: path.join(tools, "repo") });

const controller = new AbortController();
let signalAt = 0;
if (handler === "own") {
  process.on("SIGTERM", () => {
    signalAt = Date.now();
    controller.abort();
  });
}

writeFileSync(path.join(tools, "ready.txt"), String(process.pid));
const result = await runBuildNight({ store, config, paths, backends: backendName === "crew" ? { primary: crew, fallback: cli } : { primary: cli, fallback: null }, logger, ...(handler === "own" ? { signal: controller.signal } : {}) });
const ideas = ids.map((id) => {
  const idea = store.getIdea(id);
  return { id, state: idea?.state, failureReason: idea?.failureReason, buildBackend: idea?.buildBackend };
});
gateway.close();
store.close();
writeFileSync(path.join(tools, "result.json"), JSON.stringify({ result, ideas, cancels, signalAt, resolvedAt: Date.now() }));
