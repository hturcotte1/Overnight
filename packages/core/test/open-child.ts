// Test helper, started as its own process by store-open.test.ts. Not a test itself.
//   node open-child.ts <database file>
// It stands in for a night job that macOS has just woken. It prints "ready", reads one line with
// a moment (milliseconds since 1970), waits for exactly that moment, opens the database with the
// real Store, writes one small value the way a check writes its heartbeat, and closes it. Then it
// prints "ok", or "failed: " and why.
import { Store } from "../src/index.ts";

const file = process.argv[2];
if (file === undefined) throw new Error("usage: open-child.ts <database file>");

process.stdout.write("ready\n");
const startAt = await new Promise<number>((resolve) => process.stdin.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
// No timer: one could fire a millisecond or two late, and the point is to open in the same
// instant as the other programs.
while (Date.now() < startAt) {
  // wait
}

try {
  const store = new Store(file);
  store.setValue(`opened.${process.pid}`, "yes", new Date().toISOString());
  store.close();
  process.stdout.write("ok\n");
} catch (error) {
  process.stdout.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
}
process.exit(0);
