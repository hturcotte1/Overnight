// Test helper, started as its own process by store-open.test.ts. Not a test itself.
//   node upgrade-child.ts <database file> <hold for this many ms> <the upgrade, as SQL>
// It stands in for the program that got to an older database first. It locks the file for
// writing, prints "locked", keeps the lock for the time it was given, then does the upgrade and
// lets go. Whoever opens the file in between has to wait, and then finds the upgrade done.
import { writeSync } from "node:fs";
import Database from "better-sqlite3";

const [file, holdText, upgrade] = process.argv.slice(2);
const holdMs = Number(holdText);
if (file === undefined || upgrade === undefined || !Number.isFinite(holdMs)) throw new Error("usage: upgrade-child.ts <database file> <hold ms> <sql>");

const db = new Database(file);
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
// Written straight to the pipe: the test must hear this before the wait below, not after it.
writeSync(1, "locked\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
db.exec(upgrade);
db.exec("COMMIT");
db.close();
