# Spikes (Milestone 0)

One small script per outside piece, run for real before we build on it. This file records what each one proved. No Bee data appears here: only field names, timings and yes/no answers.

Later sections record what building Milestones 1, 2 and 3 added. Milestones 1 and 2 were checked against the real tools. Milestone 3 was proved on the real tools on Oct 12 and switched on for the live system on Oct 20: its section says which steps ran for real, and ends with what is still open.

Last updated: 2026-10-20

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
| 10 | Does macOS really wake the two night jobs every minute, and does Overnight's own clock then start the build once, at its minute, and catch up after a sleep? | `spikes/10-night-clock.ts` | `run` **passed** (2026-10-12): under real launchd each job looked at the clock when loaded and every 60 seconds, and the build started once. `sitting`, the Mac asleep across the build's time, is **pending** |
| 11 | Do the two builder sandbox profiles, with Milestone 3's new rules, still let Kiro Crew and Kiro CLI do their work? | `spikes/11-hardening-proof.ts` | **Passed** (2026-10-12, `p1` and `p2`): a Kiro Crew gateway, a Kiro Crew agent job and a Kiro CLI chat all did their work under the new rules |
| 12 | Can a second program read the database beside the listener without ever making it wait? | `spikes/12-sqlite-read-only.ts` | **Passed** (2026-10-11). The rule that came out of it: never leave a read open |

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

Kiro: `kiro-cli` is signed in with GitHub on the **Kiro Pro** plan (1,000 credits a month). All of today's Kiro tests together, including a second run of each script, used about 1.1 credits. Kiro Crew settings changed from their defaults: `stt.enabled false` (voice typing, unused), `timezone America/Boise`, `auto_update false`. On Oct 9 the sandbox and approval settings were untouched. Since Milestone 2 experiment A (Oct 10), `agent.sandbox` on the real install is `strict` (it was `auto`). Until the evening of Oct 10, `agent.sandbox_allow_unsandboxed_exec` was not switched on there, and every test that needed it used a throwaway Kiro Crew home. It has been on since that evening: the rehearsal ran the real install inside our sandbox, which Kiro Crew refuses to do without it, and `overnight preflight` ticked the setting then and again after the restart on Oct 11 (see "The rehearsal and switching on"). Kiro CLI settings changed: `codeWhisperer.shareCodeWhispererContentWithAWS false` and `telemetry.enabled false`, in the default settings folder and in the detector's own `KIRO_HOME` (Henry's decision, Oct 9).

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

**What had still never happened when this section was written** (and is not claimed anywhere in it): a night job running under launchd, the Kiro Crew gateway starting from its installed job, a real push to GitHub Pages from the deliver step, a real morning Bee to-do or fact, the rehearsal, and the first real night. All of those happened later on Oct 10 and on Oct 11; they are in "The rehearsal and switching on" and "The first real night" below.

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

Not tried: a signed-out Kiro with a piped prompt, and the new path from inside a launchd job. The listener that was running on Oct 10 had been started before the change. The Mac's restart on Oct 11 started it again, so the listener running since then was started after it. (That follows from the restart; it was not read back from the listener's log.)

### What the macOS sandbox does and does not do

Found while writing and attacking our three `sandbox-exec` profiles on macOS 26. Each line was tried for real unless it says otherwise.

**Signals and other programs**

| Fact | What we do about it |
|---|---|
| `(deny signal (target others))` loads without complaint and stops nothing. | Use `(deny signal)` followed by `(allow signal (target same-sandbox))`. |
| "Same sandbox" means one start of `sandbox-exec`. A second start with the same profile and folders can't signal, see or read a program in the first. | A program left over from one step can't touch the next step's programs. |
| The exact name does nothing: `(deny sysctl-read (sysctl-name "kern.procargs2"))` let a program read any other program's command line by its process number. `"kern.procargs2.*"` does nothing either. The prefix forms work (`sysctl-name-prefix "kern.procargs2."`, or the prefix `"kern.procargs"`), which suggests the process number follows the name. Refusing only `procargs2` leaves the older `kern.procargs` readable. | Use the prefix `"kern.procargs"`, in all three profiles. Every rule of this kind gets a real test with a decoy process. |
| The refusal only bites for programs outside the sandbox. A program can still read the command lines of itself, its parent and its children. Measured, not explained. | Good: build tools need that. |
| The list of running programs is a separate hole. `(deny process-info*)` stops one way of listing them, but `sysctl kern.proc.all` still returned every program on the Mac (over 900, with number and name). The prefix `"kern.proc."` closes it, and npm, tsc, Vite, Playwright and headless Chromium all still work. | In `deliver.sb`. On Oct 10 not yet in the two builder profiles, where the list was still readable (over 900 entries, counted again that day with the final profiles; command lines stayed refused). Milestone 3 added the rule to the Kiro CLI profile and found why the gateway profile cannot have it (see "Milestone 3" below). |
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

### Spike 12: reading the database read-only, beside the listener. Passed (2026-10-11)

Done for Milestone 3, before the dashboard was built on it.

**Question:** the dashboard is a page that only reads. Can a second program read `overnight.db` while the listener writes to it, without ever making the listener wait? And can it tell whether the listener, a build or a deliver is running without touching their lock files?

