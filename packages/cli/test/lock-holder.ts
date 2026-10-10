// Test helper, started as its own process by single-instance.test.ts. Not a test itself.
//   node lock-holder.ts <lock file> [hold for this many ms; 0 or nothing = until killed]
// It takes the listen lock the way `overnight listen` does, prints "held" (or "refused"), and
// keeps the lock for as long as it was told to.
import { takeListenLock } from "../src/single-instance.ts";

const file = process.argv[2];
const holdMs = Number(process.argv[3] ?? 0);
if (file === undefined) throw new Error("usage: lock-holder.ts <lock file> [hold ms]");

const release = takeListenLock(file, 0);
if (release === null) {
  process.stdout.write("refused\n");
  process.exit(1);
}
process.stdout.write("held\n");
if (holdMs > 0) {
  setTimeout(release, holdMs);
} else {
  // Stay alive, holding the lock, until the test kills this process.
  setInterval(() => {}, 60_000);
  process.on("exit", release);
}
