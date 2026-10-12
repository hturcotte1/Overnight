// A small program for the tests of named pipes: it asks the dashboard's own readers about one
// file and prints the answer. It is run as its own process with a time limit, because the thing
// being tested for is a look that never comes back: in the test's own process that would stop
// every test, not fail one. Scratch files only; nothing here is Bee data.
import { readDatabase } from "../src/data/db.ts";
import { peekLock } from "../src/data/locks.ts";

const [what, file] = process.argv.slice(2);
if (file === undefined || (what !== "lock" && what !== "database")) {
  console.error("usage: pipe-child.ts lock|database <file>");
  process.exit(2);
}
const answer = what === "lock" ? peekLock(file) : readDatabase(file, { dayStart: "2026-10-10T13:00:00.000Z", month: { start: "2026-10-01T06:00:00.000Z", end: "2026-11-01T06:00:00.000Z" }, filming: { on: false, showQuoteFor: new Set() }, pausedByDefault: true });
console.log(JSON.stringify(answer));
