// Opt-in check against the real Bee account. Run it by hand:
//
//   node packages/bee/src/smoke.ts
//
// It only reads. It prints the login state, whether Bee handed back a cursor, and how many
// conversations changed. Nothing else: no names, no speech, no ids, no cursor value.
import { BeeError } from "@overnight/core";
import { createBeeGateway } from "./gateway.ts";

const bee = createBeeGateway();

const login = await bee.loginState();
console.log(`loginState: ${login}`);

if (login !== "logged-in") {
  console.log("changedSince(null): skipped, Bee is not logged in");
  process.exitCode = 1;
} else {
  try {
    const changed = await bee.changedSince(null);
    console.log(`changedSince(null): cursor=${changed.nextCursor !== null} conversations=${changed.conversationIds.length}`);
  } catch (error) {
    // The kind only. A message could, in principle, quote something Bee printed.
    console.log(`changedSince(null): failed (${error instanceof BeeError ? error.kind : "unexpected error"})`);
    process.exitCode = 1;
  }
}
