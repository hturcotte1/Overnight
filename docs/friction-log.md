# Friction log

Every time a Bee, Kiro or AWS tool surprised us while building Overnight. Newest entries at the bottom.
Each entry: what we tried, the steps, what we expected, what happened, how bad it was, how we got around it, and what we'd suggest.

Severity scale: **low** (cosmetic or a few minutes lost), **medium** (needed a workaround or cost real time), **high** (blocked a feature or forced a design change).

---

## F-001: The Bee CLI is a 478 MB install

- **Tool:** Bee CLI (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Install the Bee CLI on a fresh Apple Silicon Mac.
- **Steps:** Node 24.21.0, npm 11.19.0, then `npm i -g @beeai/cli@0.7.3`.
- **Expected:** A small CLI, or one binary for this machine.
- **Actual:** 478 MB on disk. `dist/platforms/` holds a compiled binary for five platforms (mac-arm64 58 MB, mac-x64 63 MB, linux-arm64 97 MB, linux-x64 112 MB, windows-x64 112 MB). Only one is ever used. A project that depends on the library gets a second 478 MB copy in its own `node_modules`.
- **Severity:** low. It works, but the install is slow and heavy for a project dependency or CI.
- **Workaround:** None needed. It took 42 seconds on a fast connection.
- **Suggestion:** Publish one small package per platform and list them as `optionalDependencies` (the pattern esbuild and Biome use), so npm fetches only the matching binary.

## F-002: npm 11 skips the Bee CLI's install script and prints a warning

- **Tool:** Bee CLI (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Same install as F-001.
- **Steps:** `npm i -g @beeai/cli@0.7.3` with npm 11.19.0.
- **Expected:** A clean install.
- **Actual:** npm prints `1 package has install scripts not yet covered by allowScripts: @beeai/cli@0.7.3 (postinstall: node ./scripts/postinstall.js)` and does not run it. The script only marks the binary as executable, and the package already ships it that way, so `bee` works anyway. A newcomer can't tell that from the warning.
- **Severity:** low.
- **Workaround:** Ignore the warning. `bee version` proves the install is fine.
- **Suggestion:** Drop the `postinstall` step (the executable bit survives packaging), or mention the warning in the README.

## F-003: `bee status` reports success when nobody is logged in

- **Tool:** Bee CLI (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Have a script check whether Bee is logged in before starting the listener.
- **Steps:** On a Mac that has never logged in: `bee status; echo $?`, then `bee status --json`.
- **Expected:** A non-zero exit code when logged out, or machine-readable output.
- **Actual:** Prints `Not logged in.` and exits with code 0. `bee status --json` fails with `status does not accept arguments.`
- **Severity:** low.
- **Workaround:** Call `bee me --json` instead (exit code 1 when logged out), which is what the library's `auth.isAuthenticated()` does.
- **Suggestion:** Exit non-zero when logged out and accept `--json`.

## F-004: The Bee library says "not logged in" when it actually can't find the `bee` program

- **Tool:** Bee library (`@beeai/cli/lib` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Use `createBeeClient()` from a project that has `@beeai/cli` as a normal dependency (no global install).
- **Steps:** `npm install @beeai/cli`, then `createBeeClient().auth.isAuthenticated()` in a process whose `PATH` does not include a global `bee`.
- **Expected:** The library finds the binary that ships inside its own package, or raises a clear "bee not found" error.
- **Actual:** The library always spawns the literal command `bee` from `PATH`. Any direct call fails with `spawn bee ENOENT`, and `isAuthenticated()` swallows that error and returns `false`, so the app reports "not logged in" for what is really a missing program. This bites background jobs hardest, because macOS launchd agents don't read shell profiles and so have a minimal `PATH`.
- **Severity:** medium. It sends you debugging the wrong thing.
- **Workaround:** Pass the path explicitly: `createBeeClient({ command: "<project>/node_modules/.bin/bee" })`.
- **Suggestion:** Default `command` to the package's own `bin/bee.js`, and let `isAuthenticated()` rethrow errors that aren't auth failures.

## F-005: The Bee library covers less than the CLI and returns untyped data

- **Tool:** Bee library (`@beeai/cli/lib` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Call `bee conversations transcript` and `bee facts search` from TypeScript.
- **Steps:** Read `dist/lib/api.d.ts` looking for the matching methods.
- **Expected:** One typed method per CLI command.
- **Actual:** `conversations` only has `list` and `get`, and `facts` has no `search`, although the CLI has both commands. Every method returns `unknown` (`<T = unknown>`), and stream events are `unknown` too, so each app has to discover the JSON shapes by trial.
- **Severity:** low.
- **Workaround:** `client.runJson(["conversations", "transcript", id, "--since", ms])` and `client.runJson(["facts", "search", "--query", q])`, with our own zod schemas for the results.
- **Suggestion:** Add the missing helpers and export response and event types.
