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
- **Actual:** 478 MB on disk. `dist/platforms/` holds a compiled binary for five platforms (mac-arm64 61 MB, mac-x64 65 MB, linux-arm64 97 MB, linux-x64 103 MB, windows-x64 114 MB; 440 MB in all). Only one is ever used. A project that depends on the library gets a second copy of all five in its own `node_modules`.
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
- **Workaround:** Pass the full path to the platform binary: `createBeeClient({ command: "<project>/node_modules/@beeai/cli/dist/platforms/mac-arm64/bee" })`. Not `node_modules/.bin/bee`: that launcher is a Node script, so it needs `node` on `PATH` as well.
- **Suggestion:** Have the library find the platform binary inside its own package by default (the lookup `bin/bee.js` already does), and let `isAuthenticated()` rethrow errors that aren't auth failures.

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

## F-006: The docs say stream events carry no event name. They do

- **Tool:** Bee CLI, library and docs (`@beeai/cli` 0.7.3, docs.bee.computer "Realtime Sync")
- **Date:** 2026-10-09
- **Task:** Tell "to-do ticked" from "to-do deleted", and "conversation updated" from "conversation deleted", on the live stream.
- **Steps:** Read the package README ("Stream Events") and the realtime docs, then ran `bee stream --json` against a real account.
- **Expected:** What the docs describe: each `--json` line is only the payload with no event name, so `todo-created`, `todo-updated` and `todo-deleted` all look like `{"todo": {...}}` and must be told apart some other way.
- **Actual:** Every real payload has a top-level `"type"` field holding the event name (`"new-utterance"`, `"update-conversation"`, `"todo-deleted"`, ...). The README examples don't show it. Real payloads also differ from the README in other ways: utterances have `id`, `sample_id`, `start`, `end`, `spoken_at` and **no** `speaker`; conversations use `conversation_uuid`, not `uuid`; the connect message is `{"timestamp": ...}` and arrives even when `--types` asks for something else. Most important: the final `update-conversation` event (state `COMPLETED`) carries the **entire transcript**, twice, with a first name on some utterances (`person_first_name`). The README shows that event as four small fields. An app that logs stream events "for debugging" would write whole conversations and names to its logs without knowing.
- **Severity:** medium. Following the docs, we built a one-stream-per-event-type workaround (nine processes) that turned out to be unnecessary, and we nearly missed that transcripts and names arrive on the stream.
- **Workaround:** Switch on `data.type` and skip lines that have no `type`. Parse every event through a schema that keeps only the fields we need, and never log a raw event.
- **Suggestion:** Document the real payloads, including `type`, and export them as TypeScript types from the library.

## F-007: When a Bee command fails, its help text is printed to standard output

