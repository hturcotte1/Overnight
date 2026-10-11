# Spikes (Milestone 0)

One small script per outside piece, run for real before we build on it. This file records what each one proved. No Bee data appears here: only field names, timings and yes/no answers.

Later sections record what building Milestones 1 and 2 added, each checked against the real tools.

Last updated: 2026-10-10

## Status

| # | Question | Script | Status |
|---|---|---|---|
| 1 | Is Bee logged in (`bee me --json` exits 0), and does the live stream deliver Apple Watch utterances? How late? | `spikes/00-bee-login.ts`, `spikes/01-bee-stream.ts` | **Passed** (2026-10-09) |
| 2 | Does a recording under ~50 words show up? Does it vanish later? | `spikes/01-bee-stream.ts`, then `spikes/02-bee-short-recording.ts` | **Answered** (2026-10-09): it shows up, then Bee deletes it about 6 minutes later |
| 3 | Does a to-do alarm buzz the watch? Does ticking it send `todo-updated` with `completed: true`? | `spikes/03-bee-todo-alarm.ts` | Buzz: **yes**. Event on tick: **no, so we poll** (2026-10-09) |
| 4 | Do `bee facts list` and `bee facts create` work? | `spikes/04-bee-facts.ts` | **Passed** (2026-10-09) |
| 5 | Is Kiro Crew installed and healthy, and does a scheduled job run a shell command on time? | `spikes/05-crew-scheduled-job.ts` | **Passed**, with three findings that change the build plan (2026-10-09) |
| 6 | Does `kiro-cli chat --no-interactive` build a hello-world Vite app? | `spikes/06-kiro-build.ts` | **Passed** (2026-10-09): built in 52 seconds |
| 7 | Does publishing a `dist/` folder to `overnight-apps` give a working GitHub Pages link? | `spikes/07-pages-publish.ts` | **Passed** (2026-10-09) |
| 8 | Does `kiro-cli chat --no-interactive` (no tools) return valid detector JSON? | `spikes/08-kiro-detector.ts` | **Passed** (2026-10-09): 6 of 6 valid and correct |
| 9 | Does `kiro-cli chat --no-interactive` read its prompt from standard input, so the prompt need not be on the command line? | `spikes/09-kiro-stdin-prompt.ts` | **Passed** (2026-10-10): the whole prompt is read from standard input, and it appears in no process's arguments |

## This Mac's setup

Everything except Kiro CLI is installed per user, with no Homebrew. Kiro CLI's installer puts an app in `/Applications`; it needed no password only because this account is an administrator.

| Tool | Version | Where | How |
|---|---|---|---|
| Node.js | 24.21.0 (LTS) | `~/.local/node` | Official `node-v24.21.0-darwin-arm64.tar.gz` from nodejs.org, checksum verified |
| npm | 11.19.0 | ships with Node | |
| GitHub CLI (`gh`) | 2.102.0 | `~/.local/bin/gh` | Official `gh_2.102.0_macOS_arm64.zip` from github.com/cli/cli, checksum verified |
| Bee CLI (`bee`) | 0.7.3 | `~/.local/node/bin/bee` and this repo's `node_modules/.bin/bee` | `npm i -g @beeai/cli@0.7.3` and `npm install` |
| Kiro CLI (`kiro-cli`) | 2.29.0 | `/Applications/Kiro CLI.app`, linked at `~/.local/bin/kiro-cli` | Official installer script from cli.kiro.dev (364 MB disk image, checksum verified by the script). Adds a login item that starts the Kiro CLI app |
| Kiro Crew (`kirocrew`) | 0.8.0, pinned | `~/.kiro/crew-venv`, linked at `~/.local/bin/kirocrew` | Official installer script from download.crew.kiro.dev with `--version 0.8.0`. Brings its own Python 3.12 |

`~/.zshenv` adds `~/.local/bin` and `~/.local/node/bin` to `PATH`. Background jobs (launchd) don't read that file, so they must use full paths.

