# Spikes (Milestone 0)

One small script per outside piece, run for real before we build on it. This file records what each one proved. No Bee data appears here: only field names, timings and yes/no answers.

Last updated: 2026-10-09

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

Kiro: `kiro-cli` is signed in with GitHub on the **Kiro Pro** plan (1,000 credits a month). All of today's Kiro tests together, including a second run of each script, used about 1.1 credits. Kiro Crew settings changed from their defaults: `stt.enabled false` (voice typing, unused), `timezone America/Boise`, `auto_update false`. Sandbox and approval settings are untouched. Kiro CLI settings changed: `codeWhisperer.shareCodeWhispererContentWithAWS false` and `telemetry.enabled false`, in the default settings folder and in the detector's own `KIRO_HOME` (Henry's decision, Oct 9).

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

## Decisions that came out of the spikes

1. **How the nightly Kiro Crew job is allowed to work** (finding 2). **Decided on Oct 9:** that one job gets `--approval-mode auto`, Crew's documented setting for unattended jobs, and Crew's sandbox is raised to its `strict` level at the same time. No other Crew setting changes. (The alternative, leaving every Crew setting alone and having Crew only start our own `kiro-cli` builder, was the weaker Kiro Crew story and no safer.)
2. **Keeping logins away from the builder** (finding 3). Needs its own small spike in M2: Crew's `strict` sandbox level, Kiro permission rules, and what a build can still reach.
3. **Keeping the Mac awake at 1:00 a.m.** It's a MacBook that sleeps after a minute of idle. **Agreed on Oct 9:** Henry keeps it plugged in with the lid open on build nights, and the background jobs hold it awake while they run.
4. **Kiro content sharing. Decided on Oct 9: switched off.** By default Kiro may use prompts from individual accounts to improve its service, and the detector will send transcript text. Both settings (`codeWhisperer.shareCodeWhispererContentWithAWS` and `telemetry.enabled`) are now `false` on this Mac, in the default settings folder and in the detector's own `KIRO_HOME`. Any new `KIRO_HOME` we create needs the same two settings before real text goes through it.