- **Tool:** Bee CLI (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Read `bee ... --json` output from a program.
- **Steps:** While logged out: `bee todos list --json 2>/dev/null` and `bee stream --json 2>/dev/null`.
- **Expected:** Nothing on standard output when the command fails; the error on standard error.
- **Actual:** The error message goes to standard error, but the command's full usage text is printed to standard output (exit code 1). A program reading the JSON feed receives help text instead. The library hides this for the stream by skipping lines that aren't JSON.
- **Severity:** low.
- **Workaround:** Check the exit code before parsing, and ignore non-JSON lines.
- **Suggestion:** Print usage to standard error on failure.

## F-008: Flags written as `--flag=value` are rejected

- **Tool:** Bee CLI (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Pass options the way most CLIs accept them.
- **Steps:** `bee todos list --limit=1`
- **Expected:** Same as `--limit 1`.
- **Actual:** `Unknown option: --limit=1`.
- **Severity:** low.
- **Workaround:** Always write `--flag value` with a space.
- **Suggestion:** Accept both forms.

## F-009: Ticking a to-do in the Bee app never produced a `todo-updated` event

- **Tool:** Bee live stream (`bee stream`, `@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Use a to-do as a yes/no prompt: created by our code, answered by the wearer in the Bee app.
- **Steps:** Opened streams for `todo-created`, `todo-updated` and `todo-deleted`. Created a to-do with `bee todos create --text ... --alarm-at ...`. Ticked it as done in the Bee iOS app. In a second run, deleted a to-do in the app instead.
- **Expected:** `todo-created` when we create it, `todo-updated` with `completed: true` when it is ticked, `todo-deleted` when it is deleted.
- **Actual:** No `todo-created` event in either run. **No `todo-updated` event** when the to-do was ticked, in the five minutes the streams kept listening, although `bee todos get` (about a minute after the tick) and `bee changed` (about a minute and a half after) both showed `completed: true`. Completing a to-do through the CLI later gave the same result: visible to `todos get` within seconds, no event. `todo-deleted` did arrive, within a few seconds of the delete (we didn't time the tap; two listening processes logged the event 1.2 seconds apart).
- **Severity:** high for an approval flow. The "yes" answer is the one event that never arrives.
- **Workaround:** Poll `bee todos get <id>` every few seconds for each open prompt. `completed: true` means yes; exit code 1 with `Todo not found.` means it was deleted.
- **Suggestion:** Emit `todo-updated` for changes made in the app, and `todo-created` for to-dos made through the API. If that's intended behaviour, say so in the stream docs.

## F-010: Very short recordings are deleted about six minutes after they're made

- **Tool:** Bee (Apple Watch capture, developer API)
- **Date:** 2026-10-09
- **Task:** Capture a one-sentence thought ("someone should build...") and read it back later.
- **Steps:** Recorded a single 7-word sentence as its own conversation and watched the stream.
- **Expected:** The conversation is kept, or the docs state a minimum length.
- **Actual:** `new-conversation` and `new-utterance` arrived 14 seconds after the sentence. Six minutes later came `update-conversation` (state `PROCESSING`) and, within a second, `delete-conversation`. After that `bee conversations get <id>` and `transcript <id>` return `Conversation not found`. Nothing in the README, docs or CLI source mentions this; we only knew to look because of a hackathon forum post.
- **Severity:** medium. One-sentence thoughts are a core use for a wearable, and an app that re-fetches transcripts would silently lose them.
- **Workaround:** Save every utterance the moment it arrives on the stream and never rely on re-fetching.
- **Suggestion:** Document the rule and the threshold, and consider a setting to keep short recordings (or at least their text).

## F-011: A conversation stays "capturing" for 6.5 minutes after the last word

- **Tool:** Bee (Apple Watch capture, live stream)
- **Date:** 2026-10-09
- **Task:** React when a conversation ends.
- **Steps:** Talked for about 80 seconds, stopped, and watched `update-conversation` events. About two minutes after stopping, made a second short recording.
- **Expected:** The conversation ends soon after the recording stops, and a new recording is a new conversation.
- **Actual:** The state stayed `CAPTURING` until 6 minutes 31 seconds after the last words, then `PROCESSING`, then `COMPLETED` 12 seconds later. The second recording was appended to the same conversation. In the Bee app this looked like the recording was "taking forever". (An open issue on the CLI repo reports the same state lasting 20 hours.)
- **Severity:** medium. "Wait for the conversation to finish" is too slow and too unpredictable to trigger anything on.
- **Workaround:** Run our own timer: two minutes with no new utterance counts as a pause, whatever Bee's state says.
- **Suggestion:** Document the idle timeout, or add an event when capture stops on the device.

## F-012: Live utterances have no speaker label

- **Tool:** Bee live stream
- **Date:** 2026-10-09
- **Task:** Guess whether the wearer or someone else said a sentence.
- **Steps:** Looked at 33 real `new-utterance` payloads.
- **Expected:** `utterance.speaker`, as in the README example (`"speaker": "speaker_1"`).
- **Actual:** No `speaker` field in any `new-utterance`. A first name does arrive later for kept conversations: as `person_first_name` inside the `COMPLETED` `update-conversation` event, and as `speaker` (a first name or `Unknown`) in the stored transcript. Neither exists for short recordings, which get deleted.
- **Severity:** low for us (the wrist approval is the real gate), higher for anything that needs to know who spoke in real time.
- **Workaround:** Don't depend on speaker identity.
- **Suggestion:** Include the best-guess speaker in `new-utterance`, or remove it from the README example.

## F-013: Nothing documents what a to-do alarm does on the phone and watch

- **Tool:** Bee to-dos (`bee todos create --alarm-at`) and the Bee iOS app
- **Date:** 2026-10-09
- **Task:** Buzz the wearer's wrist with a to-do alarm.
- **Steps:** Created a to-do with an alarm two minutes out, twice.
- **Expected:** Documentation saying what an alarm does on the phone and watch.
- **Actual:** Neither the README nor the docs say that an alarm produces a notification. The first time, with Bee notifications not fully enabled on the iPhone, the phone showed a notification but no wrist buzz was noticed. The second time the iPhone and the Apple Watch both buzzed on time. We didn't record which setting changed in between.
- **Severity:** low once you know.
- **Workaround:** Tell users to allow notifications for Bee on the iPhone, and test with a throwaway to-do.
- **Suggestion:** Document "alarm = notification on phone and watch", and let the API report whether notifications are enabled.

## F-014: `bee changed` with no cursor returns a whole day, transcripts included

- **Tool:** Bee CLI (`bee changed`)
- **Date:** 2026-10-09
- **Task:** Get a starting cursor for backfill.
- **Steps:** `bee changed --json` on a fresh login.
- **Expected:** A cursor for "now", or a small page.
- **Actual:** About 24 hours of changes: 60 to-dos and every conversation with its full transcript. According to the CLI source, it fetches each item with its own request.
- **Severity:** low.
- **Workaround:** On first start, call it once, keep only `meta.next_cursor`, and ignore the items.
- **Suggestion:** Add a way to ask for just the current cursor.

## F-015: The Kiro "CLI" for Mac is a desktop app (364 MB download, about 650 MB installed) that adds a login item

- **Tool:** Kiro CLI 2.29.0
- **Date:** 2026-10-09
- **Task:** Install a command-line tool for headless use on a Mac, without admin rights.
- **Steps:** Ran the official installer script from `cli.kiro.dev/install`.
- **Expected:** A binary in the home folder, like the Linux "headless" download.
- **Actual:** A 364 MB disk image (about 650 MB once installed). The script copies `Kiro CLI.app` into `/Applications`, launches it in the background, and leaves a login item (`~/Library/LaunchAgents/com.amazon.codewhisperer.launcher.plist`) plus helper files with names like `zsh (kiro-cli-term)` in `~/.local/bin`. It worked without a password only because this account is an administrator. `~/.local/bin` isn't on `PATH` by default, so `kiro-cli` is "not found" until you add it.
- **Severity:** low. It works, but it's a lot of footprint for a headless tool, and the background app and login item are a surprise.
- **Workaround:** Call `~/.local/bin/kiro-cli` by full path.
- **Suggestion:** Offer a standalone macOS binary (zip) with no app, no login item and a home-folder install.

## F-016: Kiro sign-in: the no-browser login only offers AWS Builder ID, and it's easy to end up with two accounts

- **Tool:** Kiro CLI 2.29.0 and app.kiro.dev
- **Date:** 2026-10-09
- **Task:** Sign in with GitHub from a script, then upgrade that account to Pro.
- **Steps:** `kiro-cli login --license free --use-device-flow`; then plain `kiro-cli login --license free`; then the upgrade page.
- **Expected:** A way to choose the sign-in provider from the command line (the CLI reference lists a `--social google|github` option).
- **Actual:** `kiro-cli login --help` on 2.29.0 has no such option. The device flow went straight to an AWS Builder ID page with no GitHub or Google choice. The regular login opens the browser, where one stray click on "Google" instead of "GitHub" silently creates a second, separate free Kiro account. The upgrade page then uses whichever account the browser session holds, so it's possible to pay for Pro on the wrong one. Clicking Upgrade also failed at first with "Popup blocked. Please allow popups and try again."
- **Severity:** medium for onboarding. It cost us a logout, a second login and a detour through browser pop-up settings.
- **Workaround:** `kiro-cli logout`, log in again choosing GitHub, check the account shown on the upgrade page before paying, and allow pop-ups for app.kiro.dev. Confirm the plan afterwards with `kiro-cli chat --no-interactive "/usage"`.
- **Suggestion:** Add the provider option to `login`, show the signed-in account prominently on the upgrade page, and open checkout in the same tab.

## F-017: Kiro CLI docs describe options the latest release doesn't have

- **Tool:** Kiro CLI 2.29.0 and kiro.dev docs
- **Date:** 2026-10-09
- **Task:** Get machine-readable health output.
- **Steps:** `kiro-cli doctor --all --format json` (as documented), on the latest stable version.
- **Expected:** JSON.
- **Actual:** `error: unexpected argument '--format' found ... This command may be valid in newer versions of the Kiro CLI. Try running kiro-cli update.` 2.29.0 is the newest stable release.
- **Severity:** low.
- **Workaround:** Use `kiro-cli whoami --format json` and `/usage` for the checks we need.
- **Suggestion:** Tag documented options with the version that introduced them.

## F-018: "No tools" needs a custom agent, and a no-tools agent still says it has tools

- **Tool:** Kiro CLI 2.29.0 (`kiro-cli chat --no-interactive`)
- **Date:** 2026-10-09
- **Task:** Use Kiro as a plain text-in, JSON-out classifier with no access to files.
- **Steps:** Put a file in the working folder. Asked the default agent, with no `--trust-tools`, to read it. Then asked a custom agent with `"tools": []`.
- **Expected:** With no trust flags, no tools.
- **Actual:** The default agent read the file: reading inside the current folder is pre-approved. The custom agent could not read it and no tool ran, but its reply began "I have file-reading tools available" and then claimed the file didn't exist.
- **Severity:** medium. A classifier fed sensitive text must not be able to read project files, and the default makes that easy to get wrong.
- **Workaround:** Custom agent with an empty `tools` list, run from an empty folder with its own `KIRO_HOME`; validate the JSON and ignore what the model says about its own actions.
- **Suggestion:** A `--no-tools` flag, and tell the model plainly when it has none.

## F-019: `kirocrew doctor` fails a healthy install over an optional voice feature

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-09
- **Task:** Get a clean health check after a fresh install.
- **Steps:** Official installer, `kirocrew setup --agent-only`, `kirocrew doctor`.
- **Expected:** "Ready", since Kiro CLI, sign-in, sandbox and runtime all passed.
- **Actual:** Exit code 1 and `❌ Fix these issues: speech recogniser (stt_extra_missing), ffmpeg`, with the advice `brew install ffmpeg`. Speech-to-text is on by default but its dependencies aren't installed by the installer. The doctor output is also about 200 lines, most of it about agent backends we don't have.
- **Severity:** low to medium. A first-time user is told their install is broken when it isn't, and is pointed at Homebrew.
- **Workaround:** `kirocrew config set stt.enabled false`. Doctor then exits 0 with `✅ Kiro Crew is ready!`.
- **Suggestion:** Treat missing optional features as warnings, or ship speech-to-text off by default.

## F-020: Daily Kiro Crew jobs start at a random time, and the CLI can't turn that off

- **Tool:** Kiro Crew 0.8.0 (`kirocrew cron`)
- **Date:** 2026-10-09
- **Task:** Run a job every day at an exact time.
- **Steps:** `kirocrew cron add ... --cron "16 18 * * *" --timezone America/Boise --command "..."` three minutes ahead, then waited. Also tried `kirocrew cron trigger <id>` on it.
- **Expected:** The job runs at 6:16 pm, as the one-shot `--at` job did (on time, to the second).
- **Actual:** Twelve minutes later the command still hadn't run. The installed code delays daily jobs by a random 0 to 59 minutes (`_JITTER_DAILY_MAX`) unless the job's `strict_schedule` is true. `kirocrew cron add --help` and `cron update --help` on 0.8.0 have no strict option, although the docs site lists `--strict-schedule`. `cron trigger` on the waiting job printed `Error: HTTP 409` and still exited 0. `cron list` shows "At 6:16 PM" with no hint of the delay.
- **Severity:** medium. "1:00 a.m." can silently mean "some time before 2:00".
- **Workaround:** Keep the Crew job for the work, and start it from our own timer with `kirocrew cron trigger <id>`, which runs within a second.
- **Suggestion:** Add `--strict-schedule` to the CLI as documented, show the planned start time in `cron list`, and make failed CLI commands exit non-zero.

## F-021: Under default approvals an unattended Kiro Crew agent job does nothing and reports success

- **Tool:** Kiro Crew 0.8.0 (scheduled agent jobs)
- **Date:** 2026-10-09
- **Task:** Have a scheduled agent job create a file and run one harmless command with nobody at the keyboard.
- **Steps:** `kirocrew cron add "<name>" "<create hello.txt, then run node --version>" --at "in 1 minute" --no-persistent-session`, default settings, then waited.
- **Expected:** Either it works, or the job fails quickly with a clear "needs approval" error. `kirocrew doctor` reports `approval: auto`, which reads as if tools just run.
- **Actual:** Six minutes later (two approval waits of three minutes each) no file existed. The agent's summary was "Both steps were denied by policy". Crew recorded the run with status `success`.
- **Severity:** high for unattended use. A nightly build would quietly produce nothing every night, and the history would look green.
- **Workaround:** The documented per-job flag `--approval-mode auto`. We have not used it yet, because it loosens an approval setting; that's a decision for the project owner.
- **Suggestion:** Mark runs whose tool calls were all denied as failed, deny at once for unattended jobs instead of waiting, and explain on the Security page that scheduled jobs need the per-job flag.

## F-022: Kiro Crew's sandbox doesn't keep the user's logins away from a job

- **Tool:** Kiro Crew 0.8.0 (default sandbox on macOS)
- **Date:** 2026-10-09
- **Task:** Check that a sandboxed job can't reach credentials the build doesn't need.
- **Steps:** Zero-credit command jobs that print only counts: `gh auth token | wc -c`, `bee me --json | wc -c`, a `curl` to the npm registry, and `ls ~/.ssh | wc -l`.
- **Expected:** "Sandbox" to mean the job can't read the user's tokens.
- **Actual:** The GitHub token was readable (41 bytes), the Bee CLI answered as the logged-in user (101 bytes), and the network was open. Only the `~/.ssh` command was refused, by a name check when the job was added, not by the sandbox. On macOS the sandbox is `sandbox-exec` with an allow-by-default profile.
- **Severity:** high as an expectation gap. Anything a build agent is tricked into running has the user's GitHub and Bee access.
- **Workaround:** None yet. We will test the `strict` sandbox level and Kiro permission rules in Milestone 2, keep briefs free of untrusted instructions, and keep publishing in a separate step.
- **Suggestion:** Document exactly what the default sandbox hides, block Keychain-backed credential helpers (`gh auth token`, `security find-generic-password`) by default, and offer a deny-by-default mode for unattended jobs.

## F-023: `bee todos update --clear-alarm` does not clear the alarm

- **Tool:** Bee CLI (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Remove the alarm from a test to-do so it can never buzz.
- **Steps:** `bee todos update <id> --completed true --clear-alarm --json`, then `bee todos update <id> --clear-alarm --json` by itself, then `bee todos get <id> --json`.
- **Expected:** `alarm_at` becomes `null`. The option is in `bee todos --help`.
- **Actual:** Both calls exit 0 and return the to-do with `alarm_at` unchanged. `completed` did change in the first call, so the request reached the server.
- **Severity:** low for us, since we never need to clear an alarm in normal use. It did leave one completed test to-do with an alarm date two months away.
- **Workaround:** None found. Delete the to-do in the Bee app.
- **Suggestion:** Make `--clear-alarm` work, or fail loudly when the server ignores it.
