// Test helper, started as its own process by locks.test.ts. Not a test itself.
//   node lock-holder.ts <lock file> [hold for this many ms; 0 or nothing = until killed]
// It takes a lock exactly as `overnight listen`, `build` and `deliver` do (the cli's own
// takeLock), prints "held" (or "refused"), and keeps the lock for as long as it was told to.
import { takeLock } from "@overnight/cli";

const file = process.argv[2];
const holdMs = Number(process.argv[3] ?? 0);
if (file === undefined) throw new Error("usage: lock-holder.ts <lock file> [hold ms]");

const release = takeLock(file);
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
  // The lock lasts only as long as something still holds on to `release`: with nothing pointing
  // at it, the connection behind it is tidied away and the lock is silently given back. This
  // listener is what keeps hold of it.
  process.on("exit", release);
}