Kiro: `kiro-cli` is signed in with GitHub on the **Kiro Pro** plan (1,000 credits a month). All of today's Kiro tests together, including a second run of each script, used about 1.1 credits. Kiro Crew settings changed from their defaults: `stt.enabled false` (voice typing, unused), `timezone America/Boise`, `auto_update false`. On Oct 9 the sandbox and approval settings were untouched. Since Milestone 2 experiment A (Oct 10), `agent.sandbox` on the real install is `strict` (it was `auto`). `agent.sandbox_allow_unsandboxed_exec` has not been switched on there yet; every test that needed it used a throwaway Kiro Crew home. Switching it on is the first step of the real set-up, which is pending. Kiro CLI settings changed: `codeWhisperer.shareCodeWhispererContentWithAWS false` and `telemetry.enabled false`, in the default settings folder and in the detector's own `KIRO_HOME` (Henry's decision, Oct 9).

GitHub: `gh` is logged in as `hturcotte1` (token in the macOS keychain, scopes `repo`, `read:org`, `gist`). This folder's `origin` is `https://github.com/hturcotte1/Overnight.git`.

## What the installed Bee CLI told us before login

Checked on 2026-10-09 against the installed `@beeai/cli` 0.7.3 (its `--help` output and the library source in `dist/lib/`).

**The CLI commands SPEC §4 uses, and the other to-do commands we looked at, exist as written:**

```
bee stream [--types a,b] [--json]
bee changed [--cursor <cursor>] [--json]
bee conversations transcript <id> [--since <epochMs>] [--json]
bee todos get <id> [--json]
bee todos create --text <text> [--alarm-at <iso>] [--json]
bee todos update <id> [--text <text>] [--completed <true|false>] [--alarm-at <iso> | --clear-alarm] [--json]
bee todos complete <id> [--json]
bee todos delete <id> [--json]
bee facts list [--limit N] [--cursor <cursor>] [--unconfirmed] [--json]
bee facts search --query <text> [--limit N] [--json]
bee facts create --text <text> [--json]
bee login [--qr] [--no-wait] [--token <token>] [--token-stdin]
bee me [--json]
```

**The library (`@beeai/cli/lib`) is a thin wrapper that runs the `bee` program:**

- `createBeeClient(options?)` returns `{ auth, api, sse, run, runJson }`.
- Every call spawns `bee <args> --json` and parses what it prints. There is no direct HTTP client in the library.
- `sse.streamJson({ types, signal })` spawns `bee stream --json --types a,b` and returns `{ events, close, process }`. `events` is an async iterable of `{ data, raw }`.
- Reading the source, `close()` kills the child process and the iterator then throws `Bee CLI stream exited with code 1`, so callers must treat that as a normal stop.
- `api.todos.create({ text, alarmAt })`, `api.todos.update(id, { completed })`, `api.facts.list()`, `api.facts.create(text)`, `api.changed({ cursor })` all exist.
- Missing from the library: `conversations.transcript` and `facts.search`. Use `client.runJson([...])` for those.
- Everything is typed `unknown`. We write our own zod schemas once the spikes show the real shapes.
- The default command is the literal `bee` looked up on `PATH`. We pass `command:` with the full path to the platform binary (`node_modules/@beeai/cli/dist/platforms/mac-arm64/bee`). The `node_modules/.bin/bee` launcher is a Node script, so it needs `node` on `PATH` too, which background jobs don't have.

**Login state:**

- `bee status` prints `Not logged in.` and still exits 0. Use `bee me --json` (exit 1 when logged out) or `auth.isAuthenticated()`.
- `bee ping` answers `pong` without a login, so network reachability and auth can be checked separately.

## Results

### Spike 1: Bee login and live stream. Passed (2026-10-09)

**Login.** `spikes/00-bee-login.ts` runs `bee login` and shows only the pairing link (the CLI's own output includes the account holder's real name, which we never print). We opened the link on the Mac, which shows a QR code; the phone owner scanned it with the iPhone camera and approved in the Bee app. Link to approved: **64 seconds**. The link is valid for about 5 minutes. The token went into the macOS Keychain with no prompt. `bee me --json` then exits 0.

**Stream.** `spikes/01-bee-stream.ts` opened nine `bee stream --json` processes at once (one per event type). All nine connected, and six delivered events (the `connected`, `todo-created` and `todo-updated` streams only ever sent the connect line), so several streams at once are allowed.

What really arrives (this differs from Bee's README and docs in several ways):

- **Every event we received (six types) had a top-level `type` field holding the event name** (`"new-utterance"`, `"update-conversation"`, `"todo-deleted"`, ...). The docs say there is no such field. So one stream asking for several `--types` should be enough. We haven't run it that way yet; M1 starts by checking it.
- The first line on every stream is `{ "timestamp": <epoch ms> }` with no `type`. It's the connect message, and it arrives even when `--types` filters for something else.
- `new-utterance` is `{ type, conversation_uuid, utterance: { id, sample_id, start, end, text, spoken_at } }`. There is **no `speaker` field**. `spoken_at` is an ISO time with one-second precision. `start` and `end` are second offsets into some shorter piece of audio; they reset several times within one conversation, and utterances can arrive out of spoken order, so order by `spoken_at`, never by `start`.
- `new-conversation`, and `update-conversation` while the state is `CAPTURING` or `PROCESSING`, are `{ type, conversation: { id, conversation_uuid, start_time, end_time, state, device_type, device_id, summary, short_summary, primary_location, template, city, business, bookmarked } }`. The uuid field is `conversation_uuid` (the README calls it `uuid`). `device_type` was `"unknown"` for the Apple Watch.
- **The final `update-conversation`, state `COMPLETED`, is much bigger: it carries the whole transcript.** `conversation` loses `primary_location` and gains `key`, `suggested_links`, `suggested_templates`, `summarization_model` and `transcriptions`: `[{ id, model, realtime, transcription_time, utterances: [{ id, sample_id, start, end, text, speaker, person_id, person_first_name, spoken_at, chunk_id }], utterance_chunks: [{ id, chunk_text }] }]`. We got two transcriptions (realtime and final) of 32 utterances each. `speaker` was null on all of them; `person_first_name` held a real first name on 10 of 32. So the full transcript and a real first name **do** arrive on the stream. We missed this at first: the spike printed the field layout only for the first few events of each type, and an independent review of the raw capture caught it.
- `update-conversation-summary` is `{ type, conversation_id, short_summary }`. It arrives while the conversation is still being captured, more than once.

**Latency** (time from `spoken_at` to the event reaching this Mac):

| Batch | Utterances | Min | Median | Max |
|---|---|---|---|---|
| About 80 seconds of continuous talk | 28 (181 words) | 1.4 s | 6.2 s | 9.6 s |
| A few short lines after a pause | 4 (21 words) | 26.9 s | 31.6 s | 37.1 s |
| One sentence in a new recording | 1 (7 words) | 14.2 s | | |

Utterances arrive in small bursts (one to four at a time) every few seconds while someone is talking: 16 bursts in 79 seconds, 1 to 10 seconds apart. After a pause the watch seems to upload less eagerly.

**Conversation lifecycle** (one real conversation):

| Time | What happened |
|---|---|
| 0:00 | `new-conversation`, state `CAPTURING` |
| 0:01 to 1:20 | utterances from the first recording arrive |
| 3:30 to 3:50 | utterances from the second recording arrive (spoken 3:03 to 3:19) |
| 1:31 and 3:41 | `update-conversation-summary` |
| 3:19 | last words spoken |
| 9:50 | `update-conversation`, state `PROCESSING`, `end_time` set (**6 min 31 s after the last words**) |
| 10:01 | `update-conversation`, `PROCESSING`, summary filled in |
| 10:02 | `update-conversation`, state `COMPLETED` |

A second recording, made about two minutes after the first one ended, was **added to the same conversation**, not a new one. A recording made after the conversation had completed started a new conversation.

**What this means for the build:**

- Plan on one stream and switch on `data.type` (first check in M1 that one stream with several `--types` behaves the same). Skip lines without a `type`.
- Don't wait for Bee to close a conversation before running the detector. Bee takes about 6.5 minutes of silence to do that. Our own "2 minutes with no new utterances" timer is the trigger, as the spec planned.
- A "conversation" can contain several separate recordings. Run the detector on the utterances since the last detector run, not on the whole conversation.
- Live utterances carry no speaker label, so the detector's `said_by_wearer_guess` can only be a guess from the words. A first name arrives only later, inside the `COMPLETED` conversation event, and we don't use it.
- Map `conversation_uuid` to the numeric `id` from `new-conversation` / `update-conversation` events.
- Dedupe utterances by `utterance.id`.
- **Never log or store a raw conversation event.** From conversation events the listener keeps only `id`, `conversation_uuid`, `state`, `start_time` and `end_time`, and drops `transcriptions`, `summary` and `short_summary`.

### Spike 2: short recordings. They arrive, then Bee deletes them (2026-10-09)

One 7-word sentence, recorded on its own after the earlier conversation had completed:

| Time | What happened |
|---|---|
| 0:00 | Sentence spoken |
| 0:14 | `new-conversation` (state `CAPTURING`) and `new-utterance` reach the stream |
| 6:14 | `update-conversation`, state `PROCESSING` |
| 6:15 | **`delete-conversation`**: `{ type, conversation: { id, conversation_uuid, state, ... } }` |
| after | `bee conversations get <id>` and `bee conversations transcript <id>` both exit 1 with `Conversation not found` |

So the hackathon forum was right: Bee throws away very short recordings once it finishes processing them. We tested 7 words (deleted) and about 200 words (kept); we did not measure where the line is.

`bee changed` kept working afterwards (exit 0) and simply didn't list the deleted conversation.

For comparison, the long conversation was kept. Its stored transcript has one final (non-realtime) transcription with 32 utterances, each `{ id, text, speaker, spoken_at, start, end, realtime, created_at }`. Here, unlike on `new-utterance`, there **is** a `speaker` field: either a first name or `Unknown`. (The `COMPLETED` stream event carries the same name as `person_first_name`.)

**What this means for the build:**

- An idea said in one short sentence is exactly what Overnight is for, and Bee deletes those. **Snapshot every utterance the moment it arrives** and run the detector from our own copy. Never re-fetch.
- Treat `Conversation not found` and `delete-conversation` as normal. They must not delete our snapshot or cancel an idea that's already been heard.
- Speaker names exist only for conversations Bee keeps, and only minutes later, in two places: the stored transcript (`speaker`) and the `COMPLETED` `update-conversation` stream event (`person_first_name`). They are personal data: never log them, never put them in briefs.

### Spike 3: to-do alarm as the wrist prompt. Buzz works; approval needs polling (2026-10-09)

`spikes/03-bee-todo-alarm.ts` creates a to-do with an alarm two minutes out, then watches it two ways: the stream, and `bee todos get <id>` every 5 seconds.

`todos create` returns a bare object: `{ id, text, alarm_at (epoch ms), completed, created_at, corrections, timezone }`. The alarm time we sent as UTC (`...Z`) was stored exactly.

| Run | At the alarm time | Then in the Bee app | Stream | Polling `todos get` |
|---|---|---|---|---|
| 1 | A notification reached the phone. Bee notifications weren't fully turned on, and no wrist buzz was noticed | Ticked as done | **No `todo-updated` event** on either of two streams, in the five minutes they kept listening | `completed: true` on a manual `todos get` about a minute after the tick (polling was added to the script for run 2). `bee changed` also showed it |
| 2 | **Watch and phone both buzzed** | Deleted | `todo-deleted` arrived within a few seconds (we didn't time the tap): `{ type, todo: { id, conversationId, text, completed, alarmAt, appleId } }` | Exit code 1 with `Todo not found.` 0.6 s after the event |

Also: creating a to-do through the CLI produced **no `todo-created` event** in either run. In a later re-run we completed a test to-do through the CLI instead of the app: the poll saw `completed: true` on its next 5-second check, and again no `todo-updated` event arrived. And `bee todos update <id> --clear-alarm` did not clear the alarm (F-023).

**What this means for the build:**

- The ask works: a Bee to-do with an alarm two minutes out buzzed the phone and the wrist in run 2. In run 1 the phone showed a notification but no wrist buzz was noticed, with Bee notifications not fully turned on; we didn't record what changed in between. The README tells users to allow notifications for Bee and to test with a throwaway to-do.
- **Approval can't rely on the stream.** Poll `bee todos get <id>` for each open ask (at most 3 a day, so this is cheap): `completed: true` means approved; `Todo not found.` means rejected. Treat a `todo-deleted` event as a faster hint for rejection only.
- Any other error from `todos get` (offline, server error) means "unknown, try again", never "rejected".
- A failing command prints its usage text to standard output, so check the exit code before parsing JSON.

### Spike 4: facts. Passed (2026-10-09)

| Call | Result |
|---|---|
| `facts list` | `{ facts: [], next_cursor, timezone }`. Confirmed facts only; the account had none |
| `facts list --unconfirmed` | 3 facts Bee inferred by itself: `{ id, text, tags[], created_at, confirmed: false }` |
| `facts search --query prefers` | `{ results: [], next_cursor, search_mode, timezone }` |
| `facts create --text "..."` | Bare object `{ id, text, tags: ["general"], created_at, confirmed: true, user_id, timezone }` |
| `facts list` again | Now contains the new fact |

**What this means for the build:**

- A fact we write is **confirmed straight away** (Bee's docs example shows `confirmed: false`), so it shows up in the default list. Good for "Bee remembers what was built".
- For brief-writing, read both confirmed and unconfirmed facts; a new account may have only unconfirmed ones. Treat unconfirmed facts as weaker hints. Facts go into briefs only after the login gap from spike 5 (finding 3) is closed; see SPEC §6.

### Also seen: `bee changed`

With no cursor, `bee changed --json` returned `{ meta: { next_cursor, since, until, updated, timezone }, facts, todos, dailies, conversations, journals }` covering about the last day: 60 to-dos and 2 conversations **with full transcripts**. On first start the listener should call it once only to get `meta.next_cursor`, and not process the old items.

### Spike 5: Kiro Crew health and scheduled jobs. Passed, with three findings (2026-10-09)

**Health.** After `kirocrew setup --agent-only`, `kirocrew doctor` found Kiro CLI, its sign-in, Node, and a working sandbox (`sandbox-exec`, Apple's built-in one). It still exited 1 with "Fix these issues: speech recogniser, ffmpeg", which are for a voice-typing feature we don't use. After `kirocrew config set stt.enabled false` it exits 0 and ends with `✅ Kiro Crew is ready!`.

**Scheduled jobs.** `spikes/05-crew-scheduled-job.ts` uses "command" jobs, which run one fixed shell line inside Crew's sandbox with no AI and no credits.

| Test | Result |
|---|---|
| One-shot job, `--at "in 2 minutes"` | Ran 121 seconds after it was requested. On time |
| Daily job, `--cron "<3 minutes from now>" --timezone America/Boise` | **Its command had not run 12 minutes after its time**, when we removed it. Crew's installed code delays daily jobs by a random 0 to 59 minutes unless a job's `strict_schedule` is on, and the 0.8.0 CLI has no flag for that |
| Daily job set for 3:00 a.m., then `kirocrew cron trigger <id>` | Ran within 1 second |
| `cron trigger` on a job already waiting out its random delay | `Error: HTTP 409`, and the command still exits 0 |

**Finding 1: Crew's own clock isn't exact, but `cron trigger` is.** For a 1:00 a.m. build, our own macOS timer (launchd) should run `kirocrew cron trigger <job id>`, and the Crew job's own schedule must not be due at that time (see the 409 row). According to Apple's launchd manual, launchd starts a missed job when the Mac next wakes; according to Crew's source, Crew by itself skips a run if the Mac was asleep. Neither was tested here.

**Finding 2: under default approval settings, an AI job can't build anything.** We scheduled a small agent job that had to create one file and run `node --version`. Result after 6 minutes: no file, and the agent's own summary was "Both steps were denied by policy". Crew still recorded the run as `success`. Each denied step waited 3 minutes for someone to click approve. (Crew's default agent config pre-approves reading tools only, so such a job can look but not build.) Crew's documented switch for unattended work is the per-job flag `--approval-mode auto`. Our rule says not to weaken Crew's approval settings, so **this needs Henry's decision before M2** (see "Decisions needed" below).

**Finding 3: the sandbox does not keep our logins away from a job.** Probe jobs inside the default sandbox reported:

| Probe | Result | Meaning |
|---|---|---|
| `node --version` | `v24.21.0` | Host tools on the gateway's `PATH` are usable |
| `gh auth token \| wc -c` | 41 bytes | **A job can read the GitHub login token** |
| `bee me --json \| wc -c` | 101 bytes | **A job can call Bee as the logged-in user** |
| `curl` to the npm registry | HTTP 200 | Network is open |
| A command that mentions `~/.ssh` | Refused when the job was added | Crew does block some credential paths by name |

So "credentials never reach the coding agent" can't rest on Crew's default sandbox. We expect the same of `kiro-cli` run directly, since it also runs as the Mac user; that is to be tested in M2.

### Spike 6: Kiro CLI builds a hello-world Vite app. Passed (2026-10-09)

`spikes/06-kiro-build.ts` ran, in an empty folder under `~/.overnight/spikes/`:

```
kiro-cli chat --no-interactive --model auto --trust-tools read,write,shell "<prompt>"
```

| Measure | Result |
|---|---|
| Time | 52 seconds, exit code 0 |
| What Kiro did | Wrote 7 files, ran `npm install` and `npm run build`, wrote `BUILD_NOTES.md` |
| Our own check afterwards | `npm ci` and `npm run build` both pass; `dist/index.html` exists; `base: './'`; asset paths are relative; the heading is in the built app; the click count uses `localStorage` |
| Credits | About 0.4 |

Notes for the build:

- Plain mode prints the answer on standard output and tool activity (`[tool] Creating package.json`, `[tool] Running: npm install`) on standard error. No colour codes when `NO_COLOR=1` is set.
- Kiro has no timeout flag, so our wrapper sets one and kills the whole process group.
- Kiro picked older versions from memory (Vite 5.4, TypeScript 5.6). The brief should name the versions we want.
- Kiro, and our own `npm ci` / `npm run build` check afterwards, get an environment with only `HOME`, `PATH`, `TMPDIR` and `NO_COLOR`, so nothing held in an environment variable reaches agent-written code.
- The trusted tools are not limited to the folder Kiro starts in. Limits have to come from permission rules, which we haven't tested yet.

### Spike 8: Kiro CLI as a no-tools idea detector. Passed (2026-10-09)

`spikes/08-kiro-detector.ts` sent six **synthetic** transcripts from `fixtures/detector/` (two ideas, four non-ideas) through:

```
kiro-cli chat --no-interactive --agent overnight-detector --model claude-haiku-4.5 "<prompt + transcript>"
```

(That is how the spike ran. Since Oct 10 the detector sends the prompt on standard input instead, with no prompt on the command line: see spike 9 below.)

| Measure | Result |
|---|---|
| Valid JSON matching the detector schema | 6 of 6, first try |
| Correct ask / don't-ask decision | 6 of 6 |
| Time per transcript | 3.9 to 4.5 seconds |
| Credits for all six | Under 0.1 |

How "no tools" works, since Kiro has no flag for it:

- The default agent **does** have tools even with no trust flags: in a control run it read a file from the current folder.
- `overnight-detector` is a custom agent whose `tools` list is empty (`spikes/kiro/overnight-detector.json`). Asked to read that same file, it could not, and no tool ran. It did *claim* to have file tools while failing, so we trust the validated JSON, never the model's description of what it did.
- It runs from an empty folder with its own `KIRO_HOME` under `~/.overnight/`, so no project files, steering files or old sessions reach the prompt. The Kiro sign-in still works there, because the login lives in `~/Library/Application Support/kiro-cli`, not in `KIRO_HOME`.
- A missing agent name exits with code 4 and a clear error.

Six transcripts prove the plumbing, not the accuracy. The 40-transcript golden set in M1 measures precision and recall.

### Spike 7: GitHub Pages publishing. Passed (2026-10-09)

**Question:** does copying a `dist/` folder into `<slug>/` in a public repo with Pages on give a working link?

**Answer:** yes. Live test page: https://hturcotte1.github.io/overnight-apps/hello-spike/

What the script did, all through the `gh` login (no token handled by our code):

1. `gh repo create hturcotte1/overnight-apps --public`
2. Cloned it to `~/.overnight/spikes/overnight-apps`, copied `spikes/fixtures/hello-dist/` into `hello-spike/`, committed and pushed to `main`.
3. Turned Pages on: `gh api -X POST repos/hturcotte1/overnight-apps/pages -f "source[branch]=main" -f "source[path]=/"`. The reply was `build_type: "legacy"`, `html_url: https://hturcotte1.github.io/overnight-apps/`.
4. Polled the page until it contained a marker unique to that push.

| Run | Push to live | Pages build time | `./assets/app.js` | `./assets/_probe.txt` |
|---|---|---|---|---|
| A: first push, Pages just enabled, no `.nojekyll` | 53 s | 46.7 s | 200 | **404** |
| B: second push, with `.nojekyll` at the repo root | 21 s | 17.4 s | 200 | 200 |

Checked in a real browser too: the page loaded its script through the relative path `./assets/app.js` with no console errors.

**What this means for the build:**

- The link form is `https://hturcotte1.github.io/overnight-apps/<slug>/`, as the spec assumed.
- Relative asset paths work from a subfolder, so Vite `base: './'` is right.
- **`.nojekyll` is required** at the root of `overnight-apps`. Without it, GitHub's Jekyll step drops any file or folder whose name starts with `_`, and Vite can produce such chunk names. The file is now in the repo.
- Publishing takes roughly 20 to 60 seconds. Deliver should poll the page for content unique to the new build (not just a 200), with a timeout of a few minutes. `gh api repos/<owner>/<repo>/pages/builds/latest` gives `status` (`building`, then `built`) and `duration` in milliseconds as a second signal.
- The default `gh auth login` scopes (`repo`, `read:org`, `gist`) were enough to create the repo, push and enable Pages.

## Extra checks before Milestone 1 (2026-10-09)

Three small questions the listener's design depends on, answered on this Mac:

| Question | Answer |
|---|---|
| Can a macOS background job (LaunchAgent) read this repo, which lives in `~/Documents`, and use the Bee login in the Keychain? | **Yes to both.** A one-off test job read a repo file and ran `bee me` with exit code 0, with no permission prompt. Its `PATH` was only `/usr/bin:/bin:/usr/sbin:/sbin`, so every program must be given by full path. |
| Do utterance ids on the stream match the ids in Bee's stored transcript? | **No.** Stream ids match the *realtime* transcription inside the `COMPLETED` event (32 of 32). `bee conversations transcript` returns only the *final* transcription, whose ids are all different (0 of 32 in common). So lines recovered after a disconnect can't be matched to saved lines by id; the listener compares time and text instead. |
| Does `bee conversations get` include the conversation's uuid? | **No**, only the numeric id. The uuid-to-id link only ever arrives on the stream, so the store lets a conversation be known by either id and merges the two when it learns they're the same. |

## What building Milestone 1 added (2026-10-09)

Found while building and reviewing the listener, each checked read-only against the real tools:

- **`bee todos list --limit 20`** returns `{ todos: [{ id, text, completed, created_at, alarm_at, corrections }], next_cursor, timezone }`, newest first, completed ones included. We use it to find a to-do whose creation reply was lost.
- **Real Bee error texts** the Bee package now relies on: `Unable to connect. Is the computer able to access the url?` (offline or wrong host), `The socket connection was closed unexpectedly...` (dropped connection), `Request failed with status 503` (server error). Only the first, and a 4xx status, prove that nothing happened on Bee's side.
- **`bee conversations transcript --since`** means "spoken at or after", and is applied after the whole transcript has been downloaded, so it saves no network time. Stored lines carry `spoken_at` as epoch milliseconds; stream lines carry it as an ISO string.
- **One stream asking for five event types** connects in about 260 ms and closes cleanly. Whether all five types really arrive on it while someone is talking is checked by the first real quiet-mode run.
- **`kiro-cli whoami`** exits 0 and prints the sign-in method and the account's email address when signed in. We use the exit code and never keep the output.
- **First real run of the listener, in quiet mode** (no one was speaking): Bee login checked, one stream with five event types opened and connected in about a second, the first catch-up call saved a starting cursor, and the detector's set-up passed (Kiro signed in, both sharing settings switched off in its own settings folder). The same thing then worked as a launchd background job, including `kiro-cli` under launchd's bare environment. A hand-run listener and the background job were briefly started together: the second one refused to start, and took over within 20 seconds of the first one stopping. A stop signal ended the listener in under a second.
- **Detector on the golden set** (66 synthetic transcripts, `claude-haiku-4.5`, one run after the last prompt change): 24 of 24 ideas asked, 0 of 42 non-ideas asked, precision 1.00, recall 1.00, 63 seconds, about 1.1 Kiro credits. Earlier runs on 64 transcripts scored 0.88, 0.88 and 0.96 precision with recall 1.00 each time, so expect some run-to-run variation. In the last run 13 replies had a word-for-word quote longer than the 25-word limit; we cut those in code.

## First real end-to-end run of the listening half (2026-10-10)

The background listener, installed the night before in quiet mode, had run for 10 hours (43 stream reopenings, no errors). Then, with the wearer and the watch:

| Time (local) | What happened |
|---|---|
| 10:09 to 10:13 | An ordinary conversation: 26 lines, 154 words, saved as they arrived |
| 10:13:04 | Detector ran on it (2 quiet minutes after its last line): **not an idea**, 8.4 s |
| 10:13 | Asking switched on (`overnight resume`). An app idea was then said out loud in a new recording: 5 lines, 49 words. Bee added it to the same conversation |
| 10:15:50 | Detector ran on **only the 5 new lines**: an idea, confidence 0.92, buildable, 6.1 s |
| 10:15:51 | Bee to-do created (`💡 Build tonight? <title>`), alarm two minutes out |
| about 10:18 | The alarm went off: **the wrist buzzed** (the wearer's report) |
| 10:21:21 | Ticked in the Bee app on the phone; the next 10-second poll saw it and the idea became `approved` |
| after | `overnight queue --approved --json` lists it for the builder |

What this settles:

- **One stream asking for several event types works.** Utterances and conversation events (with both the uuid and the numeric id, through to `COMPLETED`) all arrived on the single stream.
- **Stream latency over 31 real lines:** 1.5 s minimum, 8.4 s median, 18.5 s maximum.
- **"Lines since the last run" works.** The idea was spoken inside a conversation the detector had already judged, and was still picked up by itself.
- Not yet tried: ticking from the watch instead of the phone.
- Not yet tried with real speech: rejecting by deleting the to-do, and letting an ask expire. Both paths are covered by tests, and deletion was seen for real in spike 3.

## Milestone 2 experiments (2026-10-10)

Three experiments before building the build-and-deliver half. Probes printed only byte counts and yes/no.

### A. Kiro Crew building unattended, at its `strict` sandbox level

- **It builds.** An agent job with `--approval-mode auto`, started with `kirocrew cron trigger`, built a small app from a one-page brief and a skill file in 2 minutes 22 seconds with nobody approving anything. Our own `npm ci`, `npm run build` and the app's Playwright test passed afterwards. Cost: 3.6 Kiro credits (plain `kiro-cli` built a similar app for 0.4).
- **`strict` does not protect what matters here.** From inside an agent job at `strict`:

  | Probe | Result |
  |---|---|
  | GitHub login in the Keychain (`security find-generic-password`) | **readable** (75 bytes) |
  | Bee, as the logged-in user | **works** (101 bytes) |
  | The transcript database | **readable** (86,016 bytes) |
  | Network | open |
  | Writing in the home folder and `/tmp` | allowed |
  | `gh auth token` | 0 bytes: `strict` hides `~/.config/gh`, which breaks the `gh` program but not the Keychain entry behind it |

- Crew's zero-credit command jobs don't get `strict` at all (they always run at a fixed level), `kirocrew doctor` doesn't show which level is active, and the hidden-folder list can't be extended.
- Crew's "success" still only means the session ended. The marker file the skill writes, checked by its modification time, plus our own rebuild, decide whether a build worked.
- An agent job runs in a folder Crew invents (`~/workplace/kirocrew-workspace/...`); the job message and the skill must name the real workspace by full path.

### B. The whole Kiro Crew gateway inside our own sandbox

- macOS sandboxes can't be stacked. Started inside ours, Crew refuses to run any job ("already inside a macOS Seatbelt sandbox that KiroCrew did not create") until `agent.sandbox_allow_unsandboxed_exec` is `true` and the gateway is restarted. That turns Crew's own sandbox off.
- With that set (in a throwaway Crew home; the real install was not touched), inside our profile, from both a command job and an agent job: **Keychain entry 0 bytes, Bee refused, transcript database unreadable**, `gh` logged out, logs and detector folders hidden. Kiro still signed in with the Keychain service cut off, and an agent job built the same app in 2 minutes 42 seconds (about 4.2 credits).
- The limits: it is a fence around named files and the Keychain, not a sealed box. The network is open, a job can write elsewhere in the home folder, and with Crew's sandbox off a job can read Crew's own private files. The `overnight` command is blind inside it (the database is hidden), so our own code must hand the job its brief and record the result.

### C. Running agent-written code inside our own sandbox at verify time

- `npm ci`, `npm run build`, a local static server and a Playwright smoke test all run inside a tight `sandbox-exec` profile, in about 2.8 seconds, the same as without it.
- The tight profile: no reading in the home folder except the folders the run needs, no writing except the run folder, no macOS system services at all (which removes the Keychain, the clipboard and app launching in one rule), no network except two local ports. 62 probes found nothing private reachable.
- The looser "allow everything, then deny a list" style is escapable: `open -a Calculator` started an app outside the sandbox. Denying app launching closes that.
- `sandbox-exec` can't filter the network by host name, so `npm ci` runs offline against the npm cache, with a small local proxy that reaches only the npm registry as the fallback.
- Chromium's own sandbox can't start inside ours; Playwright's default launch already turns it off. Only the headless shell works under the tight profile. Full Chromium crashed and, once, macOS reopened it as a visible window: never use it in deliver.
- Outside the sandbox, the publish step must refuse symbolic links in `dist/` (a planted link would otherwise copy an outside file into the published site).

## Milestone 2 fix rounds (2026-10-10)

Milestone 2 was built, reviewed, fixed, reviewed again as a whole, and fixed once more, all on Oct 10. This section records what those rounds learned about the tools and about the macOS sandbox, and what was run for real. Everything here used scratch data folders and, where a Kiro Crew gateway was needed, a throwaway Kiro Crew home on another port. Probes printed only counts and yes/no.

**What has still never happened** (and is not claimed anywhere below): a night job running under launchd, the Kiro Crew gateway starting from its installed job, a real push to GitHub Pages from the deliver step, a real morning Bee to-do or fact, the rehearsal, and the first real night. All pending.

### Spike 9: Kiro CLI reads its prompt from standard input. Passed (2026-10-10)

**Question:** the detector used to hand Kiro its prompt, with what was just said in it, as a command-line argument. Any program of the same user can read another program's arguments. Can the prompt go in another way?

**Answer:** yes. With `--no-interactive` and no prompt argument, Kiro reads everything piped to it as one prompt.

`spikes/09-kiro-stdin-prompt.ts` sends an invented prompt with a random code word in it. While Kiro runs, it reads the arguments and environment of every process on the Mac every 50 milliseconds and looks for the code word.

| Try | Result |
|---|---|
| Prompt piped in, 313 bytes on 6 lines, no prompt argument (run twice) | Exit 0 in about 2.5 s, right answer. Code word in no process's arguments and no environment (about 30 looks each) |
| Long prompt piped in, 13,819 bytes, about 150 lines | Exit 0 in 2.5 s, right answer. Kiro's own record says the prompt was 13,819 long, so nothing was cut |
| Accents, Japanese and emoji piped in | Exit 0, the accented word came back exactly. Kiro recorded 423, which is the size in bytes (410 characters) |
| The old way, prompt as an argument (the control) | Code word seen in the arguments of **two** processes, `kiro-cli` and `kiro-cli-chat` |
| Nothing piped in, no argument | Exit 1 in 0.2 s, no call to the model, no saved chat |

- `kiro-cli chat --help` (2.29.0) does not mention standard input. Kiro's headless docs page does.
- No tool ran in any of the five chats that reached the model. They cost 0.035 Kiro credits in all.
- Kiro's saved chat file (`<KIRO_HOME>/sessions/cli/*.json`) records the prompt's length in bytes, how many tools ran, and the credits each turn cost. That is a cheap way to measure cost and to confirm "no tools ran".
- During a no-tools chat Kiro starts a `kiro-cli-chat acp` helper and short-lived `security` (Keychain) helpers. None carried prompt text.

**What changed because of it:** the detector now sends its prompt on standard input. Its chats start with exactly `chat --no-interactive --agent overnight-detector --model <model>`, and the runner refuses any argument longer than 200 characters.

Checked afterwards, with the final code and a scratch data folder:

| Check | Result |
|---|---|
| One detection on a synthetic transcript, with the process list read 74 times meanwhile | An idea, first try, 4.3 s. The text in no process's arguments or environment (92 search strings). Kiro recorded a prompt of 6,336 bytes, equal to what was sent; 0 tools; 0.016 credits |
| The golden set (66 synthetic transcripts) | 24 of 24 ideas asked, 0 of 42 non-ideas asked, precision 1.00, recall 1.00. One transcript needed a second try. Median 3.3 s each (3.1 s the old way). 67 calls, 0 tools, 0.93 credits |

Not tried: a signed-out Kiro with a piped prompt, and the new path from inside a launchd job. The listener that is running was started before the change, so it uses the old way until it is restarted (pending).

### What the macOS sandbox does and does not do

Found while writing and attacking our three `sandbox-exec` profiles on macOS 26. Each line was tried for real unless it says otherwise.

**Signals and other programs**

| Fact | What we do about it |
|---|---|
| `(deny signal (target others))` loads without complaint and stops nothing. | Use `(deny signal)` followed by `(allow signal (target same-sandbox))`. |
| "Same sandbox" means one start of `sandbox-exec`. A second start with the same profile and folders can't signal, see or read a program in the first. | A program left over from one step can't touch the next step's programs. |
| The exact name does nothing: `(deny sysctl-read (sysctl-name "kern.procargs2"))` let a program read any other program's command line by its process number. `"kern.procargs2.*"` does nothing either. The prefix forms work (`sysctl-name-prefix "kern.procargs2."`, or the prefix `"kern.procargs"`), which suggests the process number follows the name. Refusing only `procargs2` leaves the older `kern.procargs` readable. | Use the prefix `"kern.procargs"`, in all three profiles. Every rule of this kind gets a real test with a decoy process. |
| The refusal only bites for programs outside the sandbox. A program can still read the command lines of itself, its parent and its children. Measured, not explained. | Good: build tools need that. |
| The list of running programs is a separate hole. `(deny process-info*)` stops one way of listing them, but `sysctl kern.proc.all` still returned every program on the Mac (over 900, with number and name). The prefix `"kern.proc."` closes it, and npm, tsc, Vite, Playwright and headless Chromium all still work. | In `deliver.sb`. Not yet in the two builder profiles, where the list is still readable (over 900 entries, counted again on Oct 10 with the final profiles; command lines stayed refused). Untested there: Kiro Crew may need the list to manage its jobs. |
| `pgrep` gets command lines from a system service, `com.apple.sysmond`. Allowing only that service made `pgrep -fl` print an outside program's command line in spite of the other rules. | Refuse that service in the builder profiles. `deliver.sb` allows no system service at all. |
| Programs that run with extra rights (`ps`, `crontab`) can't start inside any sandbox: exit code 71. From Node it shows as "not permitted". | `crontab` is not a way out, and the build skill tells the agent that `ps` does not work. |

**Ways out we had not thought of**

| Fact | What we do about it |
|---|---|
| `launchctl`: from inside a sandbox macOS itself refuses to stop, kill, restart or remove a background job. It does accept `disable` (tried on a throwaway job), which would keep the listener from starting after the next login. | The builder profiles refuse to run `/bin/launchctl`. A copy of it is killed by macOS at start. Hand-written messages to the job system can't be blocked by a profile; in `deliver.sb` `launchctl` runs but is answered "Operation not permitted". |
| `defaults write` goes round the file rules. It asks the preferences service to write the file for it. | Cut that service in the builder profiles. |
| A file that may not be read can still be run, unless running is refused too. The `gh` and Bee programs started from inside an early profile. | Refuse running as well as reading. |
| A program can replace the very folder it is allowed to write: move it aside and put a link to somewhere else in its place. Our own code, outside the sandbox, would then follow the link. | In the deliver step the folder above is read-only while a step runs, and is renamed away afterwards. In the builder profiles a job may write what is inside a folder, not the folder's own name. |
| A plain "allow everything, then refuse a list" profile is escapable: `open -a Calculator` started an app outside the sandbox (experiment C). | Refuse app launching. |
| Node 24 stops at once when it may not read the Mac's name (`kern.hostname`), which takes npm and Playwright with it. | The name stays readable. The deliver step searches the built app for it before publishing. |

**Read rules and temporary folders (the last round)**

- Reading can be refused by default in the home folder and a real build still works. Both builders built a real app that way.
- Every folder on the way to an allowed folder must be allowed to be "looked at" (its name and kind), though not listed. Node, Python and the shell all look at each folder on the way before they open or run a file.
- A link in a `PATH` folder must itself be readable, or the shell does not find the program.
- `touch` and npm look at a file before they make it, so a folder that is write-only also needs "look at".
- A script can't run unless it can be read, but a compiled program can. So tests of "this cannot be run" need a real program.
- macOS can't allow opening a folder without allowing its names to be listed. That is why a Kiro Crew job can list the names in the home folder (F-042).
- Rules follow names, not files. A rule for a folder "and everything in it" also covers the folder's own name, so a job that may write it can move the whole folder away.
- The sandbox compares real paths. A rule written with a symbolic link in it matches nothing, and `sandbox-exec` can't start a program through one. Every path we hand it has its links followed first.
- Path rules matched `Tmp…` against `tmp…` on this disk: capitals don't count.
- A missing `-D` value makes `sandbox-exec` refuse to start anything, which is the safe way to fail.
- A copy of one of Apple's own programs (`/bin/echo`, for one) is killed by macOS when it starts, even outside a sandbox.
- Builds work with every shared temporary folder closed (`/private/tmp`, `/private/var/tmp`, `/private/var/folders`) and one temporary folder of their own. Playwright's headless browser ran with `~/Library/Preferences` closed too.
- A shell started in a folder it may not look at still runs, and prints "shell-init: error retrieving current directory". `kirocrew` does not survive that (F-043).
- Because the builder profiles close all of `/private/tmp`, a helper script kept there can't be started from inside them. Test stand-ins have to live in the build's own workspace.
- `ps -axww -o pid=,pgid=,command=` shows every process's full arguments to any user. `ps -axEww` adds the environment, but only for the user's own programs.

### Kiro Crew: what the fix rounds found

The surprises are in the friction log (F-039 to F-044, and F-050). The plain facts we now build on:

- A run is ended by asking the gateway's local web address (`POST /api/crons/<id>/cancel`), then the job is removed. Measured: 19 milliseconds to cancel a command job, clean in under 0.7 seconds; on an agent job 0.7 seconds, with both programs it had started gone.
- `GET /api/health` on the gateway's port answers whether it is running.
- Kiro Crew gives each agent a temporary folder of its own (`<crew home>/scratch/runtime-<id>`). Command jobs inherit the gateway's temporary folder and `PATH`.
- Command jobs start in whatever folder the gateway started in.
- Kiro Crew makes its own folder private (`chmod 700`) at every start, and logs an error if it may not.
- The folders a job may write must exist before the gateway starts: the sandbox lets a job fill them, not create them.
- A one-line agent job costs 0.4 to 0.5 Kiro credits. A build costs 2.6 to 4.2.

### What was run for real

**Builds.** Each from an invented brief, through our own builder code, with a throwaway Kiro Crew home on port 5478 and a scratch data folder. The home folder, Kiro's sign-in, node, npm and the Playwright browser were the real ones.

| Build | Sandbox | Result | Time | Kiro credits |
|---|---|---|---|---|
| Kiro Crew agent (first fix round) | The tightened gateway profile | Built | 140 s | about 3.1 |
| Kiro Crew agent | The gateway profile one step before final (it still opened all of `~/.local/bin`) | Built | 119 s | 2.56 |
| Kiro Crew agent | **The final gateway profile** | Built. `npm install`, the build and the Playwright test (2 of 2) passed inside it; the job was removed; no write was refused | 224 s | 2.87 |
| Kiro CLI | **The final Kiro CLI profile**, with the real `~/.kiro` | Built. `npm install`, the build and the Playwright test passed inside it | 99 s | not itemised |

With the two builds from the experiments above (142 s for 3.6 credits, 162 s for about 4.2), that makes five Kiro Crew agent builds: 2 to 4 minutes and 2.6 to 4.2 credits each.

Credits for the last round: Kiro's own `/usage` line went from 20.81 to 29.10. That 8.29 is for the whole account and can include other work going on at the same time. Kiro Crew's own records show 6.33 for the builder's jobs (the two builds, and two one-line agent jobs at 0.51 and 0.40).

**The sandbox check.** Against the throwaway gateway inside the final profile it passed in 6.9 seconds, every count 0. Against a gateway inside a deliberately loosened copy it failed, and named the three folders and the command lines that had been opened; the other eight counts stayed 0. Each of the check's lines also fails, in the tests, on a copy of the profile loosened in exactly that way.

**The morning's checks**, inside the final `deliver.sb`, on an app a Kiro agent built:

| Run | Result |
|---|---|
| A good app, npm cache warm | Passed in 5.1 to 5.5 s (install 0.5, build 1.5, our test 2.4, the app's test 0.7) |
| A build that tries to read another program's command line, the list of programs, `pgrep`, `ps`, and to signal it | All refused. Its own child is still readable and stoppable |
| The same app under a copy with the old rule | The other program's command line was found: it would have reached the published site |
| A build that leaves a program running | Refused, nothing left running |
| A build that tries to swap its own folder for a link | All four attempts blocked |
| An app that ships a forged copy of our test, on a page that calls out | Refused, on the real counts |
| A build that never ends, 4 s limit | Stopped at 4.6 s, nothing left running |
| A stop signal 2.5 s into a run | Answered about 220 ms later, nothing left running |
| Network from inside | Our proxy's port connects. Another local port, an outside address and listening elsewhere are all refused |

An install with an empty npm cache, through the registry-only proxy, worked in the first fix round (15 connections let through, 0 refused, 10.9 s). It was not run again under the final profile, because that round was not allowed to download anything.

**A whole morning** with the real verifier and a real database, and stand-ins for the publisher and for Bee: a stopped run left both ideas `built` and told nobody; the next run delivered both; an idea whose page was "not seen live" was recorded as published with its note; a real failure was told; a stopped build was not told until its second start had also ended badly, and then exactly once.

**The command line**, each command as its own process with only what a background job gets (`PATH` and `HOME`):
- `status` and `preflight` on a scratch data folder. Preflight ticked Bee, Kiro, the GitHub login, the apps repo and the browser, and put a cross (with the fix, naming the job) on the gateway, the Kiro Crew setting, the skill and the jobs, as expected with nothing installed.
- `rehearse`: no folder given, the real folder, and a folder inside it are all refused. `rehearse run --no-publish` ran twice, to "delivered", with stand-ins for the two builders and the real verifier.
- A build while paused recorded a 3-hour-old cut-off build as failed, and `status` showed it waiting for its second try.
- The installer, with a made-up home folder and stand-ins for `launchctl` and `kirocrew`: all four jobs' files come out valid, and the gateway's command loads in the real sandbox.
- Before the last round, an end-to-end harness passed 101 of 102 checks. The one failure (a cut-off build left "building" while paused) was fixed in the last round.

**Tests.** 1,467 pass (76 files), with typecheck and lint clean, on Oct 10 after the last round.

## The rehearsal and switching on (2026-10-10, evening)

The first time every part ran for real together: the real Kiro Crew install (its real home, its usual port) inside our sandbox, the real verifier, the real publisher. Only Bee was a stand-in, and the data folder was a scratch one (`~/.overnight-rehearsal`), so nothing could reach the wearer or the real database.

| Run | How it was started | Result |
|---|---|---|
| "Practice Dice Roller", Kiro Crew, published | `overnight rehearse run` from a shell, gateway started by hand inside the profile with the installer's own words | Built in 139 s for 3.09 credits. Checked in the deliver sandbox in 5.2 s (3 files, 5,602 bytes). Pushed as "Overnight" with the noreply address. Live on Pages after 21 s. Delivered. Kiro Crew's job list was empty afterwards |
| "Practice Coin Flip", Kiro CLI, not published | the same, with `BUILD_BACKEND=kiro-cli` and `--no-publish` | Built inside `kiro-cli-build.sb`, checked, delivered (stand-in publisher) |
| "Practice Tip Splitter", Kiro CLI, not published | **as a one-off launchd job**, with the same program, folder and environment the night jobs get | Built in 123 s, checked in 5.3 s, delivered, exit code 0 |
| `overnight preflight` on the real data folder | from a shell, and **as a one-off launchd job** | Every line ticked except "build and deliver jobs installed", the sandbox check included |

The practice app is public at `https://hturcotte1.github.io/overnight-apps/practice-dice-roller/`.

**Two things only the real set-up could show.**

1. **Kiro's sign-in lasts an hour, and a sandboxed build can't renew it** (F-051). The first gateway started inside the sandbox logged "You are not logged in": the last renewal was over an hour old, and renewing needs the Keychain, which the sandbox closes on purpose. A renewal made outside the sandbox is seen inside it straight away. So the night flow now asks Kiro "who am I" outside the sandbox before every try on a builder (`packages/builder/src/kiro-signin.ts`). If the sign-in has under ten minutes left, it waits for it to run out and asks again, because Kiro has no way to renew early. Measured: the step takes 0.7 s and read "52 minutes left" and later "47 minutes left" correctly.
2. **A launchd job whose program is `sandbox-exec` can't read a file under `~/Documents`.** The first install of the gateway job died every 30 seconds with "sandbox-exec: .../crew-gateway.sb: Operation not permitted". This is macOS's privacy protection of the Documents folder, and the dry runs could not show it. The same file is read without trouble when `node` is the job's program and starts `sandbox-exec` itself, which is how the build and deliver jobs use the profiles (shown by the two launchd runs above). The installer now gives the gateway job its own copy of the profile, `<data>/sandbox/crew-gateway.sb`, made again by every `install crew`.

**Not shown yet:** a gateway that has sat idle for more than an hour and is then asked to start an agent. The sign-in it started with has run out by then. Our renewal makes a fresh one available, but whether the long-running gateway picks it up is not known. If it does not, the Kiro CLI builder takes over for that build.

**What the independent check found** (about three and a half hours of tests on Oct 10; it was cut off before it could report, and its results were recovered from its working notes). It re-ran the earlier review's reproductions against the final profiles and attacked them from inside a throwaway gateway. Everything the earlier review listed as open is closed or accepted. What it found beyond that, none of it blocking a night:

| Finding | Status |
|---|---|
| The sign-in may not renew inside the sandbox | Confirmed and fixed the same evening (above) |
| `install crew` did not make three of the folders the gateway needs | Fixed: it now makes all seven |
| The Kiro CLI builder emptied the temporary folder a running gateway also uses | Fixed: it has its own corner, `tmp/build/kiro-cli/` |
| A build job can read the list of running programs (over 900 entries: names and numbers, no command lines) and the list of running apps | Left for Milestone 3: the rule that closes it is untested with a Kiro Crew agent |
| A build job can connect to another program's local socket and to any local port (only the ssh agent's socket is refused) | Left for Milestone 3. The deliver sandbox refuses both |
| A Kiro Crew job can read and change Kiro Crew's own settings and local secret, and read, write and rename another idea's workspace | Comes with running the whole gateway inside one fence. The nightly check reads Kiro Crew's two settings before every build; moving a workspace away once it is built is Milestone 3 |
| A job can make a folder named `kirocrew...` in Kiro's agents folder and put any file in it | Left for Milestone 3 |
| `rehearse` can be pointed at the real data folder through an unusual spelling of its path (`/System/Volumes/Data/...` or `/.vol/...`) | Left for Milestone 3: compare folders by identity, not by text. Until then, type the scratch folder plainly |
| A brand-new Kiro home cannot start an agent inside the sandbox (F-052) | Not this Mac. An installer check is Milestone 3 |
| `git` and `mktemp -t` do not work inside the build sandboxes | No build has needed them. Noted here |
| When a page was pushed but not seen live, the morning's printed line does not say so | The note is on the idea, in the report and in the log. One more printed line is Milestone 3 |

## The first real night (2026-10-10 to 10-11)

The whole loop for real, with nobody at the Mac: an idea spoken near the watch on the morning of Oct 10, approved on the wrist, built overnight and delivered the next morning.

| Step | When (Boise time) | What happened |
|---|---|---|
| Heard and approved | Oct 10, 10:15 to 10:21 am | See "First real end-to-end run of the listening half" above |
| Build job starts | Oct 11, 2:00:01 am | Started by launchd, an hour late (below) |
| Kiro's sign-in | 2:00:02 | Renewed outside the sandbox: 43 minutes left |
| Sandbox check | 2:00:09 | Passed in 7.2 s, from a gateway that had been running, idle, for three hours |
| Kiro Crew build | 2:00:11 to 2:02:41 | Built in 160 s for 4.59 credits. Kiro Crew's job list was empty afterwards |
| Deliver job starts | 7:30:01 am | Started by launchd, an hour late |
| Checks in the sandbox | 7:30:08 | Passed in 6.6 s: 3 files, 6,851 bytes, nothing fetched from outside, no errors, fits a phone |
| Publish | 7:30:11 to 7:30:37 | Pushed as "Overnight" with the noreply address; live on Pages after 26 s |
| Bee | 7:30:37 | The real to-do with the link was created, then the Bee fact. Bee still lists the to-do as open hours later |

Both jobs ended with exit code 0. The app is at `https://hturcotte1.github.io/overnight-apps/plant-watering-tracker/`.

**What this settled.**
- A gateway that has been idle for more than an hour can still start an agent, as long as the sign-in is renewed outside the sandbox first. The open question from the rehearsal is closed.
- The build and deliver jobs run by themselves from launchd, with the Mac's lid closed and on mains power (it was plugged in at 12:49 am, having been on battery with the lid closed before that).
- The real publisher, the real Bee to-do and the real Bee fact all work from the deliver job.

**What was off: an hour late.** Both jobs ran exactly one hour after their set times, to the second (2:00:01 and 7:30:01). macOS's own log shows why. After the build it wrote "Rescheduling StartCalendarInterval: com.overnight.build: Monday, October 12, 2026 at 2:00:00 AM Mountain Daylight Time" for a job whose settings say hour 1. The part of macOS that keeps the calendar for background jobs had been running since the Mac last restarted (Oct 6), and the Mac's time zone was changed the day after (Oct 7). It was still counting in the old zone, one hour behind. Because the morning run came after `DELIVER_TIME`, the to-do's alarm was set two minutes out (about 7:32) instead of for 7:00.
- Fix for now: restart the Mac once, so that part of macOS starts again in the right zone. Done on Oct 11 at 11:26 am: macOS's log then showed "Registered StartCalendarInterval: com.overnight.build: Monday, October 12, 2026 at 1:00:00 AM Mountain Daylight Time", and 6:30:00 AM for deliver. The listener, the gateway and both night jobs came back by themselves at login, and `overnight preflight` said "Ready".
- Fix for good (Milestone 3): have the jobs wake often and let Overnight's own code, which knows its time zone, decide whether it is time. That also covers a Mac that was asleep at 1:00.

**Also learned.** The listener's keep-awake (`caffeinate -s`) only works on mains power. On battery the Mac sleeps after a minute, and with the lid closed it sleeps whatever is asked. That night a second keep-awake was started by hand for battery; building that in is Milestone 3 too.

**Confirmed by the wearer:** the watch buzzed at 7:32 am, and the to-do said the app was built.

## Decisions that came out of the spikes

1. **How the nightly Kiro Crew job is allowed to work** (finding 2). **Decided on Oct 9:** build jobs get `--approval-mode auto`, Crew's documented setting for unattended jobs. (The plan to also raise Crew's sandbox to `strict` was overtaken by decision 2.) (The alternative, leaving every Crew setting alone and having Crew only start our own `kiro-cli` builder, was the weaker Kiro Crew story and no safer.)
2. **Keeping logins away from the builder** (finding 3). **Decided on Oct 10**, after experiments A and B above: the whole Kiro Crew gateway runs inside Overnight's own sandbox, Crew's own sandbox setting is switched off because the two can't be stacked, and a probe before each night's builds must show the GitHub login, the Bee login and the transcripts are unreachable or nothing is built. The build agent is only ever given `brief.md`, with no quote and no facts.
3. **Keeping the Mac awake at 1:00 a.m.** It's a MacBook that sleeps after a minute of idle. **Agreed on Oct 9:** Henry keeps it plugged in with the lid open on build nights, and the background jobs hold it awake while they run.
4. **Kiro content sharing. Decided on Oct 9: switched off.** By default Kiro may use prompts from individual accounts to improve its service, and the detector will send transcript text. Both settings (`codeWhisperer.shareCodeWhispererContentWithAWS` and `telemetry.enabled`) are now `false` on this Mac, in the default settings folder and in the detector's own `KIRO_HOME`. Any new `KIRO_HOME` we create needs the same two settings before real text goes through it.

Four more came out of the Milestone 2 fix rounds, all decided on Oct 10 while planning the last round:

5. **A stopped build gets one more try.** A build that was stopped or cut off (not one that failed) is built once more by the next nightly run. The wearer is told "couldn't finish" only when that second start also ends badly. The rule is in one place, `packages/core/src/build-retry.ts`.
6. **Pushed but not seen live still counts as published.** If the push to GitHub went through but the page was not seen serving the new app within the 10-minute wait, the idea is recorded as published and announced as usual, with a note saying it was not confirmed. (The page is not looked at again later; that is a known gap.)
7. **The build sandboxes refuse reading by default.** Not only writing: nothing in the home folder can be read or run except a short list, and build jobs get a temporary folder of their own. One exception is built in for Kiro Crew, because it will not start an agent otherwise: a job can list the names directly inside the home folder (F-042). Whether to keep that, or to make Kiro CLI the first builder instead, is still open.
8. **Rehearsals are a real command.** `overnight rehearse` tries the night and the morning on an invented idea. It can never reach Bee, and it refuses the real data folder.
