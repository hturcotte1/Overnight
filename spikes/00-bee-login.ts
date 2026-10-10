// Log this Mac in to Bee without leaking anything private.
//
// Usage: node spikes/00-bee-login.ts
// `bee login` prints a pairing link, waits (about 5 minutes) for the phone owner to approve it in
// the Bee app, then prints the account holder's real name. This wrapper shows ONLY the link and a
// yes/no result, so the name and the token never reach a log, a transcript or the repo.
import { createBeeCliRunner } from "@beeai/cli/lib";
import { bee, beeBinary, beeJson, stamp } from "./lib/util.ts";

const client = bee();
// `bee me` succeeds only when logged in. Its output holds the real name, so it is never printed.
const loggedIn = () => beeJson(client, ["me"]).then(() => true, () => false);
if (await loggedIn()) {
  console.log(`${stamp()} already logged in to Bee. Nothing to do.`);
  process.exit(0);
}

const runner = createBeeCliRunner({ command: beeBinary() });
const child = runner.spawn(["login"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

let shown = false;
let buffer = "";
const onChunk = (chunk: unknown) => {
  buffer += String(chunk);
  const link = buffer.match(/https:\/\/bee\.computer\/connect#[^\s]+/);
  const minutes = buffer.match(/expire in approximately (\d+) minute/);
  if (link && !shown) {
    shown = true;
    console.log(`${stamp()} LINK ${link[0]}`);
    console.log(`${stamp()} Open the link on the phone that has the Bee app (or scan the QR code the page shows) and approve.`);
  }
  if (minutes && shown) {
    console.log(`${stamp()} The link is valid for about ${minutes[1]} more minute(s).`);
    buffer = "";
  }
};
child.stdout?.setEncoding?.("utf8");
child.stdout?.on("data", onChunk);
// Read and discard stderr so the child never blocks on a full pipe.
child.stderr?.on("data", () => {});

// The pairing link lasts about 5 minutes. Stop waiting a little after that.
const cap = setTimeout(() => child.kill(), 7 * 60_000);
const exitCode = await child.exited;
clearTimeout(cap);
const ok = await loggedIn();
console.log(`${stamp()} bee login exited with code ${exitCode}. Logged in: ${ok ? "yes" : "no"}.`);
process.exit(ok ? 0 : 1);
