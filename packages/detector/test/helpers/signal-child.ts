// A small program for the stop-signal tests in kiro.test.ts. It is not a test itself: the test
// runs it as its own Node process, because it sends itself SIGTERM.
//
// It uses the real runner with a shell script standing in for kiro-cli (Kiro is never started;
// all text is made up), starts a detect(), and sends itself SIGTERM while the "chat" is running.
//
//   node signal-child.ts <order> <dataDir> <standIn>
//
// <order> says when the program adds its own SIGTERM handler, the way `overnight listen` does
// with process.once:
//   before    before the detector's first Kiro call
//   after     after it
//   in-front  after it, and put ahead of the detector's own handler
//   none      never: the detector's handler is the only one, so the signal must end the process
//
// When it reaches the end it prints one line of JSON. With "none" it never gets that far.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataPaths } from "@overnight/core";
import type { DetectorInput } from "@overnight/core";
import { createKiroDetector } from "../../src/index.ts";

const [order, dataDir, standIn] = process.argv.slice(2);
if (order === undefined || dataDir === undefined || standIn === undefined) throw new Error("usage: signal-child.ts <order> <dataDir> <standIn>");

const paths = dataPaths(dataDir);
const detector = createKiroDetector({ paths, kiroBinary: standIn, timeoutMs: 30_000 });
const input: DetectorInput = { utterances: [{ text: "Someone should build a little page that picks the next person.", spokenAt: "2026-03-01T19:00:09.000Z" }], recentTitles: [] };

// The stand-in adds a line here each time it is started as a chat.
const chatLog = path.join(paths.detectorKiroHome, "chats.log");
const chatsStarted = (): number => (existsSync(chatLog) ? readFileSync(chatLog, "utf8").split("\n").filter(Boolean).length : 0);

let ownHandlerRan = false;
const ownHandler = (): void => {
  ownHandlerRan = true; // a real program would begin its tidy shutdown here
};

if (order === "before") process.once("SIGTERM", ownHandler);
await detector.ensureSetup();
if (order === "after") process.once("SIGTERM", ownHandler);
if (order === "in-front") process.prependOnceListener("SIGTERM", ownHandler);

const inFlight = detector.detect(input);
while (chatsStarted() === 0) await new Promise((resolve) => setTimeout(resolve, 20));
const signalledAt = Date.now();
process.kill(process.pid, "SIGTERM");

const result = await inFlight;
const msToComeBack = Date.now() - signalledAt;
// Anything asked of the detector after the signal must not start Kiro either.
const afterwards = await detector.detect(input);

console.log(JSON.stringify({ ownHandlerRan, result, afterwards, msToComeBack, chats: chatsStarted() }));