**Answer:** yes to both, with one rule (**never leave a read open**) and one honest footnote (SQLite's two side files).

`spikes/12-sqlite-read-only.ts` uses the real `Store` as the writer and the cli's own `takeLock` as the lock holder. Every line it writes is invented. It works in a new temporary folder, removes it at the end, and never opens the data folder. It ran five times (better-sqlite3 13.0.3, SQLite 3.53.4, Node 24.21.0); where the runs differed, the range is given. It costs no Kiro credits.

A look is: `new Database(file, { readonly: true, fileMustExist: true, timeout: 250 })`, then `PRAGMA query_only = ON`, a few SELECTs inside one short transaction, close.

| Try | Result |
|---|---|
| Read-only open of a file that is not there | `SQLITE_CANTOPEN`. Nothing is created |
| Read-only open inside a folder that is not there | better-sqlite3 throws a `TypeError` before SQLite is asked |
| An empty (zero-byte) file | Opens. `user_version` is 0, and any SELECT fails with `SQLITE_ERROR`, "no such table" |
| A write through the read-only connection | `SQLITE_READONLY`, also with `query_only` switched back off |
| The writer alone, in another process: a line every 5 ms for 3 s | 509 to 520 lines. Slowest write 2.7 to 5.2 ms, average 0.14 to 0.24 ms |
| The same writer beside a reader taking 1,367 to 2,088 looks | 515 to 529 lines. Slowest write 1.4 to 3.1 ms, average 0.07 to 0.21 ms. No error on either side. Slowest look 1.3 to 3.0 ms. The count of lines never went backwards |
| One line written, then a look | The line is in the very next look |
| A look while another process holds a write open for 1.5 s | Answered in under half a millisecond |
| The writer killed mid-way (3.4 to 4.0 MB left in the write-ahead file) | The next look reads. SQLite's `integrity_check` says ok. The next `Store` to open and close leaves only `overnight.db` |
| 3,000 lines, with a short look after every tenth | The write-ahead file stays at about 4 MB, its usual size. Slowest write 0.8 to 1.6 ms |
| **3,000 lines beside a read that is left open** | Writes are still not slowed (slowest 0.3 to 2.6 ms). But the write-ahead file grew to **86 to 90 MB**: about 21,000 pages, none of which a checkpoint could move into the database. The held read went on counting the lines as they were when it began, 3,000 fewer than a new look. Once the read was let go, a checkpoint emptied the file |
| An `.iterate()` that was not finished | The same in small: a checkpoint reports busy until it is finished |

**The two side files.**
- After a clean close the folder holds only `overnight.db`. A read-only open then makes SQLite create `overnight.db-shm` (32,768 bytes) and an empty `overnight.db-wal`, both private (mode 600), and it leaves them there when it closes.
- The database file itself did not change: same bytes, same size, same modification time.
- The next `Store` to open and close removed both files. While the listener runs they exist anyway, so a look adds nothing.
- SQLite's "immutable" mode would avoid them, but it is not on offer: a `file:...?immutable=1` name fails with `SQLITE_CANTOPEN`, because this better-sqlite3 build has URI file names switched off (`SQLITE_USE_URI=0` in its build settings).
- In a folder that cannot be written and has no side files yet, the open fails with `SQLITE_READONLY_DIRECTORY`.

**Looking at a lock file.** `listen.lock`, `build.lock` and `deliver.lock` are empty SQLite files that a running program holds a transaction on. The look is `new Database(file, { readonly: true, fileMustExist: true, timeout: 0 })`, `SELECT COUNT(*) FROM sqlite_master`, close.

| State of the lock file | What the look says |
|---|---|
| No file | `SQLITE_CANTOPEN`, so nothing is running. Nothing is created |
| Held by another process (the cli's `takeLock`) | `SQLITE_BUSY`, at once |
| The holder gave it back | Free. The file is 0 bytes and its `-journal` is gone |
| The holder was killed (`kill -9`) and its 512-byte `-journal` is left behind | Free, twice in a row. A real start afterwards got the lock |
| While it looks | No file's name or size changes, nor the lock file's time. The 512-byte `-journal` is the holder's, not the look's |
| 40 real starts, one after another, while this process looked non-stop (2,871 to 3,025 looks) | 40 of 40 got the lock |

**What follows for the dashboard:**
- Every look opens read-only, reads in one short transaction with `.get()` and `.all()` only, and closes. No connection is kept, there is no `.iterate()`, and nothing but SQL happens inside the transaction. Tests guard this.
- "The dashboard never writes in the data folder" is true of our code. SQLite's two side files are the footnote, and only when no other Overnight program is running.
- A missing file and a `user_version` of 0 both mean "nothing saved yet". `SQLITE_BUSY` means: show the last good look and try again.
- Whether the listener, a build or a deliver is running is read from the lock files with the read-only look, about once a second at most. A starting job waits up to 500 ms for its lock; in the 200 starts of the five runs, none was turned away.

Not tried: the real data folder beside the running listener (that is the dashboard's last proof step, with Henry at the screen), a database on a read-only disk, and several readers at once.

**After the dashboard was built on it (2026-10-11):**
- **The dashboard's own look beside a real writer** in another process, three runs: 500 lines written each time, 755 to 791 looks, no error on either side, slowest write 0.8 to 1.3 ms, write-ahead file about 4.1 MB. With a read deliberately left open the file reached 14.7 MB, and the test that guards the rule failed, as it should.
- **The look grew.** It now also reads the month's sum from the build credits ledger, a count of rehearsal ideas and the night clock's small values, in the same single transaction. A database with no ledger table yet is read without it and is not upgraded.
- **On the rehearsal's scratch folder** (`~/.overnight-rehearsal`, invented ideas only), with no other program on it: the folder listing went from 2,897 entries to 2,899. The two new ones were `overnight.db-shm` (32,768 bytes) and an empty `overnight.db-wal`. The database's checksum was the same before and after. "Practice Dice Roller" read as Kiro Crew, 2 min 19 s, 3.09 credits, checked in 5.2 s, 3 files, 5.6 KB, live after 21 s, delivered: the figures recorded in "The rehearsal" below.
- **SQLite waits for ever on a named pipe.** A pipe standing where the database, a lock file, or one of the files SQLite keeps beside them (`-journal`) should be, made the first query hang; raw SQLite on such a pipe was still waiting when a 5-second alarm ended it. So the dashboard looks first, and only opens what is a plain file.
- **"Busy" is rare.** A reader only ever got it when another connection had the database in exclusive locking mode. The look then waits a quarter of a second, and the page shows the last good look.
- **Two things about our own locks.** A lock taken with the cli's `takeLock` lasts only as long as the program keeps hold of the function that gives it back: a test helper that dropped it lost its lock at random moments. And a lock held by one connection is seen as held by another connection in the same process, which is how the demo shows "Listening" with no second program.

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

The "Status" column is as it stood on Oct 10. What Milestone 3 did with each line that says "Left for Milestone 3" is in "Milestone 3" below, under "What became of Milestone 2's left-overs".

## The first real night (2026-10-10 to 10-11)

The whole loop for real, with nobody at the Mac: an idea spoken near the watch on the morning of Oct 10, asked about on the wrist and ticked in the Bee app on the phone, built overnight and delivered the next morning.

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
- Fix for good (Milestone 3): have the jobs wake often and let Overnight's own code, which knows its time zone, decide whether it is time. That also covers a Mac that was asleep at 1:00. This is built now ("Milestone 3" below), and the live jobs have run it since the switch-over of Oct 20.

**Also learned.** The listener's keep-awake (`caffeinate -s`) only works on mains power. On battery the Mac sleeps after a minute, and with the lid closed it sleeps whatever is asked. That night a second keep-awake was started by hand for battery; building that in is Milestone 3 too. It is built now as well: the listener's code asks with `caffeinate -i -s`. The live listener was restarted with that code on Oct 20. Whether it holds this Mac awake on battery has not been tried.

**Confirmed by the wearer:** the watch buzzed at 7:32 am, and the to-do said the app was built.

## Milestone 3: dashboard and hardening (2026-10-11 to 10-12)

Milestone 3 was designed, built, reviewed by four independent reviews and fixed between the morning of Oct 11 and the small hours of Oct 12. This section records why it is built the way it is, what was measured on the way, and what has not been proved.

**Read this first.** Nothing measured while Milestone 3 was being built called Bee, started a Kiro Crew gateway or a Kiro agent, loaded a background job, published anything or spent Kiro credits. (Kiro's two programs were asked for their version number, and Kiro CLI for one setting.) Those measurements were run on scratch data folders and made-up home folders, with stand-ins where a real tool would have been needed; "for real" in them means the real macOS sandbox, the real `overnight` command, the real database library or a real browser, as each line says. The proofs on the real tools (P1 to P5, Oct 12) and the switch-over of the live system (Oct 20) came after. They are at the end, under "Still to be proved for real", with what is still open; a few lines above point to them.

### The decisions, and why

| Decision | Why |
|---|---|
| **Overnight keeps its own time.** macOS starts the two night jobs every 60 seconds; Overnight's own clock decides whether it is time. One start per job per day, written down before the work begins | On the first real night macOS's calendar ran both jobs exactly an hour late: it was still counting in the time zone the Mac had when it last restarted (it was changed after that). A calendar that goes by the Mac's zone and not by Overnight's `TZ` cannot be trusted with the night. A job that wakes often and asks also catches up by itself after a sleep |
| **Builds are not tied to mains power** | The first design said "a build starts only on mains power", so that a Mac closed in the middle of a catch-up build would not fail a good idea. Henry decided the other way on Oct 11: on battery, with the lid open, Overnight keeps the Mac awake so it keeps listening and can build. A mains-only rule contradicts that, so it was taken out everywhere |
| **Instead, a run the Mac slept through is stopped, and falls under the one-more-try rule** | Every time limit goes by the clock on the wall. Without care a build the lid was closed on wakes hours later "past its time limit", the idea is failed for good and the wearer is told "couldn't finish". Stopping it on waking puts it under the existing rule: a stopped build gets one more try |
| **A due run that finds the Mac has just woken waits one minute in place** | The first design made such a run wait for the next look instead. That needs two looks close together for anything ever to start, and macOS promises no such thing: a slow timer would have meant no night at all. Waiting in place costs a minute, never a night |
| **A run starts only when the internet answers** | When neither builder can start, the idea is failed for good, and a publish that cannot reach GitHub is failed for good. A Mac that has just woken on a network with no way out is exactly that case, and the new clock makes it likelier |
| **Finished builds are sealed:** moved to `built/`, their files made anew | With Kiro Crew one sandbox covers every job, so a later job could change an app that was waiting for the morning, and it would be published under the other idea's name. The move is one rename and needed no change to the sandbox rules: both profiles already closed all of the data folder but three folders |
| **A monthly ceiling on build credits, 400** (Henry, Oct 11). Silent on the wrist | The only limit before was two builds a night. The ceiling counts what Overnight saw and fails open: a fault in it must not cost a night |
| **The nightly sandbox check grew by two lines, not ten** | The check decides whether Kiro Crew builds at all that night. Ten new lines would have doubled the length of its command, and Kiro Crew's limit is not written down anywhere. The socket and port rules are covered by tests against the real sandbox and by spike 11 instead |
| **The dashboard opens from a link with a key, never shows the lines Bee heard, and hides quotes when filming** (Henry, Oct 11) | It shows quotes of what people said, on a port every program on the Mac can reach |
| **The dashboard is a plain Node web server that makes its pages itself**, not the Vite and React app first planned | No framework, no build step, no new package. Every page is made on the server through one template that escapes whatever it is handed, so it is hard to forget to |

Left out on purpose, each with its reason, is in SPEC §10.

**Written on Oct 12 after the review, and committed on Oct 20, just before the switch-over: a due run does not start on battery with the lid closed.** Not yet tried with a real closed lid. The decisions above left one case open. With the lid closed on battery the Mac sleeps whatever is asked, but a sleeping Mac wakes by itself for a short while now and then, and some of those wakes last longer than the minute a just-woken job waits (on this Mac: 8 of 329 on Oct 8 and 9). A job that macOS starts in such a wake would find its run due, wait its minute and start a build that the next sleep cuts short. The sleep watch stops that build cleanly, but it has then used up its one more try: two such nights and a good idea is failed and the wearer is told "couldn't finish". This is the loss the simulation showed under "Not measured, and open" below. Nothing can finish in that state anyway, so the night clock got one more reason to wait, the smallest that does it: when a run would otherwise start and the Mac is on battery and its lid is closed, it waits ("lid-closed": `status` says "waiting for the lid to be opened or the Mac to be plugged in"). Both night jobs; `build-now` and `rehearse run` are not asked, because a person is there. It is not the mains-only rule come back: on mains power with the lid closed (the first real night) and on battery with the lid open, a run starts as before. A reading that cannot be made never holds a run up: an unknown power source, a Mac without a lid, a tool that fails or takes longer than 5 seconds.
- **How this Mac answers, measured on Oct 12 with the lid open and on battery:** `/usr/sbin/ioreg -r -k AppleClamshellState -d 4` prints about 19,000 characters, among them the lines `"AppleClamshellState" = No` and `"AppleClamshellCausesSleep" = No`; the first line of `pmset -g ps` is `Now drawing from 'Battery Power'`. Asked for a key no Mac has, the same `ioreg` command prints nothing and ends with exit code 0, which is what a Mac without a lid is taken to do. Overnight's own two readers gave "battery" and "lid not closed" in 27 ms together. The rule goes by `AppleClamshellState` and the power source alone: what the second line means in each state has not been measured.
- **Run for real, on a scratch folder, with this Mac on battery and its lid open:** `overnight build --if-due` with a build due started it ("night clock: starting", 1 minute late; the scratch folder is in quiet mode, so nothing was built). So the two readings do not hold up a Mac that is open.
- **Simulated, a minute at a time with the real rule:** lid closed on battery from midnight, awake for two minutes every quarter of an hour, opened at 8:00. Nothing starts in the night; the build job stores its reason once, at 1:01; the build starts at 8:01 and is not cut short; the delivery follows it at 8:11. The same night on a Mac whose lid cannot be read starts the build at 1:01 and loses it to the sleep at 1:15, which is the night the rule is there for. The same night on mains power builds at 1:00 and delivers at 6:30.
- **Still open:** a real closed lid on battery (what `ioreg` says inside one of the Mac's own wakes has not been seen: `AppleClamshellState = Yes` is taken from the key's name, not from a reading); and a Mac that is awake on battery with its lid closed because a screen is plugged into it, which this rule holds up although it could build.

### Spikes 10, 11 and 12, and their modes

| Spike | Mode | What it does | Has it run? |
|---|---|---|---|
| 10 `10-night-clock.ts` | `check` | Changes nothing. Checks the script's own tools: that it refuses the four real job names and the real data folders, and that the installer's filled-in settings files are valid | Yes: every line "yes" |
| | `dry` | The script itself stands in for launchd: it starts the tool exactly as the two settings files say, at the start and every 60 seconds, and watches. It says nothing about macOS | Yes, twice. Both jobs looked at the clock at load and every 60 seconds, each wrote one first-look line, the build started exactly once at its minute, and `status --json` gave 0 minutes late |
| | `run` | Loads two throwaway jobs (`com.overnight-spike.night-clock.build` and `.deliver`) under real launchd for a few minutes, with the build's time set a few minutes ahead, on an empty scratch database | **Yes, passed, Oct 12 (P4).** Each job looked at the clock when loaded and then every 60 s; the build started once, 20 s after its minute |
| | `sitting` | The same with the Mac asleep across the build's time. It needs a person at the Mac, who pulls the power plug and then closes the lid at once: plugged in, this Mac does not sleep with the lid closed | **No. Pending (P4)** |
| | `cleanup` | Removes the two throwaway jobs if a killed run left them | Not needed yet |
| 11 `11-hardening-proof.ts` | `check` | No gateway, no Kiro program, no credits. Checks the script's own tools: that it refuses the real folders and the real port, that the profiles and its copies of them load, and that it can read what the sandbox decided out of macOS's log | Yes. In its first form on Oct 11: every line as expected. On Oct 12 it was extended to try the rewritten last step on harmless programs, and the last checker ran that form three times in a row: about 12 seconds each, exit code 0 each time. In those runs: the script's own four test refusals were found in macOS's log, 4 of 4; another program's refused socket file was in the log and was not counted; Node was refused the system log's socket on 5 or 6 of 6 starts, shown as expected; the script's own four tries at a closed socket failed the step, and with those set aside the same log passed; with the log program swapped for one that fails, or for one that prints nothing, the answer was "could not tell". Three scratch copies of the script with the log program replaced each stopped with exit code 1. A fourth run, made when this line was written, gave the same answers (Node refused on 5 of 6 starts) |
| | `p1` | No credits. A throwaway Kiro Crew gateway inside the gateway profile: the nightly check, one command job added, started, cancelled and removed, and one settings question to Kiro CLI inside its profile | **Yes, passed, Oct 12 (P1)** |
| | `p2 --spend-credits` | About half a Kiro credit. A one-line Kiro CLI chat and a one-line Kiro Crew agent job, each of which writes one file | **Yes, passed, Oct 12 (P2).** Kiro Crew recorded 0.4 credits for the agent job |
| 12 `12-sqlite-read-only.ts` | (none) | Reads the database beside a writer, in a temporary folder of its own | Yes, five times. Its own section is above |

Two notes on how spike 10 keeps away from the real system: the deliver job's time is set twelve hours off, because a delivery would talk to Bee; and both throwaway jobs get a made-up, empty home folder. Spike 11's gateway runs inside a copy of the shipped profile with a few lines added that only report what is used and refuse nothing.

### What was measured: the clock, sleep and launchd

Read from manuals and from this Mac (Oct 11, read-only):

| Fact | Where from | Result |
|---|---|---|
| What macOS promises for a job started every N seconds | `man launchd.plist` | It is started every N seconds. A start that falls while the Mac is asleep is missed, and so is one that falls while the job is still running. No time zone is involved |
| What one look at the clock costs | A cli command on a scratch folder, 3 runs; later the real `--if-due` | About 0.1 seconds each. Two jobs every minute is about 6 minutes of processor time a day |
| What would have shown the hour-late night beforehand | The date of the Mac's time-zone link against its last start-up | The zone was changed on Oct 7; the Mac had last started on Oct 6. "Zone changed after the last restart" was true on the bad night and false after the restart of Oct 11 |
| This Mac's sleep setting | `pmset -g custom` | It sleeps after one idle minute, on battery and on mains, unless something holds it |
| The keep-awake flags | `man caffeinate` | `-s` is "valid only when system is running on AC power". `-i` stops idle sleep and has no such limit |
| What the two flags really hold | The real `caffeinate`, started through the listener's own code, read back with `pmset -g assertions` (on mains power) | `-s` alone holds `PreventSystemSleep`. `-i -s` holds that and `PreventUserIdleSystemSleep`. Both end when the listener stops, and within 0.1 s of the listener being killed outright |
| How the power source reads | `pmset -g ps`, first line | `Now drawing from 'Battery Power'`, and `Now drawing from 'AC Power'` |
| How sleeps and wakes read | `pmset -g log` | Lines of the form date, time, zone, then `Sleep`, `Wake` or `DarkWake`, and the system's reason. Spike 10 prints these lines for the minutes it watched, so P4 shows a wake the Mac makes by itself only if one happens in those minutes |

Run through the real `overnight` command, on scratch folders:

| Try | Result |
|---|---|
| An empty scratch folder, the build's time two minutes ahead, a look every 20 seconds | `--from-now` printed its line. Every look printed nothing and made no log file. Exactly one "Tonight's build: 0 built, 0 failed; nothing approved." came at the set minute, then silence. `status --json` said 0 minutes late. This used the real internet check, real locks and a real keep-awake helper for an instant |
| Six processes looking at the same instant, at the build's time (17 rounds in all) | Always exactly one start and one summary line. Every other process ended with exit code 0 |
| The internet check for real | GitHub answered in 173 ms, with no login sent. A network that swallows the request costs 5 seconds and counts as offline. So does an answer with a certificate that cannot be trusted, which is what a sign-in-page network gives |
| A wake after hours asleep (a made-up clock) | The first look waits one minute in place, then builds, logged as 121 minutes late. A brief wake in which the clock jumps during that minute starts nothing, and the next wake builds |
| A late morning with both runs due at 10:00, in both orders | The build starts first. The delivery waits and runs within a minute of the build ending. With a 45-minute build the delivery stops waiting after 20 minutes |
| The clock changes (a made-up clock, a look a minute) | Nov 1, 2026: one build at the first 1:00 a.m., none at the second, the next one 25 hours later. Mar 14, 2027: one build and one delivery, the next build 23 hours later. A time inside the skipped hour (02:30) runs once, an hour early by the wall clock |
| `BUILD_TIME` or `TZ` changed in the middle of a day | Never more than one start for a day. `status` names the run the clock will really start (a day later than the new time, until the job is installed again) |
| A run killed outright after its start was written | `status` at once says "cut short". The next look closes that day's run and warns once. Nothing starts again that day, and the next night runs |
| Plain `overnight build` and `overnight deliver` | Wrote none of the night clock's values, in any state, and asked nothing of the internet |

Sleep, with a frozen process standing in for it (the process is stopped by a signal and continued later, while the wall clock runs on):

| Try | Result |
|---|---|
| `build --if-due` with a stand-in builder, frozen for 70 seconds | On thaw it logged the sleep line with a gap of 66 seconds, stopped the builder, closed the run as cut short and ended with exit code 0. The idea was left with one more try waiting |
| The real deliver step inside its sandbox, on a made-up app whose build never ends, frozen | Exit code 0, the idea stays `built`, the run is cut short, and the sandboxed build script was gone afterwards |
| The same idea frozen on two nights running | After the first night it waits for its one more try. After the second it counts as failed, and `status` shows nothing waiting |
| A sleep that outlasts the command's own last-resort time limit (4.5 hours for a build with the default settings) | Before the fix: "could not finish", exit code 1, and the idea left `building` for a day. After: the normal summary, exit code 0, the idea stopped with its one more try waiting |
| What a slept-through build is counted as | Before the fix: a 2-minute agent the Mac slept on for hours counted as a full-length try, 90 credits. After, run end to end with a process frozen for 30 made-up minutes: 173 seconds of agent time, 5.8 credits |
| A 5-second timer after a freeze | It fired at once on thaw, so a freeze is seen immediately. Whether a real sleep is seen as fast is not known. P4's sitting shows it for a timer of spike 10's own, not for Overnight's sleep watch, which is not in that run ("Still to be proved for real", below) |

One trap for anyone repeating the freeze: start the process from bash or from node. A zsh subshell keeps continuing a stopped job, which undoes the freeze.

Simulated, a minute at a time with the real rule (no process, no clock but a made-up one): awake all night; asleep until 3:00 and until 10:00, in both orders of the two jobs; a 45-minute build; a wake with no internet; a brief wake; off for three days; Nov 1; a killed build; the Mac sleeping in the middle of a build; and seeded random nights and weeks (1,500 weeks in the review's run). Never a second start for a day, never a day left unstarted. One fix came out of it: the delivery's 20 minutes used to count time asleep, so a moment's wake at 7 a.m. used them up hours before anyone opened the lid. With a 40-second wake every 15 minutes, 0 of 300 mornings delivered the same morning before the fix, and 300 of 300 after.

**Not measured, and open:** whether macOS starts the jobs in the brief wakes a sleeping Mac makes by itself, whether the one-minute wait is long enough for those, and whether the keep-awake helper would then keep such a wake going. The simulation, fed with wake lengths taken from this Mac's own sleep log, still lost mornings to builds started inside a long wake. P4's sitting can show something of this only if the Mac happens to wake by itself in the few minutes its lid is closed (the script prints macOS's power log for that time). Nothing else looks at it yet.

Small facts about macOS's tools, found while writing the installer and spike 10:
- `plutil -lint` passes a job template whose placeholders sit inside text values, and fails one with bare text inside a list. So the build and deliver templates are valid as they stand, and the gateway's is not, on purpose.
- A comment in a job's settings file may not contain two hyphens in a row. The templates therefore say "the if-due switch" and never spell the switch.
- `plutil -convert json -o - -` reads standard input, so a settings file can be checked without writing it. The result does not keep the file's order of keys.

### What was measured: the database

| Try | Result |
|---|---|
| Milestone 2's code and Milestone 3's on one database file | The old code made a version 3 file. The new code upgraded it to version 4 (one new table and its index; every other table byte for byte the same) while the old code still had it open. The old code carried on reading and writing, opened the version 4 file from cold, built and delivered on it, and left the version at 4. The new code found its ledger rows and its night clock records intact |
| Two or more programs opening the database in the same instant, before the fix | A brand-new file: 8 rounds of 8 failed ("database is locked", or a column added twice). A version 3 file: 5 of 8 |
| The same after the fix (the upgrade locks the file first and reads the version again inside the lock) | 0 failures in 12 rounds with 2 programs, 12 with 4 programs, and 12 with 3 programs on a version 3 file |
| How long the database library waits for a lock | 5 seconds by default. But SQLite does not wait at all at the one step that switches a new file to its write-ahead log, so two programs creating one file at once need a retry there |

The read-only measurements (reading beside a writer, the two side files, looking at a lock file, a named pipe) are in "Spike 12" above.

### What was measured: the macOS sandbox

Tried on Oct 11 (macOS 26) with throwaway rules around macOS's own tools, and afterwards with the two shipped profiles on made-up home folders. No gateway and no Kiro agent was involved.

**Rule forms that work:**

| Rule | What it does |
|---|---|
| `(deny network-outbound (remote unix-socket (path-regex #"^/")))` | Refuses every socket file. A later allow for one exact path opens just that one again |
| An allow worked out from a folder: `(remote unix-socket (path-regex (string-append "^" (regex-quote dir) "/")))` | A socket inside that folder connects; one in the next folder is refused |
| The same refusal, tried by other routes | A socket reached by a short relative name, through a link, through a linked folder, by a name with `..` in it, through a hard link made beforehand, or by a datagram: all still refused. The sandbox goes by the full real path |
| With only `/private/var/run/mDNSResponder` allowed | Node can look up a host name and reach the npm registry. With every socket refused it cannot (`ENOTFOUND`) |
| `(deny network-outbound (remote ip "*:4321"))` and `(deny network-bind (local ip "*:4321"))` | Port 4321 can be neither connected to nor taken, by every spelling of this Mac's address that was tried (four for connecting, six for taking, and by datagram too). Another local port still connects and can still be taken |
| `(deny sysctl-read (sysctl-name-prefix "kern.proc."))` | The whole list of programs and any program outside are refused. A program's own child, asked for by its number, is still answered |
| `(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))` | `lsappinfo list` then shows no running app. The process-list rule alone does not empty it |
| `(allow <operation> <filter> (with report))` | Changes nothing and writes each use to macOS's log, which can be read with `/usr/bin/log show` without a password. This is how spike 11 learns what a real build uses without refusing anything first |

**Rule forms that do not do what they seem to:**

| Rule | What really happens |
|---|---|
| `(deny network-outbound (remote ip "localhost:4321"))` | It refuses `127.0.0.1`, `::1` and this Mac's network address. **It does not cover `::ffff:127.0.0.1`**, which is 127.0.0.1 written as an IPv6 address. By that spelling a sandboxed program read a page served on 127.0.0.1, and with the page gone it took the port and served its own. The same holds for `network-bind`. Found by the review; the shipped rules use `"*:4321"`. The price: port 4321 on any other machine is refused too |
| The process-list rule above, inside the gateway's profile | It also refuses a program **its own process group**, while its own child by number is answered. Kiro Crew's installed code asks for process groups to look after its jobs (read in its code, by names only; a real gateway was not tried under the rule). So the gateway's profile does not have this rule (F-053) |
| A report-only allow, placed before the profile's own rules | It is silent wherever a later allow matches. Only refusals, local ports and process-list questions show up in the log |
| Trusting a job's own word for "I could not write there" | Where a program may write but not look, `touch` makes the file and still ends with an error, and `rm` then cannot remove it. The nightly check's write lines would have passed a fence that was open for writing only. Overnight now looks for the files itself, from outside the sandbox |

**Other things seen:**
- A refusal of a port by the sandbox shows as "not permitted". A port nobody listens on shows as "connection refused". The tests tell the two apart.
- A socket path longer than 104 bytes fails even outside a sandbox.
- Under the new Kiro CLI profile, **Node itself asks for the system log's socket file** (`/private/var/run/syslog`) when it starts, and is refused. It showed in macOS's log on 6 of 10 starts in one run and on 2 of 10 in another, and never inside the gateway profile. It is harmless: under both new profiles the test browser opened a local page, clicked and took a screenshot, and a name lookup, a connection to the npm registry (IPv4 and IPv6), a forked child, a worker, a named pipe in the temporary folder, servers on two local ports, `node`, `npm --version`, `kiro-cli --version` and one `kiro-cli settings` read all worked. It matters for the proofs: "no socket refused" is not a fair pass line for a Kiro CLI build.
- Kiro's desktop app keeps two socket files in this account's usual temporary folder (`kirorun/desktop.sock` and `kirorun/remote.sock`). If a proof shows one of them refused, that is the rule doing its job (F-056).
- Kiro Crew keeps its own socket files inside its home folder (read in its code), which the gateway profile allows.
- The nightly check's command was 3,562 characters long with this Mac's real paths when this was measured. P1 then showed that Kiro Crew accepts the check's command (3,478 characters with the scratch paths), and the live `preflight` of Oct 20, which runs the check as a Kiro Crew job with the real paths, passed.

**Sealing, tried for real in both profiles:**

| Try | Result |
|---|---|
| Reading, listing, looking at, writing, running, moving, removing or linking into `built/` | All refused, also for a folder that was moved there a moment ago |
| A program a "build" left running, writing through a file it had opened before the move | **It worked**: a rename moves the same file. Every change by name from the folder it held open was refused (renaming, removing, linking, making a folder, changing permissions) |
| A later job writing through a hard link made beforehand in a folder jobs may write | **It worked**, for the same reason |
| The same two tries after the files are made anew | The sealed file still read as it was built, both times |
| A build that makes a hard link to a file and then marks the file "locked" | Marking a file locked works inside the sandbox. The seal cannot put a new copy in a locked file's place, counts it and logs an error. A later job unlocked the file by its other name, wrote to it, and the sealed file was changed. **Open** (SPEC §6) |
| How long making the files anew takes | 10,127 files and 590 MB: between 1.3 and 2.8 seconds |

In passing: Node's "clone this file" way of copying answered "not supported" in the session that built the seal, so the seal makes plain copies.

**The nightly check, fourteen lines:** it passes under the shipped gateway profile and fails by name on copies loosened in exactly one way (each list, the look at another program, `built/` listed, `built/` written). Run under the Milestone 2 gateway profile it passes too, because that profile already closes `built/`. All of this is the real `sandbox-exec` around the check's own command on a made-up home, not a real gateway.

### What was measured: build credits

| Try | Result |
|---|---|
| A job adding one line to Kiro Crew's usage file, before the fix | The figure was believed: 100,000 credits, the month closed, and no setting could open it again. A line of minus 4.6 cancelled a real figure to 0 |
| The same after the fix (a figure is believed only up to 10 credits for each minute the agent ran) | Both ideas of the night were built, 12 credits were counted, all of it as an estimate, with a warning in the log. The minus line is not counted at all |
| What is left to a job | It can still write that file (F-054). It can make the count too low, and make one try count for up to 10 credits a minute |
| Real builds so far | 1.3 to 1.7 credits a minute |

### What was measured: the real data folder by its other names

- macOS has two more names for every folder: `/System/Volumes/Data<path>` and `/.vol/<device number>/<file number>`. Neither is a link. Asking for the real path of the first gives the same name back, and asking for the real path of the second fails although the folder can be looked at.
- So Milestone 2's rule, which compared real paths as text, **let a rehearsal run on the real data folder** when it was named either way (tried on a made-up home folder).
- The new rule compares what the disk says a folder is: its device number and its file number. It refused both spellings, also when the real folder had not been made yet. One file number on this Mac is too big for an ordinary number, so they are read as big integers.
- The dashboard's demo and both new spikes use the same kind of check.

### What was measured: the dashboard

| Try | Result |
|---|---|
| A link written with `localhost` | The dashboard listens on `127.0.0.1` only. With a stand-in listening on the IPv6 address of the same name and port, both `curl` and a browser sent a `localhost` link, key and all, to the stand-in. Taking that address while ours was in use gave no error. So the dashboard writes its links with `127.0.0.1` |
| `npm run dashboard:demo --play`, typed without the two dashes | npm keeps the option, and reads `--play` as four of its own one-letter switches run together (`-p -l -a -y`), with no warning. Left alone, `--filming` typed that way would have started the dashboard with every quote showing, and `--demo` would have opened the real data. The dashboard now looks for what npm leaves behind and refuses to start |
| The request gate, over real HTTP | No key: 401. Another site's name in the request, also with the right key: 403. A request that is not a read: 405. A background request from another site, also with the cookie: 403. The key link: a redirect to the plain address. Listening on `127.0.0.1` only. No answer carries a header that lets another site read it |
| A link clicked on another site's page, in a real browser | It opened the dashboard. That site's pictures, frames and background requests to the dashboard got nothing, before and after the browser held the key |
| Node's own web server | It answers some requests by itself, before our code sees them (a request with no host, a malformed one, too many headers, one that is too slow), and leaves our safety headers off those answers unless told otherwise. It also drops a second host header without a word. All switched over to our own handling |
| Every page in a browser, on invented data | Phone and desktop sizes, light and dark: no console error, nothing wider than the screen, no request left the Mac, and text contrast above the usual reading threshold on all 17 pages |
| The invented night (`--play`) | 25 steps arrived over about 70 seconds with one page load and no error |
| Real build output, read through the dashboard | The Oct 10 rehearsal's scratch folder read back with the figures recorded for it (see "Spike 12", above) |
| The hostile test | Invented titles, notes and links full of markup and script addresses, on every page: nothing ran, nothing was linked |

### What was measured: the morning

All with the real deliver code, a real database and the real sandbox, and stand-ins for Bee and for the publisher.

| Try | Result |
|---|---|
| An app sealed in `built/<id>` | Verified from there and delivered; the folder was not changed. Milestone 2's deliver code on the same folder: "The app's folder does not exist.", and a `🌙` to-do. (That is the reason for the first step of "Backing out" below) |
| An app still in `workspaces/<id>` | Verified from there and delivered |
| A push that ran into its time limit | `publish_failed`, no link, the reason ending "The push may have reached GitHub all the same, so the app may be public.", one `🌙` to-do |
| Two failed ideas, and a second process that starts rebuilding one of them while Bee is being asked about the other | Old code: two `🌙` to-dos, one of them for an idea that was being built. New code: one |
| A run killed outright while Bee is being asked | The mark was on disk. The next run asked for no to-do and closed the idea with the careful note |
| Real `git`, stopped in the middle of a push to a stand-in repo | The stand-in got nothing, and the publisher still, rightly, says the push may be out. 15 runs of 15 |
| The detector's evaluation and `.env` (a stand-in for Kiro, no credits) | Before: it ignored `.env` and used the default data folder. After: `.env`'s folder, and the environment's when both are given. With neither it still uses the default folder, `~/.overnight`, and nothing refuses that |

### What the review round found

Four independent reviews (the night clock; the builder and its sandbox; the morning and the listener; the day of the merge), then fixes, then a fifth check of the fixes. 23 findings in all.

| Outcome | Count | Which |
|---|---|---|
| Fixed, and the fix holds under the reviewer's own reproduction | 10 | A sleep past the command's time limit; `status` promising a run the clock would not start; the port rule and `::ffff:127.0.0.1`; believing any figure in Kiro Crew's usage file; a slept build counted as 90 credits; a log line promising a second try that a second start does not get; two notes that said "told" or "pushed" when that was not known; the installer replacing the gateway's rules before it could refuse; the Power row; the dashboard promising builds that `status` said would not happen |
| Partly fixed | 2 | A due run that never starts now shows in `status` and fails `preflight`, with two small cases left (SPEC §3). The seal now makes files anew, with the locked-file case left (SPEC §6) |
| Not fixed when the round ended | 1 | Spike 11's last, deciding step passed when macOS's log could not be read and failed on another program's refusals. It was rewritten on Oct 12, after the round. As the script now stands, the step first proves the log was read (it makes a connection the profile certainly refuses and looks for it in what was read), counts only refusals made to this run's own programs, and prints Node's refused try at the system log's socket as "expected". The script's `check` mode has tried the rewritten step on harmless programs (the table of modes, above). The rewrite then ran in the real `p1` and `p2` on Oct 12: macOS's log was read (4 of 4 test refusals found) and no socket file was refused to the run's own programs |
| Left for the integrator | 10 | Seven are this pass over the documents. The other three: the pass line "no socket refused" cannot be met by a Kiro CLI build (see the system log's socket, above); the detector's evaluation needs a scratch data folder named on its command in a clean clone; and the merge itself puts the new sandbox rules under part of that night's builds: Overnight's own `kirocrew` commands and the Kiro CLI builder load the rules from the repo on every run. (A Kiro Crew agent does not get them from the merge. It runs inside the gateway, which goes by its own copy of the rules until `install crew` is run again.) That last one is why P1 to P3 come before the merge |

Tests on Oct 12, after the last round: 3,546 pass in 116 files, with typecheck and lint clean. One race test in the builder's safe-read tests (a link swapped in while the file is read) is a real flake. It failed once for a fixer and then passed 39 runs in a row; it failed again in one of the last checker's three whole runs. It fails in its clean-up, not in what it checks: the test stopped its helper program without waiting for it to be gone, and the helper could put a file back while the test's folder was being removed. Run alone it passed 8 times of 8. The fault is the test's, not that of the code it tests. It was fixed the same night: the test now waits until its helper is gone. Outside the test runner the old order (stop the helper, remove the folder at once) failed in 99 of 300 rounds and the new order in 0 of 300; the test file then passed 30 runs in a row, and the whole suite passed in full (3,546 of 3,546).

### What became of Milestone 2's left-overs

| Left over on Oct 10 | Milestone 3 |
|---|---|
| A build job can read the list of running programs and apps | Closed for the Kiro CLI builder. Accepted for Kiro Crew (F-053) |
| A build job can connect to another program's socket file | Refused in both profiles |
| A build job can connect to any local port | Only the dashboard's port is refused. The rest is accepted and written down (SPEC §9, limit 11) |
| A Kiro Crew job can read and change Kiro Crew's own settings and secret | Unchanged and accepted (SPEC §9, limit 4) |
| A Kiro Crew job can read, write and rename another idea's workspace | A finished build is sealed. A workspace in progress is still in reach |
| A job can make a folder named `kirocrew...` in Kiro's agents folder | Left as it is: a job can already rewrite Kiro Crew's own agent files there |
| `rehearse` could be pointed at the real data folder by an unusual spelling | Fixed |
| A brand-new Kiro home cannot start an agent inside the sandbox (F-052) | No check was built. The README's set-up now makes the two Kiro settings commands a required step, and they create the files in question |
| `git` and `mktemp -t` do not work inside the build sandboxes | Left as it is |
| The morning's printed line did not say when a page was not seen live | Fixed |

### Still to be proved for real

**Most of this happened in the small hours of Oct 12; each result is beside its step. The switch-over followed on Oct 20 (below).** Still pending: the sitting of P4 and the two looks it does not make (the sleep watch on a real sleep, and the battery hold), the first night on Overnight's own clock, and the dashboard on the real data folder. The plan: daytime only, scratch data folders only, throwaway job names, a throwaway Kiro Crew home on another port, stop at the first failure. Budget: about 10 Kiro credits, and never past 20 without asking Henry.

| Step | What | Credits | Result |
|---|---|---|---|
| P1 | Spike 11, `p1`: a throwaway gateway under the new rules answers; the fourteen-line check passes, and fails by name on a loosened copy; a command job is added, started, cancelled and removed by Overnight's own `kirocrew` commands under the new rules; `kiro-cli settings` answers inside the Kiro CLI profile | 0 | **Passed, Oct 12, 3:29 am.** The gateway answered; the check passed; the loosened copy failed with "a job can list the finished builds"; the command job was added, started, cancelled (Kiro Crew's record: "cancelled") and removed; `kiro-cli settings` exit code 0; macOS's log was read (4 of 4 test refusals found) and no socket file was refused to the run's own programs |
| P2 | Spike 11, `p2`: one one-line Kiro CLI chat inside its profile; one one-line Kiro Crew agent job that writes one file | about 0.5 | **Passed, Oct 12, 3:30 am.** The Kiro CLI chat wrote its file in 5 s. The Kiro Crew agent job ended "success" in 10 s, wrote its file, and Kiro Crew recorded 0.4 credits for it. No socket file refused |
| P3 | Two rehearsal builds without publishing, on a scratch folder: one with Kiro Crew on the throwaway gateway, one with Kiro CLI. Both end "delivered"; `built/<id>` is there and `workspaces/<id>` is gone; the ledger has a measured row and an estimated row, and `status` shows both; a run with the ceiling set to 1 is refused before any agent starts; `build`, `deliver` and `build-now` are refused on that folder | 4 to 8 | **Passed, Oct 12, 3:31 to 3:36 am.** Kiro Crew built "Zebra Dice Roller" in 134 s for 2.959 credits (Kiro Crew's own figure), on a throwaway gateway kept up by spike 11's `hold`; over the whole hold no socket file was refused to the run's programs, Playwright's browser included. Kiro CLI built "Quokka Coin Flip" in 116 s (counted as 3.8, an estimate). Both ended "delivered"; both folders were in `built/` and neither in `workspaces/`; 606 files of the first were made anew. `status`: "6.8 of 400 used this month (3.8 of that is an estimate)". With the ceiling at 1 a third run was refused before any agent started, and `build` and `deliver` refused the folder |
| P4 | Spike 10, `run`: the real job templates under real launchd with throwaway names. A look at the clock each minute, one first-look record, exactly one start at the set minute, silence after. Then spike 10, `sitting`, with Henry: the power plug pulled and the lid closed across the build's time, and one late start a minute or two after the Mac is awake again. Then, by hand, the battery hold, which spike 10 does not look at. Overnight's sleep watch is not in spike 10's run either (both below the questions) | 0 | `run`: **passed, Oct 12, 3:36 to 3:42 am.** Each job looked at the clock when loaded and then exactly every 60 s (six looks each); the build started once, 20 s after its minute, not marked late; nothing started after it; both throwaway jobs were removed and the four real jobs were untouched. `sitting`: **pending** (it needs Henry at the Mac) |
| P5 | A clean clone: `npm ci`, typecheck, lint, tests; the tests again under an empty made-up home folder; the README's commands as written; the two odd spellings of a real folder refused by `rehearse new`; the detector's evaluation once, with a scratch `OVERNIGHT_DATA_DIR` on the command | about 1 | **Passed, Oct 12, 3:42 to 3:47 am**, on a clone at commit `ab82677`. `npm ci` exit code 0; typecheck and lint clean; 3,546 of 3,546 tests; `status`, `ideas`, `resume` and `pause` exit code 0 under a made-up home, with `status` naming that home's data folder; both odd spellings refused (exit code 2); the detector's evaluation: precision 0.96, recall 1.00, PASS. Under a made-up home in a temporary folder, two sandbox tests about a person's real home folder failed for that reason alone; they now skip there (that file: 59 pass, 6 skipped) |

**Answers from the night of Oct 12** (P1 to P3, P4's `run` and P5; 5.86 Kiro credits in all, by Kiro's own usage line: 40.27 before, 46.13 after):
- Overnight's own `kirocrew` commands, a Kiro Crew agent, a Kiro CLI chat, and a whole build with each builder all work under the socket rule, the port rule and (Kiro CLI) the process-list and app-list rules. No rule had to be dropped.
- Kiro Crew accepts the longer check command (3,478 characters for the scratch paths).
- macOS started each 60-second job exactly every 60 seconds while awake, and at load.
- A clean clone passes everything. On a made-up home with none of Kiro's files, the suite passes with the real-home tests skipped.
- On the live system, which was still on macOS's calendar then: after the restart of Oct 11 the build job fired at 1:00:01 am on Oct 12 (it had nothing to build). The hour-late fault is gone.
- Not answered yet: what Kiro Crew records for an agent run that was cancelled; how soon after a wake macOS starts a job, and whether it does in a sleeping Mac's own brief wakes (the sitting); whether a real sleep is seen by the sleep watch; whether `caffeinate -i -s` holds this Mac awake on battery.

The questions these steps were there to answer, as they stood before that night:
- Do Overnight's own `kirocrew` commands, a Kiro Crew agent and a Kiro CLI chat work under the socket rule, the port rule, and (Kiro CLI) the process-list and app-list rules? Only version questions and one settings read have been tried.
- Does Kiro Crew accept the longer check command?
- Does Kiro Crew write usage lines for a run that was cancelled or timed out, and are they still there after the job is removed? Without them such a try is estimated from its time.
- How regularly does macOS start a 60-second job, how soon after a wake, and does it start one in the brief wakes a sleeping Mac makes by itself? (The last part shows only if such a wake happens during the sitting.)
- Is a real sleep seen by the sleep watch the way a frozen process was? (Not by spike 10 itself: see below.)
- Does `caffeinate -i -s` keep this Mac awake on battery with the lid open? (Not by spike 10 itself: see below.)
- Does `npm test` pass on a Mac with no Kiro, no GitHub CLI and no test browser?

**What spike 10's sitting needs, and what it does not measure.** Found by the last check on Oct 12, by reading the script and this Mac's power settings. Nothing here has been run.
- **The power plug has to be pulled before the lid is closed.** Plugged in, the running listener keeps this Mac awake with the lid closed: the first real night ran that way. With the plug in nothing would sleep, the build would start on time, and the sitting would end "NOT AS EXPECTED" as an ordinary run. The script's on-screen steps said only "close the lid" until Oct 12; they were changed that day to say what follows. For Henry, one step at a time:
  1. Leave the Mac plugged in and wait until the window shows two lines "the build job looked at the clock".
  2. Pull out the power plug and close the lid at once, before the time the window names. (Unplugged with the lid open, this Mac sleeps by itself after one idle minute, so the plug comes out only at that moment.)
  3. Open the lid any time after the second time the window names, log in, and put the plug back.
  4. Leave it open for five minutes. The Wi-Fi has to be back within about a minute of opening, or the line "within three minutes" can say NO for no deeper reason.
- **It does not run Overnight's sleep watch.** The spike's build finds nothing approved and ends in under a second, so no run is going when the lid is closed. What the sitting shows is its line "(this script was frozen for N seconds: the Mac slept)": a timer inside a program comes late after a real sleep, which is the same sign the sleep watch goes by. That is as far as it goes. The watch itself on a real sleep stays to be shown.
- **It does not hold the Mac awake or look at the battery.** That is a look of its own, by hand, with Henry: pull the plug, leave the lid open, run `/usr/bin/caffeinate -i -s /bin/sleep 300`, keep hands off for five minutes, then read `pmset -g log | grep -E " (Sleep|Wake|DarkWake) " | tail -5`. It passes when those five minutes hold no "Sleep" line. It only counts if `pmset -g assertions` shows no other program holding the Mac awake at the same time; the Claude app does that while a session is working.

**The switch-over of the live system. Done, Oct 20, 5:09 to 5:12 pm.** It went ahead after P1, P2, P3, P5 and the `run` half of P4, without waiting for P4's sitting. Just before it, the closed-lid rule ("Written on Oct 12 after the review", under "The decisions, and why") was committed. What each step showed:

- Step 1: merged into the live working copy.
- Step 2: `status` added the ledger table.
- Step 3: `restart listen`. The listener's log says "keeping the Mac awake while this runs", and its keep-awake helper runs as `caffeinate -i -s` (seen in the list of running programs at 5:09:21 pm).
- Step 4: `install crew`. The gateway's copy of the sandbox rules is now equal to the repo's.
- Step 5: `install build`, then `install deliver`. Each job looked at the clock when it was installed.
- Step 6: `preflight` said Ready, 13 of 13.
- Step 7 (reading `status` once more) is not recorded here.
- Still not done: P4's sitting, the battery hold (`caffeinate -i -s` on battery with the lid open), and a real closed lid on battery. So the live listener now asks to keep the Mac awake on battery too, but whether that holds on this Mac is not known.

The plan as it was written beforehand, for a daytime with the Mac plugged in and no build or delivery running, only after P1 to P5:

1. Merge into the live working copy. No `npm install` is needed: tried on a scratch copy without the link for the new dashboard package, where `status`, the demo, the typecheck and the dashboard's and core's tests all ran.
2. `npx overnight status`. The first open with the new code adds the ledger table. The Night clock row should say both jobs are still on macOS's calendar.
3. `scripts/install-agents.sh restart listen`. The listener's log should then say "keeping the Mac awake while this runs"; the old line was "keeping the Mac awake while plugged in".
4. `scripts/install-agents.sh install crew`: the gateway's new copy of the sandbox rules.
5. `scripts/install-agents.sh install build`, then `install deliver`. Not within a minute of either job's time.
6. `npx overnight preflight`: thirteen ticks.
7. `npx overnight status`: "Next build" shows tonight's time, and the Night clock row says both jobs check the time every minute.

What is known about the hours between steps 1 and 5, from scratch copies with stand-ins: the old calendar jobs run the new code as plain `build` and `deliver`. That worked: two builds were made, sealed and counted, and nothing was written to the night clock. `preflight` in that state gives eleven ticks and two crosses (the jobs are still on the calendar; the gateway is behind another copy of the rules). And from the moment of the merge, Overnight's own `kirocrew` commands and the Kiro CLI builder run under the new sandbox rules, whatever the gateway job was installed with.

**The first night on Overnight's own clock, Oct 20 to 21: on time.** `build.log`: "night clock: starting" at 1:00:21 a.m., 0 minutes late; `deliver.log`: the same at 6:30:29 a.m., 0 minutes late. Nothing was approved, so neither had work to do; both closed their day's slot once.

**The dashboard on the real data folder, beside the running listener, with Henry at the screen. Pending.**

### Backing out of Milestone 3

Written from trials on scratch copies with the old code and the new side by side. It has not been needed on the real system. Do it in the daytime, with no build or delivery running, and do every step.

1. **Move finished builds back to where the old code looks.** Move every folder in `<data>/built/` that is named exactly after an idea back to `<data>/workspaces/`. Do not move the folders named `<id>.old-<time>`, a folder named `<id>.sealing` (it is only there if a move was killed half-way), or the file `.overnight-probe-marker`. The reason, measured: with the old code, two good sealed builds both became `publish_failed` with "The app's folder does not exist.", and the wearer would have been told twice that an app could not be finished. After the folders were moved back, the old code delivered both. An idea whose publish failed and whose folder is in `built/` needs the same before the old `build-now` can publish it again (same code path; read, not run).
2. **Check out the previous version of the code** in the live working copy.
3. **Straight away, with the old installer:** `install build`, `install deliver`, `install crew`, `restart listen`. This must follow at once. Measured with only the code rolled back: the new job files start the old code with the if-due switch every minute, which it does not understand. Each start ends with exit code 2 and writes 52 lines (about 4 KB) to the job's `*.launchd.log`, about 12 MB a day for the two jobs, and nothing is built or delivered. The old code gives no warning: its `status` says the night jobs are installed and that an approved idea "will be built at the next build".
4. **Check.** `scripts/install-agents.sh status build` shows "runs at: 01:00", and the last lines of `logs/build.launchd.log` are no longer the command's help text. Then `npx overnight preflight` (twelve checks in the old code).
5. **Remember what the old code brings back.** The night jobs are on macOS's calendar again, which goes by the zone the Mac had when it last restarted: if the zone has changed since, restart the Mac once. The listener keeps the Mac awake on mains power only. `install crew` puts the Milestone 2 sandbox rules back in the gateway's copy.

What can stay as it is: the ledger table, the night clock's stored values, and the `built/` and `sandbox/` folders. The old code ignores them (measured: it opened, read and wrote a version 4 file, built and delivered on it, and left the version at 4).

## Decisions that came out of the spikes

1. **How the nightly Kiro Crew job is allowed to work** (finding 2). **Decided on Oct 9:** build jobs get `--approval-mode auto`, Crew's documented setting for unattended jobs. (The plan to also raise Crew's sandbox to `strict` was overtaken by decision 2.) (The alternative, leaving every Crew setting alone and having Crew only start our own `kiro-cli` builder, was the weaker Kiro Crew story and no safer.)
2. **Keeping logins away from the builder** (finding 3). **Decided on Oct 10**, after experiments A and B above: the whole Kiro Crew gateway runs inside Overnight's own sandbox, Crew's own sandbox setting is switched off because the two can't be stacked, and a probe before each night's builds must show the GitHub login, the Bee login and the transcripts are unreachable or nothing is built. The build agent is only ever given `brief.md`, with no quote and no facts.
3. **Keeping the Mac awake at 1:00 a.m.** It's a MacBook that sleeps after a minute of idle. **Agreed on Oct 9:** Henry keeps it plugged in with the lid open on build nights, and the background jobs hold it awake while they run. (Widened on Oct 11, decision 9 below.)
4. **Kiro content sharing. Decided on Oct 9: switched off.** By default Kiro may use prompts from individual accounts to improve its service, and the detector will send transcript text. Both settings (`codeWhisperer.shareCodeWhispererContentWithAWS` and `telemetry.enabled`) are now `false` on this Mac, in the default settings folder and in the detector's own `KIRO_HOME`. Any new `KIRO_HOME` we create needs the same two settings before real text goes through it.

Four more came out of the Milestone 2 fix rounds, all decided on Oct 10 while planning the last round:

5. **A stopped build gets one more try.** A build that was stopped or cut off (not one that failed) is built once more by the next nightly run. The wearer is told "couldn't finish" only when that second start also ends badly. The rule is in one place, `packages/core/src/build-retry.ts`.
6. **Pushed but not seen live still counts as published.** If the push to GitHub went through but the page was not seen serving the new app within the 10-minute wait, the idea is recorded as published and announced as usual, with a note saying it was not confirmed. (The page is not looked at again later; that is a known gap.)
7. **The build sandboxes refuse reading by default.** Not only writing: nothing in the home folder can be read or run except a short list, and build jobs get a temporary folder of their own. One exception is built in for Kiro Crew, because it will not start an agent otherwise: a job can list the names directly inside the home folder (F-042). That was accepted on Oct 10, and Kiro Crew stays the first builder (SPEC §9, limit 5).
8. **Rehearsals are a real command.** `overnight rehearse` tries the night and the morning on an invented idea. It can never reach Bee, and it refuses the real data folder.

Four more are Henry's, made on Oct 11 while Milestone 3 was being designed. The reasons, and the design decisions that followed, are in "Milestone 3" above:

9. **On battery, with the lid open, Overnight keeps the Mac awake**, so that it keeps listening and can build at night. (So there is no "builds only on mains power" rule, and a run the Mac sleeps through is stopped; a build on its first start is then tried once more.)
10. **A late app buzzes when it is ready, never between 11 p.m. and 7 a.m.** This is the alarm rule Milestone 2 already had; nothing was changed.
11. **The monthly ceiling on build credits is 400.** It is silent on the wrist; `overnight status` says why nothing is built.
12. **The dashboard** opens from a link with a key that is new at each start. The lines Bee heard are never shown, in any mode. An idea's quote is shown by default and hidden by `--filming`.
