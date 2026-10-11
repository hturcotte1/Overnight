// Serve the built app and run one Playwright config against it. Runs INSIDE the deliver sandbox,
// as one process tree that the verifier can time and kill as a whole.
//
// Usage: node serve-and-test.ts <site folder> <port> <playwright config file>
// Exit code: Playwright's own (0 = every test passed), or one of the codes below.
// Node built-ins only: nothing here may import from the rest of the repo.
import { spawn } from "node:child_process";
import path from "node:path";
import { startStaticServer } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

/** Our own server could not start (for example the port was taken a moment ago). */
const EXIT_SERVER_FAILED = 97;
const EXIT_BAD_USAGE = 98;
const EXIT_TEST_RUNNER_DIED = 96;

const [siteDir, portText, configFile] = process.argv.slice(2);
const port = Number(portText);
if (!siteDir || !configFile || !Number.isInteger(port) || port < 1024 || port > 65535) {
  console.log("HARNESS bad usage");
  process.exit(EXIT_BAD_USAGE);
}

const harnessDir = import.meta.dirname;
const playwrightCli = path.join(harnessDir, "node_modules", "@playwright", "test", "cli.js");

let server: StaticServer;
try {
  server = await startStaticServer(siteDir, port);
} catch {
  console.log("HARNESS server could not start");
  process.exit(EXIT_SERVER_FAILED);
}
console.log(`HARNESS server listening ${server.port}`);

// 127.0.0.1, never the name "localhost": name lookups are blocked inside the sandbox.
const baseUrl = `http://127.0.0.1:${server.port}/`;
const child = spawn(process.execPath, [playwrightCli, "test", "-c", configFile], {
  cwd: harnessDir,
  env: { ...process.env, BASE_URL: baseUrl, SMOKE_BASE_URL: baseUrl },
  stdio: "inherit",
});
const code = await new Promise<number>((resolve) => {
  child.once("error", () => resolve(EXIT_TEST_RUNNER_DIED));
  child.once("exit", (exitCode) => resolve(exitCode ?? EXIT_TEST_RUNNER_DIED));
});
await server.close();
console.log(`HARNESS tests exited ${code}`);
process.exit(code);
