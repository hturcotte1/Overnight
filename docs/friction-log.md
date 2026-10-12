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

## F-024: Stream ids and stored-transcript ids are different, so missed lines can't be matched by id

- **Tool:** Bee live stream and `bee conversations transcript` (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** After a dropped connection, fetch the stored transcript and add only the lines the stream missed.
- **Steps:** Compared the `utterance.id` values received on the stream with the ids in the stored transcript of the same conversation, and with the two transcriptions inside the `COMPLETED` stream event.
- **Expected:** One id per spoken line, the same everywhere.
- **Actual:** Stream ids match the *realtime* transcription (32 of 32). `bee conversations transcript` returns only the *final* transcription, whose ids are all different (0 of 32 in common). `bee conversations get` also has no `conversation_uuid`, while stream utterances carry only the uuid, so even "which conversation is this?" can't be answered from one side alone.
- **Severity:** medium. Catch-up after a disconnect, which the docs recommend because the stream is at-most-once, has to guess at duplicates.
- **Workaround:** Match by time and text: a stored line within a few seconds of a saved line with nearly the same words is treated as the same line. Keep a table that links uuid and numeric id whenever a stream event shows both.
- **Suggestion:** Give each utterance one stable id across realtime and final transcriptions (or include the realtime id on the final line), and return `conversation_uuid` from the conversation commands.

## F-025: The Bee library can crash the host program when the `bee` binary can't start

- **Tool:** Bee library (`@beeai/cli/lib` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Open the stream from a long-running program that must never crash.
- **Steps:** Called `sse.streamJson()` with a `command` path that doesn't exist. Reproduced by a test in `packages/bee/test/real-library.test.ts`.
- **Expected:** The error comes out of the event iterator, where the caller is already handling errors.
- **Actual:** The library also creates a promise (`process.exited`) that rejects with nothing attached to it. Node reports an unhandled rejection, which by default ends the whole process.
- **Severity:** medium for an always-on listener.
- **Workaround:** Attach a `.catch()` to `stream.process.exited` straight after opening the stream.
- **Suggestion:** Handle that rejection inside the library and surface the failure only through the iterator.

## F-026: Text on the stream can be corrupted, and one error message quotes the output

- **Tool:** Bee library (`@beeai/cli/lib` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Read utterances from `sse.streamJson()` and log errors safely.
- **Steps:** Read `dist/lib/index.js`, then reproduced both with a stand-in program in `packages/bee/test/real-library.test.ts`.
- **Expected:** Text arrives intact, and error messages don't repeat what the program printed.
- **Actual:** (1) The stream path decodes each chunk of output separately, so a character that spans two chunks (an accented letter, an emoji) turns into replacement characters. `runJson` doesn't have this problem because it sets the encoding. (2) When a command prints something that isn't JSON, the error message `Failed to parse Bee CLI JSON output: ...` includes a piece of that output. If that reaches a log, a name or a sentence someone said can end up there.
- **Severity:** low each, but (2) matters for any app that promises not to log speech.
- **Workaround:** Call `setEncoding("utf8")` on the stream's stdout ourselves, and replace that error with our own message before it can be logged.
- **Suggestion:** Set the encoding in the stream path, and keep program output out of error messages.

## F-027: `kiro-cli settings <key>` fails for a setting that was never changed

- **Tool:** Kiro CLI 2.29.0
- **Date:** 2026-10-09
- **Task:** Check from a script that content sharing and telemetry are off.
- **Steps:** `kiro-cli settings telemetry.enabled` on a fresh install, and in a fresh `KIRO_HOME`.
- **Expected:** The current effective value (the default), with exit code 0.
- **Actual:** `error: No value associated with telemetry.enabled`, exit code 1. Once set it prints `false (global)`. So a script can't tell "on by default" from "off" without knowing the defaults by heart, and the two privacy settings that matter most are the ones in this state on every new install.
- **Severity:** low to medium. It makes "is this machine sharing content?" harder to answer than it should be.
- **Workaround:** Treat the error as "not off", set the value to `false`, and read it back.
- **Suggestion:** Print the effective value and say that it is the default.

## F-028: Every headless Kiro chat is saved to disk, prompt included

- **Tool:** Kiro CLI 2.29.0 (`kiro-cli chat --no-interactive`)
- **Date:** 2026-10-09
- **Task:** Use Kiro as a classifier for private text without leaving copies of that text around.
- **Steps:** Ran the detector evaluation three times (about 230 chats), then looked in the detector's `KIRO_HOME`.
- **Expected:** One-shot headless calls leave nothing behind, or there is a documented switch for it.
- **Actual:** 454 files (2.7 MB) under `sessions/cli/`, two per chat, holding the whole prompt and the reply. Nothing removes them. In production that would be a second, growing copy of every transcript we classify.
- **Severity:** medium for privacy-sensitive use.
- **Workaround:** Give the detector its own `KIRO_HOME` inside our private data folder, and delete session files older than a day ourselves.
- **Suggestion:** A `--no-save` flag (or setting) for headless runs.

## F-029: No structured-output mode, so every reply needs parsing, checking and sometimes a retry

- **Tool:** Kiro CLI 2.29.0 (`kiro-cli chat --no-interactive`, model `claude-haiku-4.5`)
- **Date:** 2026-10-09
- **Task:** Get one JSON object with fixed fields and length limits from each call.
- **Steps:** Ran 64 synthetic transcripts through the detector, three times, checking each reply against a schema.
- **Expected:** A way to hand Kiro a JSON schema, as model APIs offer, so the reply always fits.
- **Actual:** The reply is free text. It was valid JSON nearly every time, but in one run 11 of 64 first replies broke a rule we had stated (a word-for-word quote of at most 25 words), and asking again fixed only 2 of those. Without our own checks, 8 real ideas would have been thrown away.
- **Severity:** low to medium. It works, but each app has to build its own validation and repair.
- **Workaround:** Validate with zod, cut an over-long quote ourselves when it is otherwise word for word, retry once for anything else, then skip.
- **Suggestion:** A `--response-schema <file>` option for headless mode.

## F-030: A dead stream looks exactly like a quiet room

- **Tool:** Bee CLI (`bee stream`, `@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Know whether an always-on stream is still connected.
- **Steps:** Read the stream command's source for how it treats the server's keep-alive lines, then watched a real stream sit idle.
- **Expected:** Some sign of life when nothing is being said: a heartbeat line in `--json` mode, or the process ending when the connection is lost.
- **Actual:** Keep-alive lines from the server are swallowed by the CLI and never printed, and the CLI has no idle timeout of its own. A stream that has silently died and a stream in a silent house produce the same output: nothing.
- **Severity:** medium for an always-on listener.
- **Workaround:** Close and reopen the stream after 15 minutes without any event, and after the Mac wakes from sleep, then fetch what was missed.
- **Suggestion:** Print keep-alives in `--json` mode (for example `{"type":"ping"}`), or add an `--idle-timeout` option.

## F-031: When `bee todos create` times out, there is no way to know whether the to-do exists

- **Tool:** Bee CLI and API (`@beeai/cli` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Create exactly one to-do per prompt, even on a bad connection.
- **Steps:** Worked through what happens when the create call is cut off by a time limit or its reply can't be read, and reproduced it with a stand-in program.
- **Expected:** A way to make the call safe to repeat: a client-supplied key, or a create that returns the existing to-do when the same one was just made.
- **Actual:** Neither exists. The request may have reached Bee before the reply was lost, so retrying can create a second to-do and a second wrist alarm, while not retrying can lose the prompt.
- **Severity:** medium. For a product whose prompts buzz someone's wrist, duplicates are a real cost.
- **Workaround:** After an unclear failure, look for a to-do with the same text made in the last two minutes (`bee todos list`). If that can't settle it either, record the prompt as sent, never send another, and let it expire.
- **Suggestion:** Accept an idempotency key on `todos create`.

## F-032: The Bee library sometimes reports a command's normal output as its error message

- **Tool:** Bee library (`@beeai/cli/lib` 0.7.3)
- **Date:** 2026-10-09
- **Task:** Turn failures into safe, classifiable errors.
- **Steps:** Read `runJson` in `dist/lib/index.js` and exercised it with a stand-in program.
- **Expected:** An error with a stable code or type, and a message that comes from the error stream only.
- **Actual:** When a command exits non-zero with nothing on standard error, the library uses standard output as the error message. There are no error codes, so callers must match on English sentences, and a server's JSON error text replaces the HTTP status, so a 4xx and a 5xx can't always be told apart.
- **Severity:** low to medium. Matching on sentences is brittle, and output can contain private text.
- **Workaround:** Pass through only the handful of sentences we recognise; replace everything else with our own fixed message.
- **Suggestion:** Throw errors with a `code` (for example `NOT_LOGGED_IN`, `NOT_FOUND`, `NETWORK`, `HTTP_503`) and never copy standard output into a message.

## F-033: Kiro Crew's `strict` sandbox leaves the Keychain, other apps' logins and the user's files reachable

- **Tool:** Kiro Crew 0.8.0 on macOS 26
- **Date:** 2026-10-10
- **Task:** Keep an unattended build agent away from the owner's GitHub login, another app's login (Bee) and a private database.
- **Steps:** `kirocrew config set agent.sandbox strict`, restart the gateway, run an agent job (`--approval-mode auto`) that prints only byte counts: `security find-generic-password -s gh:github.com -w | wc -c`; the Bee CLI's `me --json | wc -c`; `wc -c` of a private SQLite file in the home folder; `touch` in the home folder and in `/tmp`; a `curl` to the npm registry.
- **Expected:** `strict` is described as the level for hosts holding credentials the agent must never read, so we expected the Keychain and ordinary home-folder files to be out of reach, or at least a way to add our own paths.
- **Actual:** Keychain entry readable (75 bytes), Bee login usable (101 bytes), database readable (86,016 bytes), both writes allowed, network open. The only change from the default level was that `~/.config/gh` became unreadable, which breaks the `gh` program but not the token behind it. On macOS the sandbox is "allow everything, except reading a fixed list of folders", and the list can't be extended from config. All four probes were logged as `auto_approved` by Crew's command rules.
- **Severity:** high for unattended use on a personal machine.
- **Workaround:** Run the whole Crew gateway inside our own `sandbox-exec` profile (F-034) and feed the agent nothing but our own short brief.
- **Suggestion:** A setting for extra hidden paths, a rule that cuts Keychain access, and a write boundary for agent jobs. Say plainly in the docs what each level does and does not hide on macOS.

## F-034: Kiro Crew can't run inside another sandbox without switching its own off entirely

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-10
- **Task:** Wrap the Crew gateway in our own, tighter macOS sandbox so everything it starts inherits our rules.
- **Steps:** `sandbox-exec -f <our profile> kirocrew gateway`, then add and trigger a job.
- **Expected:** A way to say "an outer sandbox is in charge" while keeping Crew's own file protections, since macOS can't stack sandboxes.
- **Actual:** Every job fails at once: "already inside a macOS Seatbelt sandbox that KiroCrew did not create, and Seatbelt cannot nest". The only way through is `agent.sandbox_allow_unsandboxed_exec = true`, which turns all of Crew's own sandboxing off, takes effect only after a gateway restart (nothing says so), and makes Crew warn at every start that no sandbox is available, which isn't true. The error for command jobs talks about a missing POSIX shell instead of the sandbox. With Crew's sandbox off, jobs can read Crew's own private files. `kirocrew doctor` reports the sandbox as fine throughout.
- **Severity:** high as a design limit; medium for the misleading messages.
- **Workaround:** Accept the trade: our profile hides more of what matters to us, and a probe job before each night's builds proves it.
- **Suggestion:** An "outer sandbox" mode that trusts the surrounding sandbox for process confinement but keeps Crew's own file-level protections, plus accurate messages and a doctor row that says what running jobs are really confined by.

## F-035: `agent.sandbox` doesn't apply to command jobs, and `doctor` doesn't show the level

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-10
- **Task:** Check from a zero-credit command job that the `strict` level is in force.
- **Steps:** With `agent.sandbox strict`, a `--command` job that prints Crew's own `KIROCREW_SANDBOX_LEVEL` variable and `gh auth token | wc -c`. Then `kirocrew doctor`.
- **Expected:** Level `strict`, token unreachable, and a doctor row naming the level.
- **Actual:** `KIROCREW_SANDBOX_LEVEL=cc` and a readable token (41 bytes): command jobs always run at a fixed level whatever the setting says. Doctor shows only `backend: sandbox-exec`. It also shows `approval: auto`, although a job without the per-job flag is denied everything, which reads as the opposite of what happens.
- **Severity:** medium. It is easy to believe a setting is protecting jobs it never touches.
- **Workaround:** Test a sandbox level only from agent jobs; read the level with `kirocrew config get agent.sandbox`.
- **Suggestion:** Apply the setting to command and script jobs, or document that they are exempt, and show the active level in doctor.

## F-036: A Kiro Crew agent build costs about nine times the same build through Kiro CLI

- **Tool:** Kiro Crew 0.8.0 with Kiro CLI 2.29.0
- **Date:** 2026-10-10
- **Task:** Build one small static web app from a one-page brief.
- **Steps:** Once with `kiro-cli chat --no-interactive` (spike 6), twice as a Crew agent job with `--model auto`.
- **Expected:** Similar cost for similar work.
- **Actual:** 0.4 credits through Kiro CLI; 3.6 and 4.15 credits through Crew, with about 94,500 tokens of context in use at the end of a job. `--minimal-context` saved little and hid the skill list from the agent. The usage record has a blank model name, so we can't tell which model `auto` picked. Crew's own usage log and `kiro-cli /usage` disagreed by about half a credit.
- **Severity:** medium for budgeting; fine at two builds a night on a Pro plan.
- **Workaround:** Budget 4 credits a build; keep the Kiro CLI builder as the cheap fallback.
- **Suggestion:** Record the model on every usage row, and offer a lean job mode that still loads named skills.

## F-037: Kiro Crew jobs have no working-folder option and no reliable result

- **Tool:** Kiro Crew 0.8.0 (`kirocrew cron`)
- **Date:** 2026-10-10
- **Task:** Run an agent job in a folder we choose and learn from Crew whether it worked.
- **Steps:** `kirocrew cron add` an agent job, trigger it, then read `pwd` from inside it and Crew's history afterwards.
- **Expected:** A `--cwd` style flag, and a status that reflects the outcome.
- **Actual:** The job runs in a new folder Crew invents under `~/workplace/kirocrew-workspace/` (a top-level folder it adds to the home folder and never cleans up). History status is `success` whenever the session ends, whatever happened; the summary is cut to 200 characters; a command job's output isn't recorded at all. The agent also wrote a "finished at" time into its own status file that was 14 seconds after the file was saved.
- **Severity:** medium for automation.
- **Workaround:** Name the real folder by full path in the job message and make the skill start every command with `cd "<workspace>" &&`. Have the skill write a marker file, trust only its modification time, and rebuild the result ourselves.
- **Suggestion:** A working-folder flag, a way for a job to report a structured result, and cleanup of per-run folders.

## F-038: Playwright turns Chromium's own sandbox off by default, and full Chromium misbehaves inside a macOS sandbox

- **Tool:** Playwright 1.64.0 (Chromium 156) with macOS `sandbox-exec`
- **Date:** 2026-10-10
- **Task:** Run a smoke test of AI-written web app code as safely as possible.
- **Steps:** Launch Chromium through Playwright with no options and look at the launch line; then run the test inside our own `sandbox-exec` profile with `chromiumSandbox: true`, with the default, and with the full Chromium channel.
- **Expected:** Chromium's sandbox on by default, and a clean failure when something can't start.
- **Actual:** Playwright adds `--no-sandbox` unless told otherwise, so a test run outside any sandbox executes page JavaScript in an unsandboxed browser. Inside `sandbox-exec`, Chromium's own sandbox can't start ("sandbox initialization failed: Operation not permitted"). The headless shell with the default launch works. The full Chromium channel aborted under the tight profile, and seconds later macOS reopened it as a visible "Google Chrome for Testing" window on the desktop that ran for 90 seconds.
- **Severity:** medium; high for an unattended early-morning job if the full browser is used.
- **Workaround:** Always run the browser inside our own profile, use only the headless shell, never set a channel.
- **Suggestion (Playwright):** Say prominently in the docs that the default launch is unsandboxed.


## F-039: `kirocrew cron remove` does not end a job that is running, and there is no command that does

- **Tool:** Kiro Crew 0.8.0 (`kirocrew cron`)
- **Date:** 2026-10-10
- **Task:** Stop a build job that is in progress (its time limit passed, or Overnight itself was told to stop).
- **Steps:** Added a command job that only sleeps, started it with `kirocrew cron trigger <id>`, then ran `kirocrew cron remove <id>` while it was running. Then looked for a command that ends a run.
- **Expected:** Removing a job ends its run, or `remove` refuses while the job runs, or there is a `cron cancel`.
- **Actual:** `Removed job: <id>`, and the job slept on. Its running marker stayed in Crew's folder. We found no `kirocrew` command that ends a run. The gateway does have a local web address for it (`POST /api/crons/<id>/cancel`, with the gateway's own local secret in a header): asked that way, the run's processes were gone in under a second and its history row says `cancelled`. It only works while the job is still on the list, so the order matters.
- **Severity:** medium to high for unattended use. Without the web call, an agent keeps working, and spending credits, with nobody watching and nothing left on the list to show it.
- **Workaround:** Cancel through the gateway's local address first, then `cron remove`. Never the other way round.
- **Suggestion:** Add `kirocrew cron cancel <id>`, and make `cron remove` either end the run or refuse while one is in progress.

## F-040: `kirocrew status` exits 0 whether the gateway is running or not

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-10
- **Task:** Have an install script wait until the gateway answers, and have a health check tell "running" from "not running".
- **Steps:** `kirocrew status; echo $?` with no gateway, then with one running. Also `kirocrew cron trigger <id>` with no gateway.
- **Expected:** A non-zero exit code when nothing is running, or a `--json` form.
- **Actual:** Exit code 0 both times. Only the words differ: `Kiro Crew gateway is not running.` against a line with "gateway is running" or its figures. `cron trigger` with no gateway also printed `Error: cannot reach gateway…` and exited 0 (the same habit as the HTTP 409 in F-020).
- **Severity:** low to medium. Every script has to match English sentences that may change in the next release.
- **Workaround:** Match the words, or skip the CLI and ask the gateway directly: `GET http://127.0.0.1:5476/api/health` answers 200 in a few milliseconds.
- **Suggestion:** Exit non-zero when the gateway is not running or a command failed, and offer `--json`.

## F-041: `kirocrew config get` is a read that writes, and prints values a script has to clean up

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-10
- **Task:** Read one setting from a script that promises to change nothing.
- **Steps:** `kirocrew config get agent.sandbox_allow_unsandboxed_exec` and `kirocrew config get agent.sandbox`, then looked at what had changed under Crew's own folder.
- **Expected:** A plain value on standard output and no side effects.
- **Actual:** The value is printed the way Python writes it (`True`, `False`), with a deprecation warning on standard error. Each call also adds lines to Crew's own security log (`security_events.jsonl`), so a "read-only" check is not quite read-only.
- **Severity:** low.
- **Workaround:** Lower-case the output and strip spaces and quotes; throw away standard error. Where it matters, read `config.json` directly (carefully: a job inside the gateway can write that file).
- **Suggestion:** A `--json` form, lower-case booleans, and no log entry for a read.

## F-042: Kiro Crew will not start an agent unless it can open every folder above its own, and it quietly drops `PATH` folders it cannot open

- **Tool:** Kiro Crew 0.8.0, run inside our own macOS sandbox (see F-034)
- **Date:** 2026-10-10
- **Task:** Close the home folder to build jobs for reading, not only for writing, and open only the folders a build needs.
- **Steps:** Started the gateway inside a profile that lets it read Kiro Crew's own folder and the folder it runs agents in, but not list the home folder or `/Users`. Triggered a one-line agent job. Then opened the folders above those two, but not the folders above the ones on the job's `PATH` (where `node` and `kiro-cli` live), and tried again.
- **Expected:** The job runs. Kiro Crew has full use of its own folders, and nothing it needs lives in the folders above them.
- **Actual:** First try: the job failed after 58 milliseconds with "cannot verify that macOS agent workspace … a filesystem check failed on '..'". Kiro Crew opens every folder above its own home and above the agent's run folder before it starts an agent. Second try: the job started, but its `PATH` was only `/usr/bin:/bin:/usr/sbin:/sbin`, so `node` was not found. Kiro Crew had dropped every `PATH` folder it could not open, or that has a closed folder above it, without saying so.
- **Severity:** medium. It forces a gap into any outer sandbox: macOS can't allow opening a folder without allowing its names to be listed, so a job can list the names directly inside the home folder and `/Users`.
- **Workaround:** Allow opening each folder above (and each `PATH` folder), and nothing inside them. The names can be listed; what they stand for stays closed.
- **Suggestion:** Check the folders above by looking at them (their kind and owner) instead of opening them for reading, and log every `PATH` entry that is dropped.

## F-043: `kirocrew` stops with a Python error when it may not look at the folder it was started in

- **Tool:** Kiro Crew 0.8.0, run inside our own macOS sandbox
- **Date:** 2026-10-10
- **Task:** Run `kirocrew cron add`, `trigger` and `remove` from a background job, inside the same sandbox as the gateway.
- **Steps:** The background job starts in the project's folder, which the sandbox closes. Ran `kirocrew cron add ...` from there. Separately, started the gateway with its folders moved to a throwaway place (`KIROCREW_HOME`, `KIRO_HOME`) while `~/.kiro/crew-auth-staging` was closed.
- **Expected:** `kirocrew cron` talks to the gateway and needs nothing from its working folder. With its folders moved, Kiro Crew looks only there.
- **Actual:** Every command stopped with a Python error before doing anything, so every build was refused. And Kiro Crew checks `~/.kiro/crew-auth-staging` under the real home folder whatever `KIRO_HOME` says, and crashes at start-up when it may not look at it.
- **Severity:** low to medium. Easy to work round, but the error says nothing about the cause.
- **Workaround:** Start `kirocrew` in a folder it is allowed to read, and leave `~/.kiro/crew-auth-staging` open in the sandbox.
- **Suggestion:** Don't depend on the working folder, keep every folder under the configured home, and say which path was refused.

## F-044: Kiro Crew rewrites agent files in the folder Kiro CLI loads agents from, through temporary files with other names

- **Tool:** Kiro Crew 0.8.0 with Kiro CLI 2.29.0
- **Date:** 2026-10-10
- **Task:** Let Kiro Crew keep its own agent files up to date, without letting a build job add an agent of its own. (Kiro CLI loads every `.json` file in `~/.kiro/agents` as an agent.)
- **Steps:** Allowed writing in `~/.kiro/agents` only for names that begin with `kirocrew` or `.kirocrew`, then started the gateway.
- **Expected:** Crew writes only files with its own names.
- **Actual:** The gateway logged "Agent config install failed". It writes each agent file through a temporary file named `tmp` plus eight characters plus `.tmp` in the same folder, then renames it. The folder is shared with the user's own Kiro CLI agents, and it is rewritten at every gateway start.
- **Severity:** low, once the pattern is known.
- **Workaround:** Allow both name patterns and nothing else. After two real builds the folder held nothing else and no write was refused.
- **Suggestion:** Keep Crew's agent files in Crew's own folder, or document the names it writes.

## F-045: A prompt given to `kiro-cli chat` as an argument shows up twice in the process list, and the CLI's help doesn't mention the safer way

- **Tool:** Kiro CLI 2.29.0 (`kiro-cli chat --no-interactive`)
- **Date:** 2026-10-10
- **Task:** Send private text (a transcript) to Kiro without any other program on the Mac being able to read it.
- **Steps:** Read `kiro-cli chat --help`. Ran `spikes/09-kiro-stdin-prompt.ts`: an invented prompt once as an argument and once piped in on standard input, while reading the arguments and environment of every process on the Mac 20 times a second.
- **Expected:** The help text mentions standard input, and something warns that an argument can be read by other programs. (On macOS any program of the same user can read another's arguments.)
- **Actual:** `kiro-cli chat --help` lists only `[INPUT]  The first question to ask`. Kiro's headless docs page does say piped input is read when there is no argument, but neither place says why that matters. Passed as an argument, the prompt was readable in the arguments of two processes, because `kiro-cli` starts `kiro-cli-chat` with the same arguments. Piped in, the whole prompt was read as one message (several lines; 13.8 KB in one try; accents, Japanese and emoji in another), and it appeared in no process's arguments or environment. With nothing piped in, Kiro exits 1 in 0.2 seconds without calling the model.
- **Severity:** medium for privacy until you know; low after. We had shipped the argument form in our always-on listener.
- **Workaround:** Always pipe the prompt in. Our runner now refuses to start Kiro with any argument longer than 200 characters.
- **Suggestion:** Mention standard input in `kiro-cli chat --help`, and warn in the headless docs that a prompt given as an argument is visible to other programs.

## F-046: Kiro CLI reads its settings from the home folder even when `KIRO_HOME` points somewhere else

- **Tool:** Kiro CLI 2.29.0
- **Date:** 2026-10-10
- **Task:** Give a sandboxed build its own Kiro folder, and close the user's own `~/.kiro` to it.
- **Steps:** Ran Kiro CLI inside our sandbox with `KIRO_HOME` set to a throwaway folder, and watched which files it needed.
- **Expected:** With `KIRO_HOME` set, Kiro CLI reads its settings there and nowhere else.
- **Actual:** It still reads `~/.kiro/settings/cli.json` under the real home folder. (Its sign-in is in a third place, `~/Library/Application Support/kiro-cli`, as spike 8 found.)
- **Severity:** low. It matters because the two content-sharing switches live in that settings file.
- **Workaround:** Leave `~/.kiro/settings` readable (never writable) in the sandbox, and keep content sharing switched off in the default settings folder as well as in any `KIRO_HOME` of our own.
- **Suggestion:** Document which files follow `KIRO_HOME` and which don't.

## F-047: Playwright runs every file whose name matches `testMatch`, in any subfolder

- **Tool:** Playwright 1.64.0
- **Date:** 2026-10-10
- **Task:** Run exactly one test file of our own, in a folder that also holds test files an AI agent wrote.
- **Steps:** A settings file with `testDir: "."` and `testMatch: "contract.spec.ts"`, with the app's own tests copied into a subfolder next to our test.
- **Expected:** Only `./contract.spec.ts` runs: the string names one file.
- **Actual:** Playwright puts `**/` in front of the string, so a file of the same name in any subfolder is picked up too. An app that shipped its own `tests/contract.spec.ts` would have had it run inside our test step, where it could print the result line our code reads.
- **Severity:** medium for anyone who runs trusted and untrusted tests side by side.
- **Workaround:** Run our own test from a folder that holds our files and nothing else. The app's tests go in a second folder, with a second settings file.
- **Suggestion:** Say in the `testMatch` docs that a plain string matches in every subfolder, and offer a way to name exactly one file.

## F-048: Playwright's browser is still running after the test runner's process group is killed

- **Tool:** Playwright 1.64.0 (Chromium headless shell)
- **Date:** 2026-10-10
- **Task:** Make sure nothing is left running when a browser test ends or runs out of time.
- **Steps:** Our runner starts every command as the leader of its own process group and kills that group when the command ends or runs out of time. Ran `playwright test` that way and looked at what was left.
- **Expected:** The browser goes with the group.
- **Actual:** Playwright starts its browser outside the runner's process group, so the group kill misses it.
- **Severity:** medium for an unattended job, where a leftover browser would run on with no time limit.
- **Workaround:** Watch from outside while the test runs (which processes descend from it, a tag in their environment, which folder they live in), and kill whatever is left when it ends.
- **Suggestion:** An option to keep the browser in the runner's process group, or a note about it in the CI docs.

## F-049: Playwright keeps compiled copies of tests in the shared temporary folder and uses them again

- **Tool:** Playwright 1.64.0
- **Date:** 2026-10-10
- **Task:** Run our own test after code we don't trust has run with the same temporary folder.
- **Steps:** With `TMPDIR` set to an empty folder, ran `playwright test -c contract.config.ts --list`, then looked in that folder and read how Playwright loads its cache.
- **Expected:** Nothing left behind that a later run trusts, or a cache kept next to the project.
- **Actual:** The folder now held `playwright-transform-cache-<user number>/`, with compiled copies of our test and of our settings file. A later run loads those instead of compiling again. By reading the code, not by trying it: a program that ran earlier with the same temporary folder could leave a compiled "test" there for our run to pick up.
- **Severity:** low for ordinary use; medium wherever untrusted code and a trusted test share a temporary folder.
- **Workaround:** Give every command a fresh temporary folder of its own, and set `PWTEST_CACHE_DIR` to a folder inside it.
- **Suggestion:** Mention the cache, and `PWTEST_CACHE_DIR`, wherever the docs talk about running tests on shared machines.

## F-050: Kiro Crew describes a 3:00 schedule as "At 4:00 AM"

- **Tool:** Kiro Crew 0.8.0 (`kirocrew cron`)
- **Date:** 2026-10-10
- **Task:** Give a build job a schedule that is never due on a normal night (3:00 a.m. on January 1st), so that it only ever starts when Overnight triggers it.
- **Steps:** `kirocrew cron add <name> "<message>" --cron "0 3 1 1 *" --timezone America/Boise`, in October, while this Mac is on daylight-saving time. Then read how Kiro Crew describes the job's schedule.
- **Expected:** "At 3:00 AM", in the time zone given. (On January 1st Boise is on standard time, MST.)
- **Actual:** Kiro Crew described the schedule as "At 4:00 AM MST": an hour off. We did not look into why; our guess is that the hour is worked out with today's daylight-saving offset and labelled with January's. We did not check which of the two times the job would really run at.
- **Severity:** low for us, because our jobs are started by `cron trigger` and never by their schedule. For anyone relying on a daily time across a clock change, it is worth checking.
- **Workaround:** None needed. We chose a schedule that is months away either way.
- **Suggestion:** Describe the schedule exactly as it will run in the job's time zone, and say in the docs what happens to a daily job when the clocks change.

## F-051: Kiro's sign-in lasts an hour and can't be renewed from inside a sandbox that closes the Keychain

- **Tool:** Kiro CLI 2.29.0, and Kiro Crew 0.8.0 (which starts Kiro CLI for its agents)
- **Date:** 2026-10-10
- **Task:** Run Kiro builds unattended inside a macOS sandbox that refuses the Keychain (the GitHub login is in there too, and a build must not reach it).
- **Steps:** Sign in once with `kiro-cli login`. Leave Kiro unused for more than an hour. Start the Kiro Crew gateway (or `kiro-cli whoami`) inside the sandbox.
- **Expected:** Still signed in. We signed in with a browser once and expected that to last.
- **Actual:** Kiro's sign-in is good for about an hour (`kiro-cli whoami -vvv` prints `valid_for=3567s` right after a renewal). After that Kiro renews it by itself, using a secret in the Keychain. Inside the sandbox that fails: `whoami -vvv` logs "refreshing social access token" and then "encountered orchestrator error; halting", and the gateway logs "AcpRuntime dead ... You are not logged in, please log in with kiro-cli login" and "Failed to create background session". Nothing was wrong with the sign-in: the same command outside the sandbox renewed it at once, and after that the sandboxed programs were signed in again too. A poll every four minutes inside the sandbox missed all of this for two hours, because something outside kept renewing it.
- **Severity:** high for unattended use. The build at 1:00 a.m. is the first Kiro use in hours.
- **Workaround:** Before every build our own code, outside the sandbox, runs `kiro-cli whoami -vvv` (`packages/builder/src/kiro-signin.ts`). That renews a sign-in that has run out. Kiro has no command to renew one early, so if less than ten minutes are left we wait for it to run out and ask again. The Kiro CLI builder is the fallback if a Kiro Crew agent still can't start.
- **Suggestion:** A `kiro-cli` command that renews the sign-in now, and one that prints how long it still lasts without `-vvv`. Say in the headless docs that the sign-in is hourly and what renewing it needs. Let the gateway retry its background session after a sign-in failure, and say "the sign-in could not be renewed" rather than "you are not logged in".

## F-052: A brand-new Kiro home can't start an agent inside a sandbox that makes Kiro's settings folder read-only

- **Tool:** Kiro CLI 2.29.0 (found through Kiro Crew 0.8.0)
- **Date:** 2026-10-10
- **Task:** Start the Kiro Crew gateway inside our sandbox with a fresh, empty Kiro home (a throwaway one, for testing).
- **Steps:** Point `KIRO_HOME` at an empty folder with an empty `settings` folder in it. Start the gateway inside a sandbox that lets a job read `settings` but not write it. Start an agent job.
- **Expected:** The agent starts. Reading settings should not need to write.
- **Actual:** Every agent start fails at once: "io error acquiring file lock at <home>/settings/cli.json.lock: Operation not permitted", then "Failed to create background session". Kiro CLI creates `cli.json` and `cli.json.lock` the first time it runs, even just to read a setting. On this Mac both files have been there since Oct 9, so the real install is not affected.
- **Severity:** low for us, medium for anyone sandboxing a fresh install.
- **Workaround:** Run one Kiro command outside the sandbox first (`kiro-cli settings telemetry.enabled`), which creates both files.
- **Suggestion:** Open the lock file read-only when only reading, or keep it somewhere meant for run-time files rather than beside the settings.

## F-053: Kiro Crew asks macOS for its jobs' process groups, so the list of running programs cannot be hidden from its jobs

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-11
- **Task:** Hide the list of running programs (the name and number of everything running on the Mac) from a build job, the way our morning sandbox already does.
- **Steps:** Tried the rule that hides it, `(deny sysctl-read (sysctl-name-prefix "kern.proc."))`, in throwaway sandboxes around macOS's own tools, and then in our Kiro CLI build profile on a made-up home folder. Then read how Kiro Crew's installed code finds the processes of its jobs (names of its functions only).
- **Expected:** The rule hides other programs, and leaves a program free to ask about itself and about what it started.
- **Actual:** Half of that. With the rule, a program's own child is still answered when asked for by its number, but the program's own process *group* is refused. Kiro Crew's code asks macOS for the members of a process group to look after its jobs, and ends jobs by process group. So the rule could not go into the profile the whole gateway runs in. We left it out on the strength of that reading: we did not start a gateway under the rule to see what breaks.
- **Severity:** medium. One line of "what a build job can still reach" stays open with Kiro Crew for this reason alone.
- **Workaround:** The rule is in the Kiro CLI builder's profile only. With Kiro Crew a job can still see which programs are running (never their command lines), and SPEC §9 says so.
- **Suggestion:** Have the gateway follow its jobs by the process numbers it was handed when it started them, without asking the system-wide process table. Or write down exactly which questions the gateway asks of macOS, so that an outer sandbox can allow those and nothing else.

## F-054: Kiro Crew's usage file sits where its own jobs can write it

- **Tool:** Kiro Crew 0.8.0
- **Date:** 2026-10-11
- **Task:** Count what each build cost from Kiro Crew's own record, and stop building for the month at a ceiling.
- **Steps:** After each run we read that job's credits from `<Kiro Crew's home>/usage/tokens/<day>.jsonl`. Then, from inside the sandbox a job runs in (our gateway profile, on a made-up home folder), a stand-in "job" added one line to that file.
- **Expected:** A record of spend that the thing being measured cannot change.
- **Actual:** The line was added without complaint. The usage file is inside Kiro Crew's own home folder, and a job has to be able to write there. One added line saying 100,000 credits was read back as that job's cost and closed our month; a line with a minus figure cancelled a real figure down to 0. We run Kiro Crew with its own sandbox off (F-034), so this was measured under ours. Under Kiro Crew's own sandbox a job could write anywhere in the home folder when we measured that (F-033), so we expect the same there, but did not try it. Also not known yet: whether Kiro Crew writes usage lines at all for a run that was cancelled or ran out of time.
- **Severity:** medium for anything that budgets or bills from that file.
- **Workaround:** We believe Kiro Crew's figure only when the try could have used it: at most 10 credits for each minute the agent ran, and never a minus figure. Otherwise we count our own estimate of 2 credits a minute, with a warning in the log. A job can still make the count too low; our limit of two builds a night bounds what is really spent.
- **Suggestion:** Keep usage records where jobs cannot write, or have the gateway hold them and hand them out through its local web address. A `kirocrew usage --job <id> --json` command would save every caller from reading the files.

## F-055: Playwright's `page.waitForFunction("...")` fails on a page with a strict content-security policy

- **Tool:** Playwright 1.64.0, used as a library from our test runner
- **Date:** 2026-10-11
- **Task:** Test our dashboard's own page script in the headless browser. The dashboard's pages are served with a policy that forbids running text as code (`script-src 'self'`, no `unsafe-eval`).
- **Steps:** `await page.waitForFunction("<a condition written as text>")` on such a page.
- **Expected:** It works like `page.evaluate("<the same text>")`, which does work under that policy.
- **Actual:** As soon as it has to try a second time it fails with an `EvalError` that names `unsafe-eval`: the text is run with `eval` inside the page.
- **Severity:** low. A few minutes lost.
- **Workaround:** Wait from the test's side instead: `expect.poll(() => page.evaluate(...))`.
- **Suggestion:** Run a text condition the way `evaluate` runs one, or say in the docs that `waitForFunction` with text needs `unsafe-eval`.

## F-056: Two socket files of Kiro's sit in the user's temporary folder, and nothing says what they are for

- **Tool:** Kiro CLI 2.29.0 (the desktop app it installs, see F-015)
- **Date:** 2026-10-11
- **Task:** Decide which socket files a sandboxed build must be able to connect to, and which it must never reach. (A socket file is how one program on a Mac talks to another without a port.)
- **Steps:** Listed the socket files in this account's usual temporary folder: `find "$(getconf DARWIN_USER_TEMP_DIR)" -maxdepth 3 -type s`.
- **Expected:** None of Kiro's, or documented ones.
- **Actual:** Two, in a folder named `kirorun`: `desktop.sock` and `remote.sock`. By the name they belong to Kiro's desktop app, which starts at login and runs outside our sandbox; we did not check which process listens on them, and we found nothing written about what they accept. Whether a headless `kiro-cli chat` or a Kiro Crew agent needs them is not known yet: under our new rule only version questions and one settings read have been tried. Before Milestone 3 nothing in our build sandbox would have stopped a build job from connecting to them, because rules about files do not cover connecting to a socket file (found on Oct 10; not tried against these two).
- **Severity:** low so far. It becomes medium if a headless chat turns out to need one of them: a socket that a program outside the sandbox listens on is a way out of the sandbox.
- **Workaround:** Our build sandboxes now refuse every socket file outside the folders a build may write, these two included. If a proof run shows one of them refused, we read that as the rule working, not as a path to add to the list.
- **Suggestion:** Say in the docs what the desktop app's socket files are for and whether headless `kiro-cli` needs them. Offer a way to run headless chats that needs nothing from the desktop app.
