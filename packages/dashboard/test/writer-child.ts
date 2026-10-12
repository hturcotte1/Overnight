// SYNTHETIC: every line and idea this helper writes is made up ("synthetic line 12", "Invented idea 3"). None of it is Bee data.
//
// Test helper, started as its own process by beside-writer.test.ts. Not a test itself.
//   node writer-child.ts <database file> <least number of lines>
// It stands in for the listener: it opens the database with the real Store and keeps writing
// to it the way the listener does. A line about every four milliseconds, a detector run over
// every ten lines, and every fifth line an idea is made or moved one step along the state
// machine. It writes until it has been told "stop" AND has written the least number of lines.
// Then it reports its numbers to the test and ends:
//   { lines, ideas, moves, errors, worstMs, walBytes }
// worstMs is the slowest single write. walBytes is the size of SQLite's write-ahead file just
// before the Store was closed (closing tidies it away).
import { statSync } from "node:fs";
import { Store } from "@overnight/core";
import type { IdeaState } from "@overnight/core";

const file = process.argv[2];
const least = Number(process.argv[3] ?? 0);
if (file === undefined || !Number.isFinite(least)) throw new Error("usage: writer-child.ts <database file> <least number of lines>");

/** However long the test forgets about us, we do not write for ever. */
const MOST_LINES = 20_000;
const ROUTE: IdeaState[] = ["asked", "approved", "building", "built", "published", "delivered"];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Tell the test something, and wait until the message has really left. */
const tell = (message: unknown): Promise<void> => new Promise((resolve) => (process.send ? process.send(message, () => resolve()) : resolve()));

let stop = false;
process.on("message", (message) => {
  if (message === "stop") stop = true;
});

const store = new Store(file);
const conversation = store.resolveConversation({ uuid: `invented-writer-${process.pid}` }, new Date().toISOString());

let lines = 0;
let ideas = 0;
let moves = 0;
let errors = 0;
let worstMs = 0;
let uncovered: number[] = [];
/** The idea being walked along the state machine, and how far it has got. */
let walking: { id: string; step: number } | null = null;

/** Do one write with the real Store and remember the slowest. A write that throws is counted, not hidden. */
function write(action: () => void): void {
  const started = performance.now();
  try {
    action();
  } catch {
    errors += 1;
  }
  worstMs = Math.max(worstMs, performance.now() - started);
}

await tell("ready");
while (!(stop && lines >= least) && lines < MOST_LINES) {
  const now = new Date().toISOString();
  write(() => {
    const added = store.insertUtterance({ beeUtteranceId: null, conversationKey: conversation.key, text: `synthetic line ${lines} `.repeat(6), spokenAt: now, receivedAt: now, source: "stream" });
    if (!added.inserted || added.id === null) throw new Error("the line was not added");
    uncovered.push(added.id);
    lines += 1;
  });
  if (uncovered.length >= 10) {
    write(() => {
      store.recordDetectorRun({ conversationKey: conversation.key, ranAt: now, utteranceIds: uncovered, wordCount: uncovered.length * 18, outcome: "not_idea" });
      uncovered = [];
    });
  }
  if (lines % 5 === 0) {
    write(() => {
      if (walking === null) {
        const idea = store.createIdea({ title: `Invented idea ${ideas + 1}`, pitch: "An invented pitch.", quote: "an invented quote", confidence: 0.8, conversationKey: conversation.key, detectorRunId: null }, now);
        walking = { id: idea.id, step: 0 };
        ideas += 1;
      } else {
        const next = ROUTE[walking.step] as IdeaState;
        store.transitionIdea(walking.id, next, { note: `moved to ${next}` }, now);
        moves += 1;
        walking = walking.step + 1 < ROUTE.length ? { id: walking.id, step: walking.step + 1 } : null;
      }
    });
  }
  if (lines % 25 === 0) await tell({ lines });
  await sleep(4);
}

let walBytes = 0;
try {
  walBytes = statSync(`${file}-wal`).size;
} catch {
  // no write-ahead file: nothing was left in it
}
store.close();
await tell({ lines, ideas, moves, errors, worstMs: Math.round(worstMs * 100) / 100, walBytes });
process.exit(0);
