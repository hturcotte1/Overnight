# Overnight: build spec

> Say it at lunch. Use it at breakfast.

Overnight listens through Bee for the moments you say "someone should build...". It asks on your wrist whether to build the idea. While you sleep, Kiro Crew builds a small working web app; Overnight then tests and publishes it. In the morning your watch buzzes with the link.

- **Owner:** Henry Turcotte
- **Entry:** Amazon "Build, Ship, Shape" Developer Hackathon, **Bee track**, plus the **AWS Builder** side prize (via Kiro Crew)
- **This file is the source of truth.** Update it when a decision changes.

---

## 1. Hard constraints (from the official rules; never violate)

- **Deadline:** Fri Oct 23, 2026, 12:00 PT (1:00 p.m. Mountain).
  - Target: submit Wed Oct 21 evening.
  - Thu and Fri are buffer only. No new features.
- **Bee must actually run.** The repo must import and call Bee tech at runtime. We use the `@beeai/cli` library and the `bee` CLI. Mentioning Bee in the README is not enough.
- **The demo uses live Bee data** doing something useful for a person.
  - Synthetic fixtures are for tests only.
  - Fixtures never appear in the demo as if they were real.
- **AWS Builder side prize:** Kiro Crew qualifies on its own. Document exactly how we use it, in the README and in the product feedback.
- **Repo:**
  - Hosted on Henry's GitHub account as **`hturcotte1/Overnight`** (https://github.com/hturcotte1/Overnight), **public**, with an MIT `LICENSE` file visible. Henry created it on Oct 9, 2026; this folder is connected to it as `origin`.
  - README with setup and run steps that actually work.
  - Published apps go in a second public repo, **`hturcotte1/overnight-apps`** (https://github.com/hturcotte1/overnight-apps, see §7). Spike 7 created it on Oct 9, 2026 with GitHub Pages on.
- **Ownership:** the entry must be solely Henry's. No NQB8/Zelcast code, data, accounts or hardware.
- **Video:**
  - Under 3 minutes, public on YouTube or Vimeo, in English.
  - No copyrighted music.
- **Required write-ups:**
  - Project description.
  - Product feedback for **every** tool, API and SDK used.
  - Friction log: optional, but do it. It's worth up to a 10% judging bonus.

## 2. Who it's for and the loop

**Primary user:** a builder (founder, PM, student developer) with more app ideas than time.

1. **Hear.** Bee (Apple Watch app) transcribes conversations. Overnight subscribes to Bee's live event stream and saves every utterance locally the moment it arrives.
2. **Notice.** When a conversation goes quiet, Kiro reads it and decides whether someone voiced a buildable idea for a small app or tool.
3. **Ask.** For a real idea, Overnight creates a Bee to-do with an alarm two minutes out: `💡 Build tonight? <title>`. It buzzes the phone and the wrist (spike 3), provided notifications for Bee are allowed on the iPhone. Nothing buzzes at night: an idea heard between `ASK_CUTOFF` and `DELIVER_TIME` is asked about in the morning.
4. **Approve.** The Bee to-do decides what happens:
   - Ticked complete in the Bee app = approved.
   - Deleted = rejected.
   - Unanswered by the cutoff = expired.
5. **Build.** At 1:00 a.m., Kiro Crew builds each approved idea (max 2 per night) as a static single-page web app.
   - It works from a one-page brief, the only thing it is given, inside Overnight's own sandbox.
   - It runs the app's own build and test as it works, and writes build notes. (The smoke test that decides whether to publish is step 6, not this.)
   - A build that was stopped or cut off (the job was stopped, the Mac restarted) is not a failed build. The next nightly run tries it once more, and nobody is told in between (§6).
6. **Verify and publish.** At 6:30 a.m., Overnight rebuilds each app and runs its smoke test in a headless browser, all inside a sandbox, because an AI wrote that code. Passing builds are screenshotted and published to GitHub Pages.
7. **Deliver.** A Bee to-do carries the link: `☀️ Built overnight: <title> → <url>`. Its alarm buzzes at 7:00 a.m. (`DELIVER_TIME`). Overnight also writes a Bee fact so Bee remembers what was built.
   - The alarm rule, as built: the normal 6:30 run sets the alarm for `DELIVER_TIME`. Any run during quiet hours, or within two minutes of them, also waits for `DELIVER_TIME`. That includes `build-now` used at night.
   - A run in the daytime (a late run, or a daytime `build-now`) has no morning to wait for: its alarm rings two minutes out.
8. **Review.** A local dashboard shows each idea's timeline: heard → asked → approved → built → published.

**Principles:**
- Never build without approval.
- Ask at most 3 times a day, and never during quiet hours (`ASK_CUTOFF` to `DELIVER_TIME`).
- One idea = one small app.
- Credentials are never given to the coding agent, and it works inside a sandbox that keeps the GitHub login, the Bee login and the transcripts out of its reach (§6).
- Approvals that arrive after build time roll to the next night.
- A build that was stopped or cut off gets one more try before anyone is told it couldn't be finished.

**Non-goals:**
- No watchOS or mobile app of our own.
- No hosted multi-user service.
- No backends in generated apps.
- No Alexa, Fire TV or Ring work (stretch ideas only, after M5).

**Outside accounts, kept to a minimum:** Bee, GitHub (Henry already has it) and Kiro Pro. Never add another paid service or account without asking Henry first.

## 3. Architecture

```
Apple Watch (Bee app) ──► Bee cloud ──► Bee live stream (SSE)
                                          │
                               ┌──────────▼──────────┐
                               │ overnight listen    │  launchd, always on
                               │  snapshot → SQLite  │
                               │  detect (Kiro)      │──► bee todos create (ask)
                               │  track approvals    │◄── polls `bee todos get`
                               └──────────┬──────────┘
                                          │ approved idea + brief.md
                               ┌──────────▼──────────┐
                               │ overnight build     │  launchd, 1:00 a.m.: writes brief.md, then starts
                               │  Kiro Crew builds   │  one Crew job per idea, inside our sandbox
                               │  in our sandbox     │  (fallback: kiro-cli headless, also sandboxed)
                               └──────────┬──────────┘
                                          │ workspaces/<id>/dist + BUILD_NOTES.md
                               ┌──────────▼──────────┐
                               │ overnight deliver   │  launchd, 6:30 a.m.
                               │ sandboxed build and │
                               │ smoke test → Pages  │──► bee todos create (7:00 alarm)
                               │ screenshot, report  │──► bee facts create
                               └──────────┬──────────┘
                                          ▼
                                 dashboard (localhost)
```

### Components

One TypeScript repo: Node 22.18+ (we use Node 24 LTS), ESM, npm workspaces. CLI binary name: `overnight`. Node 20 is too old for the current better-sqlite3 and vitest, and 22.18 is the first Node 22 release that runs `.ts` files without a flag, which the spikes rely on.

| Path | What it is |
|---|---|
| `packages/core` | Shared types, config loader, SQLite store (better-sqlite3), logger, idea state machine |
| `packages/bee` | Thin wrapper over `@beeai/cli/lib` (`createBeeClient`) for stream, conversations, to-dos and facts. **All Bee access goes through here.** |
| `packages/listener` | The always-on logic behind `overnight listen`: stream → snapshots → conversation-quiet detection → detector → ask → approval tracking → backfill after a disconnect. Written against the interfaces in `packages/core`, so all its tests run on fakes |
| `packages/cli` | The `overnight` command (see Commands below). Thin wiring only |
| `packages/detector` | Prompt, JSON schema (zod) and golden-set eval for "is this a buildable idea?" Runs through Kiro (`kiro-cli chat --no-interactive` with a no-tools agent), so no extra AI account is needed. Spike 8 showed this works |
| `packages/builder` | Brief writer, the night's build flow, two builder backends (`kiro-crew` primary, `kiro-cli` fallback), the sandbox profiles they run in, and the nightly sandbox check |
| `packages/deliver` | `overnight deliver`: rebuild and smoke-test the app inside our sandbox, publish to GitHub Pages, screenshot, morning Bee to-do, Bee fact, report |
| `apps/dashboard` | Planned for Milestone 3, not built yet: a local web UI (Vite + React) plus a tiny API server reading SQLite |
| `crew/` | Kiro Crew setup: `nightly-job.md` (the build job's message), `build-skill.md` (how to build one Overnight app; installed as a Crew skill), and `README.md` (how a build runs and what it can reach) |
| `launchd/` + `scripts/install-agents.sh` | Four macOS LaunchAgents (background jobs): `listen`, `crew` (the Kiro Crew gateway), `build` and `deliver`. The installer takes a job name, so one job can be changed without touching the others. LaunchAgents don't read shell profiles, so every program is called by its full path. The listener is the job that keeps the Mac awake while it is plugged in |
| `fixtures/` | **Synthetic** transcripts for tests only |
| `docs/` | `spikes.md`, `friction-log.md`, `product-feedback.md`. Planned for the submission: `architecture.md`, `demo-script.md` |

### Commands

Every command is run as `npx overnight <command>` from the repo.

| Command | What it does |
|---|---|
| `listen` | The always-on listener. One per data folder |
| `status [--json] [--check]` | What has been saved, asked, built and delivered; whether the listener and the night jobs are in place; what tonight's build will take. It only reads. `--json` is also what the installer reads (`paused`, `timeZone`, `buildTime`, `deliverTime`, `buildSandbox`). It counts ideas waiting to build (`waitingToBuild`) and how many of those are second tries (`waitingForSecondTry`) |
| `ideas [--json] [--all]` | Today's ideas (or all), with the link once published and the reason if something failed. It says when a cut-off build will be tried once more, and marks rehearsal ideas `[rehearsal]` |
| `queue --approved --json` | The approved ideas for the next build. Empty while paused. (It does not list second tries; `status` counts those) |
| `pause` / `resume` | Quiet mode on or off |
| `build` | Tonight's builds (§6). The `build` job runs it at `BUILD_TIME`. It holds a lock, so a second one refuses to start. While paused it starts no build. Exit code 0 whenever it ran, even if a build failed |
| `deliver` | The morning (§7): verify, publish, tell the wearer. The `deliver` job runs it 30 minutes before `DELIVER_TIME`. It holds its own lock |
| `build-now <ideaId>` | The night and the morning for one idea, right away, for testing and filming. It builds an approved idea (or one whose build failed), and goes straight to verify and publish for one that is already built. It ignores the nightly limit, refuses while paused, and uses the real Bee |
| `preflight` | Twelve checks of what tonight needs, each with a tick or a cross and the fix: not paused, Bee, Kiro, the Kiro Crew gateway, its setting, the build skill, the build sandbox, the GitHub login, the apps repo, the test browser, the three night jobs, and that the gateway job matches `BUILD_SANDBOX`. Exit code 0 only if every check passes. It changes nothing; the sandbox check adds one zero-credit Kiro Crew job and removes it again, and is skipped while a build is running |
| `rehearse new "<title>" "<pitch>"` | Adds one invented idea, already approved and dated yesterday, and prints its id |
| `rehearse run <ideaId> [--no-publish]` | Builds that idea for real, verifies it in the sandbox, publishes it for real (a stand-in with `--no-publish`) and records it as delivered. Bee is always a stand-in: nothing reaches the wrist, and what would have been sent is written to `rehearsal-bee.log` in the data folder |

**Rehearsals never touch the real data** (decided Oct 10). Both `rehearse` commands refuse unless `OVERNIGHT_DATA_DIR` is set on the command itself (a value that only comes from `.env` does not count), and refuse `~/.overnight`, the folder `.env` names, and anything inside either. A rehearsal never loads the Bee package at all. In turn `listen`, `deliver` and `build-now` refuse a data folder that holds a rehearsal idea, so a test idea can never reach the real Bee.

**The background jobs** are installed one at a time: `scripts/install-agents.sh <install | uninstall | restart | status> [listen | crew | build | deliver]`. With no job named, `install` and `restart` act on every job, which also restarts a running listener; name the job to touch only that one. `install crew` also installs the build skill (a different one already there is kept beside it as `SKILL.md.bak-<time>`), makes the folders the gateway must find in place if they are missing (`tmp/build/` in the data folder, `~/workplace/kirocrew-workspace`, four of Kiro's own under `~/.kiro` — `agents`, `sessions`, `settings`, `crew-auth-staging` — and npm's `_cacache` and `_logs`), and waits up to 60 seconds for the gateway to answer. The installer reads Kiro Crew's settings and never changes one.

### Data

Data lives outside the repo and is never committed: `~/.overnight/` (override with `OVERNIGHT_DATA_DIR`).
- `overnight.db` (SQLite)
- `listen.lock`, `build.lock`, `deliver.lock` (each is held while its command runs, so a second listener, build or deliver refuses to start)
- `kiro-detector/` (the detector's own Kiro settings and saved sessions) and `detector-cwd/` (an empty folder it runs in)
- `tmp/detector-eval/` (the same two folders for `npm run eval:detector`, which only ever sends synthetic text)
- `ideas/<id>/brief.md` (a copy of the brief, kept for the dashboard) and `kiro-cli-output.log` (what Kiro CLI printed, when that builder ran)
- `workspaces/<id>/` (starts with only `brief.md`; then what the build agent wrote. A folder from an earlier try is renamed `<id>.old-<time>`, never deleted)
- `tmp/build/` (the build jobs' own temporary folder, private to the user; the only temporary folder a sandboxed build can use, see §6)
- `tmp/build-probe/` (the counts and marks the nightly sandbox check writes)
- `tmp/deliver/<id>/run-…/` (the throwaway folders one verification works in, see §7)
- `pages/` (our clone of the public apps repo; a damaged clone is renamed `<repo>.aside-<time>` and cloned again, never deleted)
- `reports/<id>.json`
- `screenshots/<id>.png` (phone size) and `screenshots/<id>-desktop.png`
- `logs/`:
  - `listen.log`, moved to `listen.log.1` once it passes 10 MB
  - `build.log` and `deliver.log`, the night's and the morning's own logs
  - `listen.launchd.log`, `build.launchd.log`, `deliver.launchd.log`: what each job printed outside its log (a crash, a bad setting)
  - `crew.launchd.log`: what the Kiro Crew gateway printed (its own log is shown by `kirocrew logs`)
- `spikes/` (what the spike scripts saved)
- `rehearsal-bee.log` (only in a rehearsal's scratch data folder: what Bee would have been told)

Overnight's own logs (`listen.log`, `build.log`, `deliver.log`) hold ids, counts, states and our own reasons. Never a title, a pitch or anything that was said.

### Idea states

`heard` → `asked` → (`approved` | `rejected` | `expired`) → `building` → (`built` | `build_failed`) → (`published` | `publish_failed`) → `delivered`

Two steps back are allowed: `build_failed` → `building` (a second try, §6) and `publish_failed` → `published` (publishing again with `build-now`, §7).

### Config

`.env`, with `.env.example` committed:

`GITHUB_PAGES_REPO=overnight-apps`, `OVERNIGHT_DATA_DIR`, `TZ=America/Boise`, `ASK_CUTOFF=23:00`, `BUILD_TIME=01:00`, `DELIVER_TIME=07:00`, `MAX_ASKS_PER_DAY=3`, `MAX_BUILDS_PER_NIGHT=2`, `BUILD_TIMEOUT_MIN=45`, `WRITE_BEE_FACTS=true`, `BUILD_BACKEND=kiro-crew`, `BUILD_SANDBOX=overnight`, `PAUSED=true`

There is no Kiro key in the config. Kiro CLI and Kiro Crew both use the Kiro sign-in on this Mac (Henry's GitHub login, Kiro Pro plan), which takes priority over an API key anyway. One secret fewer to protect.

`overnight pause` and `overnight resume` flip the pause flag, which lives in the database; `PAUSED` in `.env` is only its starting value. While paused, Overnight still listens, saves and runs the detector, but nothing is asked and the build queue is empty. `overnight build` starts no build while paused (it still records a build that was cut off earlier as failed, so that idea is never stuck). The morning's deliver is not paused: an app that is already built is still published and delivered.

**Overnight starts paused** ("quiet mode"). A fresh install never buzzes anyone's wrist until someone runs `npx overnight resume`. An idea heard while paused is recorded but not asked about later.

`OVERNIGHT_DATA_DIR` must be a full path (or start with `~/`), so every command means the same folder wherever it is run from. Only one `overnight listen` can run per data folder; a second one refuses to start.

**Stopping.** On a stop signal the listener closes the stream, waits up to 10 seconds for work in progress, and exits; lines it was still reading stay pending for the next start. The background job is given 30 seconds before macOS kills it.

The night's commands (`build`, `deliver`, `build-now`, `rehearse run`) stop cleanly too. On Ctrl-C, a closed window or macOS stopping the job, they first end what they started (a Kiro Crew run, Kiro CLI, an install, the test browser), which takes up to 10 seconds, then release their lock and exit. They stop waiting after 20 seconds, and a second signal ends them at once. Their background jobs are given 60 seconds. What a stop does to the idea in progress is in §6 (build) and §7 (deliver). If one of these commands hits an error nobody caught, it writes one log line (the kind of error and where, never its message), tells its work to stop, releases its lock and exits with code 1 at once. It waits for nothing on this path, so a Kiro Crew job that was running is not cancelled: it runs on until its own time limit, and the idea is found "interrupted" by the next run (§6).

## 4. Bee integration notes

Checked on Oct 9, 2026 with the real phone and watch (spikes 1 to 4, written up in `docs/spikes.md`). Items that cite a spike or a measurement were seen for real. The rest (stream delivery guarantee and reconnect, `transcript --since`, background media, app IDs, token lifetime) come from Bee's docs and the CLI source and are not tested yet. Where Bee's docs and the real behaviour disagree, this section follows the real behaviour.

**Setup.** The wearer is Henry's dad: the Bee app runs on his iPhone and Apple Watch under his own Bee account.
1. Done: in the Bee iOS app, chose "Try with Apple Watch".
2. Done: tapped **Version** 5 times in Settings to unlock Developer Mode.
3. Done: `@beeai/cli` 0.7.3 is installed globally and as a dependency of this repo.
4. Done: `bee login` prints a link (`https://bee.computer/connect#...`) that is valid for about 5 minutes. We opened it on the Mac, which shows a QR code; Henry's dad scanned it with his iPhone and approved in the Bee app. The token is stored in the macOS Keychain. `spikes/00-bee-login.ts` wraps this so the account holder's name is never printed.
5. Allow notifications for Bee on the iPhone, and test with a throwaway to-do. Checked on Oct 9: the first test alarm showed a notification on the phone but no wrist buzz was noticed (Bee notifications weren't fully on); the second buzzed both the iPhone and the watch. We didn't record what changed in between.
6. Check the login with `bee me --json` (exit code 1 when logged out). Don't use `bee status` for this: it exits 0 either way, and it prints the account holder's real name, which must never reach logs or docs.

**The library is a thin wrapper around the `bee` program.** `createBeeClient()` spawns `bee ... --json` and parses the output. By default it looks `bee` up on `PATH`, which background jobs don't have, so `packages/bee` passes `command:` with the full path to the binary in `node_modules/@beeai/cli/dist/platforms/<platform>-<arch>/`. No Bee command has a timeout of its own; `packages/bee` adds one to every call. Flags must be written `--flag value` (not `--flag=value`).

**Live events:**
- Read them with `createBeeClient().sse.streamJson({ types: [...] })`, which runs `bee stream --json` and returns `{ events, close, process }`; `events` is an async iterable of `{ data, raw }`.
- Types we need: `new-utterance`, `new-conversation`, `update-conversation`, `delete-conversation`, `todo-deleted`.
- **Every event we received had a top-level `type` field with the event name** (Bee's docs say there is none). The listener uses one stream with several `--types` and switches on `data.type`; the first real run on Oct 10 confirmed that utterances and conversation events all arrive on it. The first line on a stream is `{ timestamp }` with no `type`; skip it.
- `new-utterance` is `{ type, conversation_uuid, utterance: { id, sample_id, start, end, text, spoken_at } }`. Dedupe by `utterance.id`. Order by `spoken_at`, never by `start` (those offsets reset within a conversation). There is no speaker field.
- Conversation events are `{ type, conversation: { id, conversation_uuid, state, start_time, end_time, ... } }`. States seen: `CAPTURING`, `PROCESSING`, `COMPLETED`. Keep the uuid-to-id mapping: utterances carry only the uuid, commands take only the numeric id.
- **The `COMPLETED` `update-conversation` event carries the whole transcript.** Its `conversation` adds `transcriptions[]`, each with `utterances[]` (`text`, `person_first_name`, `person_id`, ...) and `utterance_chunks[].chunk_text`, next to the filled-in `summary` and `short_summary`. `packages/bee` parses conversation events with a zod schema that keeps only `id`, `conversation_uuid`, `state`, `start_time` and `end_time`. The listener never stores or logs a raw event payload.
- Utterances reach the Mac 1 to 10 seconds after they're spoken during steady talk, and up to about 40 seconds after a pause.
- `bee stream` does not reconnect (from the CLI source at 0.7.3; no stream dropped during the spikes). When it exits, for any reason, the listener restarts it (waiting 1 s, then 2, 5, 15, 30, 60) and backfills.
- A dead connection and a quiet room look the same, because the CLI hides keep-alives. So the listener also reopens the stream after 15 minutes without any event, and after it notices the Mac was asleep.

**Conversations close slowly.** Bee keeps a conversation in `CAPTURING` for about 6.5 minutes after the last word, and a new recording made inside that window is added to the same conversation. So the detector runs on our own quiet timer, over the utterances since its last run, not on Bee's idea of a finished conversation.

**The stream is at-most-once.** Events that happen during a disconnect are lost. On reconnect, backfill with:
- `bee changed --cursor <c> --json` (the next cursor is at `meta.next_cursor`)
- `bee conversations transcript <id> --since <epochMs> --json`
- With no cursor, `bee changed` returns about a day of items with full transcripts. On first start, call it once only to get a cursor, and ignore the items.
- Stored-transcript line ids are different from stream ids, and conversation commands don't return the uuid (extra checks in `docs/spikes.md`). So a recovered line is matched against saved lines by time and text, across all conversations, and the store lets a conversation be known by uuid, by number, or both.

**Short recordings disappear.** Confirmed by spike 2: a 7-word recording reached the stream within 14 seconds, and about 6 minutes later Bee sent `delete-conversation` and the conversation returned `Conversation not found`. We didn't measure the exact threshold.
- So snapshot every utterance the moment it arrives, and never rely on re-fetching.
- A deleted conversation must not delete our snapshot or cancel an idea already heard.

**Live utterances have no speaker label.** `new-utterance` has no speaker field. A name does arrive later, for conversations Bee keeps: the `COMPLETED` `update-conversation` event (about 6.5 minutes after the last word) includes the transcript with `person_first_name` (a real first name, or null) on each utterance, and the stored transcript has the same name as `speaker` (a first name or `Unknown`). Both come too late for the detector. Don't depend on knowing who spoke; the wrist approval is the real gate. Speaker names are personal data: never log them, never store them, never put them in briefs.

**Background media (TV, podcasts) gets transcribed** as if it were real conversation. The detector must flag likely media and skip it.

**To-dos:**
- Create with `bee todos create --text "..." --alarm-at <ISO8601> --json`. Always send the alarm time in UTC ending in `Z`. The reply is a bare object: `{ id, text, alarm_at, completed, created_at, corrections, timezone }`.
- An alarm two minutes out buzzed both the iPhone and the Apple Watch (spike 3).
- Store each ask's to-do id against its idea.
- **Never ask twice.** If `todos create` times out or its reply can't be read, the to-do may still exist. `packages/bee` then looks for it in `bee todos list`; if it still can't tell, the idea is recorded as asked with no to-do id, counts toward the daily limit, and simply expires. Only a clear refusal from Bee is retried.
- **Track answers by polling, not by the stream.** Ticking a to-do in the Bee app produced no `todo-updated` event at all, although `bee todos get <id>` showed `completed: true` when we first checked, about a minute after the tick. (A to-do completed through the CLI showed up in `todos get` within 5 seconds, also with no event.) Poll `bee todos get <id>` every few seconds for each open ask:
  - `completed: true` means approved.
  - Exit code 1 with `Todo not found.` means deleted, which is a rejection. (`todo-deleted` does arrive on the stream and can speed this up.)
  - Any other failure means "unknown, try again", never "rejected".
- Bee also creates to-dos of its own, so only ever act on ids we created.
- The rest of the ask rules, as built:
  - A to-do Bee clearly refuses is tried 3 times, a minute apart, then given up.
  - Quiet hours run from `ASK_CUTOFF` to `DELIVER_TIME`. Neither the ask nor its alarm may fall inside them. Ideas heard overnight are asked on the first pass after `DELIVER_TIME`, up to the daily limit, unless they are more than 12 hours old by then.
  - An ask expires at the next `ASK_CUTOFF`. If that is less than an hour away, it runs until the cutoff after that.
  - An idea held back by the pause flag or the daily limit is not asked later. If it comes up again, it is a new idea.
  - An expired ask leaves its to-do in Bee: Overnight never deletes anything from the wearer's Bee account. Ticking it later does nothing.

**Facts:**
- Use `bee facts list|search|create`. `facts list` returns confirmed facts only; pass `--unconfirmed` for the ones Bee inferred by itself.
- A fact we create is confirmed straight away (spike 4).
- Facts are not read into briefs (§6, The brief): Bee writes them from overheard speech, so they are not our own words.
- Write one fact per delivered build.

**Limits:**
- Third-party hosted apps can't get their own Bee app ID yet. Overnight runs locally under the user's own Developer Mode login. That's allowed, and it goes in the feature requests.
- Tokens don't expire and there's no usage limit (Amazon's FAQ). Still never print or log them. Bee's docs say nothing about token lifetime, so the listener must handle "logged out" by pausing and asking for a new login rather than crashing.

## 5. Detector

**Input:**
- The utterances heard since the detector last ran on that conversation: text and timestamps only.
- Titles of the last 14 days of ideas, for deduplication.

**Output (strict JSON, validated with zod):**
`{ is_idea, confidence, title (≤6 words), pitch (≤40 words), quote (≤25 words, verbatim), said_by_wearer_guess, likely_media, buildable_as_static_web_app, reason }`

**Counts as an idea:** someone wishes for or plans a small software tool, app, site, bot or automation. Examples:
- "someone should build..."
- "I wish there was an app that..."
- "it'd be cool if..."
- "why isn't there a..."

**Not an idea:**
- Complaints with no product in them.
- Discussion of existing products.
- Jokes.
- TV or podcast audio.
- Tasks for a person ("I need to email Sam").
- Anything needing hardware, payments, accounts, scraping, or other people's personal data.

**When it runs:** after 2 minutes with no new utterances. (Bee itself takes about 6.5 minutes to close a conversation, which is too slow to wait for.)

**How it runs** (proved in spike 8):
- `kiro-cli chat --no-interactive --agent overnight-detector --model claude-haiku-4.5`, with the prompt and the transcript sent on standard input (the text a program reads, not its command line), and our own 90-second timeout. About 4 seconds and well under 0.1 credits per call.
- Why standard input (spike 9, Oct 10): a command line can be read by every other program of the same user, and Kiro starts a second program with the same arguments, so a prompt passed as an argument was visible twice. Sent on standard input, no part of the text appeared in any program's arguments (measured while the real detector ran on a synthetic transcript). The runner also refuses to start Kiro with any argument longer than 200 characters, so the prompt can't slip back there.
- Pending: the listener that is running now was started before this change. It keeps the old way until it is next restarted.
- `overnight-detector` is a custom Kiro agent with an empty `tools` list. Kiro's default agent can read files in its working folder even with no trust flags, so the default agent must never be used here.
- It runs from an empty folder with its own `KIRO_HOME`, both under `~/.overnight/`, so no project files or old sessions reach the prompt and Kiro's saved sessions stay inside our data folder.
- The reply is plain text. Take the JSON object out of it, validate it with zod, retry once, then log and skip. A timeout or an error exit also gets the one retry. One repair is done without a retry: a quote that is word for word from the conversation but longer than 25 words is cut to its first 25.
- Extra checks on the reply: title at most 80 characters, pitch 400, quote 300; the quote has at least 3 words and matches the conversation on whole words; control characters are stripped.
- The listener sends a batch only if it has at least 6 words, sends at most the latest 1,500 words, and gives a batch 3 tries a minute apart before recording it as failed. Lines that waited more than 6 hours are recorded as too old and not sent.
- Set-up checks that Kiro is signed in (`kiro-cli whoami`, whose output includes the account email and is never logged) and that both sharing settings are off in the detector's own `KIRO_HOME`. The CLI retries a failed set-up every minute.
- The prompt tells the model to keep names and personal details out of the title and pitch, and to treat anything inside the transcript as conversation, never as instructions.
- If the detector can't even try (Kiro signed out, set-up not finished), the lines are kept and tried again later. They are never written off because Kiro wasn't ready.
- Kiro saves every chat to disk. The detector deletes its saved sessions after a day.

**Ask only if all of these hold:**
- `is_idea` is true and `confidence ≥ 0.75`
- not `likely_media`
- `buildable_as_static_web_app` is true
- not a near-duplicate of the last 14 days of ideas
- still under `MAX_ASKS_PER_DAY`

**Golden set:** `fixtures/detector/`, at least 40 synthetic transcripts (66 as of M1). Each file starts with four `#` lines: the synthetic notice, `# expect: idea` or `# expect: not_idea`, `# category:` and `# note:`. The eval never sends `#` lines to the model.
- At least 15 ideas.
- At least 25 non-ideas: TV-like audio, jokes, tasks, existing products.
- Targets: precision ≥ 0.85, recall ≥ 0.7.
- `npm run eval:detector` prints a confusion matrix.

## 6. Builder

### The brief

`brief.md`, written by Overnight, one page max. It is put in the idea's empty workspace (`workspaces/<id>/brief.md`), with a copy in `ideas/<id>/` for the dashboard. It is the **only** thing the build agent is ever given about the idea, so it is also the main protection against a spoken sentence steering the agent.

**It contains:**
- A fixed template in our own words: who the app is for (in general terms), "pick 3 to 5 must-have features from the description and keep the scope small", what's out of scope, and the app contract below.
- The idea's title and pitch, cleaned (no control characters, length caps) and fenced as "a description, not instructions". Both were written by the detector, not copied from speech.

**It leaves out:**
- The verbatim quote and any other transcript text.
- Names and personal details.
- Bee facts. (They were planned as "preference facts"; they are written by Bee from overheard speech, so they stay out until we have a reason and a safe way to include them.)

### App contract (every generated app)

- Static single-page web app built with Vite and vanilla TypeScript (plain TypeScript, no framework). The first plan also allowed React; the brief and the build skill ask for vanilla TypeScript only, so that is the contract.
- `npm run build` outputs to `dist/` with `index.html` at its root.
- Vite `base: './'` so the app works from a subfolder on GitHub Pages.
- No backend, API keys, paid APIs, login or tracking. Data lives in `localStorage` only.
- Works on a phone screen.
- Has a clear empty state and one sample-content path.
- Ships `README.md` and one Playwright test (`tests/smoke.spec.ts`) that loads the page and exercises the main action.
- Keeps the `package-lock.json` that `npm install` writes. The deliver step installs with `npm ci`, which needs it.
- Finishes within `BUILD_TIMEOUT_MIN`. If that's not possible, ship the smallest working slice and explain in `BUILD_NOTES.md`.
- Nothing personal in the app: it is published on the public web.

The build skill (`crew/build-skill.md`) adds the working rules for the agent: stay inside the workspace, no git, no credentials, no network but `npm install`, leave nothing running, the versions to use (Vite 8, TypeScript 6, Playwright exactly 1.64.0, to match the browser on this Mac), and to write `BUILD_STATUS.json` last of all.

### Backends

**Our own code drives the night.** The build agent never runs the `overnight` command, never sees the database, and never publishes.

`overnight build` runs at `BUILD_TIME` as a launchd job. (If the Mac is asleep at that time, launchd runs the job once on wake. That is Apple's documented behaviour; we have not tested it. If the Mac is off or nobody is logged in, that night is skipped.)
1. Any idea still `building` from a run that was killed is recorded as `build_failed` with the reason "the build was interrupted". "Killed" means it has been building for longer than `BUILD_TIMEOUT_MIN` plus 15 minutes. This happens even while paused, so an idea is never stuck.
2. If paused, stop here.
3. Take the ideas waiting for a build, oldest approval first: approved ideas, plus builds that were stopped or cut off and are due one more try (below). Take up to `MAX_BUILDS_PER_NIGHT` minus builds already started that local day. A second try counts as a start like any other.
4. For each, one at a time: make a slug (the short name in the link) from the title, prepare an empty workspace `~/.overnight/workspaces/<id>/`, write `brief.md`, move the idea to `building`.
5. Run the primary backend. If it fails or can't start, run the other backend once in a fresh workspace. **Before each of those tries, renew Kiro's sign-in outside the sandbox.** Kiro's sign-in lasts about an hour, and Kiro renews it with a secret in the Keychain, which a sandboxed build can't reach (found in the rehearsal on Oct 10: a gateway started inside the sandbox after an idle hour said "You are not logged in"). So our own code asks `kiro-cli whoami -vvv` outside the sandbox first. That renews a sign-in that has run out, and every Kiro program then finds the new one. Kiro has no command to renew early, so when fewer than ten minutes are left, we wait for the sign-in to run out and ask again. If Kiro says it is signed out, the try isn't started and the reason says so. What Kiro prints there names the account; it is read in memory and goes nowhere.
6. Success means: the workspace has `BUILD_STATUS.json` saying `built`, written after the build started, and `dist/index.html` exists. Then the idea is `built`; otherwise `build_failed` with a plain-words reason.

**What a stop does, and the one retry (decided Oct 10).**
- When `overnight build` or `build-now` is told to stop (Ctrl-C, macOS stopping the job, logout), it ends the build in progress within 10 seconds: a Kiro Crew run is cancelled and its job removed; Kiro CLI and everything it started is killed. The idea becomes `build_failed` with the reason "the build was stopped". Nothing further starts.
- A build that was stopped or interrupted is not the idea's fault, so **the next nightly run builds it once more**. It waits in the same line as the approved ideas, in order of approval, and counts toward the nightly limit.
- Each idea gets at most two starts this way, counted by how many times it moved into `building`. If the second start is also stopped, interrupted or fails, the idea stays failed.
- The wearer is told "couldn't finish" only then. Until the second start has ended badly, the morning says nothing about the idea (§7).
- A build that really failed (the agent couldn't make the app, or neither builder could start) is never tried again by the nightly run. Neither is an idea the wearer has already been told about.
- `build-now <id>` is not bound by this: it builds any approved or failed idea when a person asks.
- The rule lives in one place, `packages/core/src/build-retry.ts`. The builder, the deliver step and `status` all ask it.

**Primary: Kiro Crew** (spike 5 and the M2 experiments).
- One Crew job per build, named `overnight-build-<id>`. Its message (`crew/nightly-job.md`) gives the full paths of the brief and the workspace and names the `overnight-build` skill (`crew/build-skill.md`, installed as a Crew skill).
- Flags: `--approval-mode auto` (without it an unattended job is denied every write and command), `--no-persistent-session`, a schedule that is never due, and a time limit of `BUILD_TIMEOUT_MIN`.
- Started with `kirocrew cron trigger <job id>`, which runs within a second. (Crew's own daily schedule starts up to 59 minutes late, and a job that is due refuses a trigger.) Check the reply text, not the exit code.
- Finished when Crew's running-marker file is gone and its history has a row for the job. Crew's "success" only means the session ended; the marker file and our own rebuild decide.
- Before the first Crew build of a run, Overnight:
  - removes jobs of its own that a killed run left on Crew's list. If the list holds a job Overnight did not add, it logs an error and removes nothing, so a person can look;
  - reads Crew's setting and refuses to build with Crew if it is not what `BUILD_SANDBOX` needs;
  - checks that the installed skill is an exact copy of `crew/build-skill.md`. A missing or changed copy means no Crew build;
  - runs the sandbox check (below).
- **Cancel before remove.** The job is always removed afterwards. A run that may still be going is cancelled first, because `kirocrew cron remove` takes a job off the list but does not end a run in progress, and kirocrew has no cancel command. Overnight asks the gateway's own local web address to cancel it (measured: the run's processes were gone within a second).
- In `overnight` mode, Overnight's own `kirocrew` commands run inside the same sandbox profile as the gateway, so nothing of Crew's runs outside the fence at night. They start in `~/.overnight/tmp/build/`, because kirocrew stops with an error when it may not look at the folder it starts in, and the repo is closed to it.
- Real Kiro Crew builds so far: seven, each about 2 to 4 minutes and 2.6 to 4.6 Kiro credits (`docs/spikes.md`). The sixth was the rehearsal on Oct 10, with the real Kiro Crew install. The seventh was the first real night's, started by the nightly launchd job.

**The sandbox around Kiro Crew (Henry's decision, Oct 10).**
- Measured: Crew's own sandbox on macOS, even at `strict`, lets a build job read the GitHub login from the Keychain, use the Bee login, read the transcript database, use the network and write anywhere in the home folder. It can't be given extra paths to hide, and its command jobs don't get `strict` at all.
- So the whole Crew gateway runs inside **our** sandbox (`sandbox-exec` with `packages/builder/sandbox/crew-gateway.sb`), started by our own launchd job (`scripts/install-agents.sh install crew`), not `kirocrew service install`. The job is pointed at its own copy of that profile, `~/.overnight/sandbox/crew-gateway.sb`, which `install crew` makes again every time: macOS does not let a background job whose program is `sandbox-exec` read a file under `~/Documents`, where this repo lives (the first real install on Oct 10 died with "Operation not permitted" for that reason). Everything Crew starts inherits it.
- macOS can't stack sandboxes, and Crew refuses to run jobs inside one it didn't create unless `agent.sandbox_allow_unsandboxed_exec` is `true`. That is the one Crew sandbox setting we change. Crew's own protections are off as a result; ours replace them and cover more of what matters here. The owner sets it with one command. The installer and Overnight only ever read it.
- What the profile does, as built. (The full lists, entry by entry with reasons, are in the profile and in `crew/README.md`.)
  - **Reading and running are refused by default** in the home folder, Overnight's data folder, this repo, the Node.js folder, other disks, `/Users/Shared` and the shared temporary folders. A short list is opened again: Kiro's and Kiro Crew's own folders and programs, `node`, `npm` and `npx`, npm's package store, the Playwright browser, and the three folders a job works in (the build workspaces, the build temporary folder, the sandbox check's results folder).
  - **Writing is limited to a shorter list**: those three folders, Kiro Crew's own folders (its home, and the folder it runs each job in), Kiro CLI's saved sessions and sign-in store, npm's package store and logs, and Kiro Crew's own agent files, by name. Nowhere that programs are installed or started from, and no settings file. Most of these folders must already exist: a job may fill them, not create, move or replace them.
  - **Build jobs have their own temporary folder**, `~/.overnight/tmp/build/`. The gateway job is handed it as `TMPDIR`, and the usual temporary folders are closed, so nothing another program left there is in a job's reach. (Kiro Crew gives each agent a folder of its own under `~/.kiro/crew/scratch/`; the gateway itself and command jobs use ours.)
  - **Other programs are hidden.** A job can't signal another program, ask macOS about it, or read its command line (four rules; `pgrep` finds nothing). It can still do all of that to what it started itself.
  - Also refused: the Keychain, the clipboard, the preferences service, the ssh agent, starting other apps, creating background jobs, `launchctl`, and running `gh` or the Bee program installed on this Mac.
- **Before each night's builds, a zero-credit sandbox check must pass. If it doesn't, nothing is built with Crew that night** and the Kiro CLI builder is used. One Crew command job tries twelve things from where a build agent would run:
  - three reads: the Keychain entry with the GitHub login; Bee as the logged-in user (with a copy of the Bee program that a job is able to run); the transcript database;
  - three lists: `~/Documents`, `~/Library` and `~/.claude`;
  - one look at another program: `pgrep -f` for a harmless stand-in process that Overnight starts outside the sandbox for the length of the check;
  - five writes: a new file in the home folder, this repo, the folder node is in, the folder Kiro Crew's program is in, and `~/Library/LaunchAgents`.

  The job writes only counts and 0/1 marks. Every one must come back 0. A check that can't finish within 3 minutes counts as failed.
- **What the check proves:** the gateway that is running right now was started inside a fence that refuses those twelve things. A gateway started with no profile, or with a loosened one, fails it (tried: a deliberately loosened copy failed and named each opened thing).
- **What it does not prove:**
  - every other rule of the profile. For those there are tests that run the profile for real around harmless commands;
  - anything about the network, which is open, or about the names a Crew job can list (below);
  - anything after the check: it runs once per `overnight build` run, so it says nothing about a gateway that was restarted later the same night;
  - anything about the Kiro CLI builder, which needs no such check: Overnight starts it inside its own profile every time.
- `overnight preflight` runs the same check on its own, through the same code.
- **It is a fence, not a sealed box.** What a Crew job can still reach:
  - the network;
  - every idea's workspace, not only its own. One profile covers every job the gateway starts, so it can't tell one idea from another;
  - all of Kiro's own folder, `~/.kiro`, for reading: Kiro CLI's settings and saved sessions, and Kiro Crew's own private files (the gateway and the agent share one sandbox). Kiro CLI's sign-in store too;
  - npm's package store, which the rest of this Mac shares;
  - the names (only the names) of what is directly inside the home folder, `/Users`, `~/workplace`, `~/.local` and the Node.js folder. Kiro Crew 0.8.0 will not start an agent unless it can open every folder above its own, and the macOS sandbox can't allow opening a folder without letting its names be listed. Nothing behind the names can be opened;
  - the list of programs running on this Mac (names and process numbers, not command lines);
  - macOS's own files outside the home folder.

  §9 says what each of these means. The brief rule above stays load-bearing: what the agent is fed is the first protection, and the sandbox is the second.
- `BUILD_SANDBOX=overnight` selects this. `BUILD_SANDBOX=crew` (Crew's own `strict` sandbox, no check) exists for people who can't or won't switch Crew's sandbox off.
- Proved so far (Oct 10): a real gateway start, the sandbox check and a real agent build all ran under the final profile, with a throwaway Kiro Crew home on another port. **Pending:** the same on the real install (`~/.kiro/crew`), started by launchd.

**Fallback: kiro-cli headless** (spike 6: a hello-world Vite app in 52 seconds for 0.4 credits).
- `kiro-cli chat --no-interactive --model auto --trust-tools read,write,shell "<the skill text + where the brief is>"` inside the workspace, wrapped in our own sandbox (`packages/builder/sandbox/kiro-cli-build.sb`), with our own time limit that kills the whole process group (Kiro has no timeout flag).
- The profile is the same fence as the gateway's, and narrower: the one workspace of this build is the only folder of Overnight's it can see or write, nothing of Kiro Crew's can be reached, and the home folder can't even be listed. Its temporary folder is its own corner of that folder, `~/.overnight/tmp/build/kiro-cli/`, emptied before each build. The rest of `tmp/build/` belongs to the running Kiro Crew gateway and is left alone.
- Before the brief is sent, Overnight asks Kiro (inside the same sandbox) for its two content-sharing settings and refuses to build unless both are off (§9).
- The prompt here is a command-line argument. That is acceptable because it holds only our own words (the skill text and a path), never anything from the idea.
- It uses the Kiro sign-in on this Mac. No API key.
- Never trust the exit code or the agent's own report.
- A real build under the final profile passed on Oct 10: 99 seconds, with `npm install`, the build and the Playwright test all working inside the sandbox.

**Security summary:** the coding agent is never *given* Bee or GitHub credentials, runs inside our sandbox, and is fed only `brief.md`. Code it wrote is only ever run inside a sandbox (§7). Publishing happens only in the deliver step, by our code.

## 7. Deliver

`overnight deliver` runs at `DELIVER_TIME` minus 30 minutes, via launchd. For each `built` idea, one at a time:

1. **Clean copy.** Copy the workspace to a throwaway folder: plain files and folders only (symbolic links are refused), without `node_modules`, `dist`, `.git` or `test-results`, with caps on size and file count (2,000 files, 50 MB). The app must have a `package.json` with a `build` script, a `package-lock.json` and `tests/smoke.spec.ts`.
2. **Verify inside our sandbox** (`packages/deliver/sandbox/deliver.sb`). The agent wrote this code, so it runs where it can read nothing in the home folder but the folders it needs, write only its own run folder, reach no macOS system service (so no Keychain, clipboard or app launching) and no network but two local ports. It can't see other programs either: not their command lines, and not even the list of what is running.
   - `npm ci` (offline against the npm cache; if a package is missing, once more through the registry-only proxy below), then `npm run build`.
   - Take `dist/` out of the build's reach, copy it ourselves as plain files, and check the copy (below). From here on that copy, `site/`, is what is tested and what is published.
   - Serve `site/` on a local port and run our own contract test in the Chromium headless shell: the page loads, shows content, has no console errors or failed requests, talks to nothing but this Mac, and works at phone size. Take a phone and a desktop screenshot.
   - Run the app's own `tests/smoke.spec.ts` against a second copy of the same server, with our Playwright and our settings. The app's own Playwright settings file is never used.
3. If it passes:
   - Copy `site/` into `<slug>/` in a local clone of Henry's public `overnight-apps` repo (GitHub Pages turned on, serving branch `main` from `/`), add `<slug>/overnight.json` with a marker unique to this publish, then commit (as "Overnight", with the GitHub no-reply address) and push using his GitHub CLI login. Never a force push.
   - The repo root must keep its `.nojekyll` file. Without it GitHub Pages drops files whose names start with `_` (spike 7).
   - The link is `https://hturcotte1.github.io/overnight-apps/<slug>/`. Poll `<link>overnight.json` every 5 seconds, for up to 10 minutes, until it shows this publish's marker (spike 7 measured 20 to 60 seconds), then move the idea to `published`.
   - Everything published is public, which is why briefs never contain personal details.
   - Create a Bee to-do `☀️ Built overnight: <title> → <url>` and move the idea to `delivered`. Its alarm follows the rule below.
   - Write the Bee fact, if enabled.
   - Write the report JSON.
4. If it fails:
   - Set state to `publish_failed` with a plain-words reason.
   - Create a Bee to-do `🌙 Couldn't finish <title>, details on the dashboard`, once.
   - The morning run does not try a `publish_failed` idea again. Only `overnight build-now <id>` verifies and publishes it again.
5. Ideas that failed to build (`build_failed`) get that same 🌙 to-do, once, so the wearer isn't left waiting. **The exception (decided Oct 10):** a build that was stopped or cut off, and still has its second start left (§6), is not a failure yet. The morning says nothing about it. The wearer is told only when the second start has also ended badly. If the number of starts can't be read, that run stays silent about a stopped or cut-off build (a build that really failed is still told): a missed note can be made up for, a wrong buzz can't be taken back.

Running deliver twice never publishes twice or buzzes twice. Before Bee is asked for a to-do, a mark is saved on the idea; if Bee's reply is lost, or Overnight is stopped at that moment, no second to-do is ever made. Delivery of something already built still happens while Overnight is paused; only asking and building stop.

**The alarm rule, as built.** It is the same for the ☀️ and the 🌙 to-do.
- The normal run, half an hour before `DELIVER_TIME`, sets the alarm for `DELIVER_TIME`.
- Nothing buzzes at night. A run at any time in quiet hours (`ASK_CUTOFF` to `DELIVER_TIME`), or so close to them that an alarm two minutes out would land inside, also waits for `DELIVER_TIME`. That includes `build-now` late in the evening.
- A late run, or `build-now` during the day, has no morning to wait for: its alarm rings two minutes out, the same notice the ask uses.
- One more case, which the default settings never reach: outside quiet hours, a run less than two hours before `DELIVER_TIME` also waits for it. (It only matters if quiet hours are set very short or switched off.)

**The verification layout.** Each verification gets a fresh folder, `~/.overnight/tmp/deliver/<id>/run-…/`, with a new name every time:

| Folder | What it is |
|---|---|
| `build/` | A "box" for the install and the build: a clean copy of the workspace, and one scratch folder per command |
| `dist-built/` | `dist` as the build left it, after it was moved out of the build's reach and before our copy |
| `site/` | **Our** copy of `dist`. What is tested is what is published, and no sandbox can change it |
| `harness-contract/` | Our static server and our contract test, and nothing else |
| `harness-smoke/` | Our server and our settings, plus the app's own smoke test |
| `contract/`, `smoke/` | Boxes for the two browser steps: an empty work folder and a scratch folder each |
| `logs/` | What each step printed, for debugging. No sandbox can see it |

- A "box" is a folder only our own code can create. While a step runs, its box is read-only, and it is renamed away when the step is done. The reason: a sandboxed program can replace the very folder it is allowed to write with a link to somewhere else (tried, it works), and our own code would then follow that link with full rights.
- Every sandboxed command gets temporary and results folders of its own, made fresh for it. Playwright keeps compiled copies of tests in its temporary folder, so sharing one would let the app's build decide what our test does.
- After the install and the build, everything they wrote counts as hostile. Only `dist` is carried forward.
- Our contract test runs from a folder that holds our files only. The app's tests go in the other harness folder, so a file the app ships can never run as part of our test.
- After each step Overnight looks for programs the step left running and kills them. One found outside the step's own process group, or not confirmed gone, fails the verification. (The test browser's own helper processes are expected there, and are simply killed.) A program that hides on purpose can get past this search; taking the step's folders away is what keeps it from touching what is published.
- Our copy of `dist` must have `index.html`, plain files only, at most 500 files and 20 MB, and no file whose name changes what git does (`.git`, `.gitignore`, `.gitattributes`, `.gitmodules`). It is also searched for this Mac's name and the path of the home folder; a hit stops the publish. That search catches accidents, not text hidden on purpose. (A factory name such as "MacBook Pro" names nobody and is not searched for, and neither is anything shorter than four characters.)

**The registry-only proxy.** The macOS sandbox can't limit the network by host name, only by local port. So sandboxed `npm ci` is allowed one extra local port, and a small proxy in our own process, outside the sandbox, decides where it leads: `registry.npmjs.org` on port 443 and nowhere else. It only passes encrypted bytes along and keeps counts. It is started only when the offline install says a package is missing from the cache.

**Publishing uses the GitHub CLI's stored login and nothing else.**
- `git` and `gh` get a short, fixed environment: the home folder, the `PATH` and, when set, where `gh` keeps its login. Tokens in `GH_TOKEN` or `GITHUB_TOKEN` are deliberately not passed on. No token is read, printed or stored by our code.
- Every git command runs with hooks, signing and ignore lists switched off. The commit's name and address are set for each command and checked again on the finished commit before anything is pushed.
- The staged files are compared, byte for byte, with the verified ones.
- Our clone is disposable. If it is cut off, locked or damaged it is renamed aside (never deleted) and cloned again.
- Publishing is safe to repeat: a folder in the clone that carries this idea's id is replaced with the new version and a new marker.

**Pushed but not seen live (decided Oct 10).** If the push went through but the page was not seen serving this build before the 10-minute wait ran out, that is not a failure. GitHub Pages usually catches up a little later. The idea is recorded as `published` and the wearer is told as usual, with a note on the idea and `confirmedLive: false` in the report saying the page was not confirmed. The honest limit: the page is never looked at again on later mornings. If Pages is switched off or its own build failed, the wearer has a dead link until someone notices. (One small gap: if Bee's reply to the to-do is then lost, the note on the idea is replaced by the lost-reply note. The report and the idea's timeline still say the page was not confirmed.)

**What a stop does.** On a stop signal the step in progress is ended, its programs are killed, and the command answers within 10 seconds.
- Stopped while verifying or publishing: the idea stays `built` and the next run verifies and publishes it again. If the push may already have reached GitHub, a note on the idea says so, and the next run replaces that version cleanly.
- Stopped while Bee was being asked for the to-do: the saved mark stays, so the next run closes the idea without asking Bee a second time.

**Not yet run for real** (§10): the real publisher against GitHub, the real wait for Pages, the real morning Bee to-do and fact, and this job under launchd. The publisher has only pushed to a stand-in repo on this Mac, with the real `git` program. The verifier has run for real, many times, on apps a Kiro agent built in the experiments (about 5 seconds each with a warm npm cache).

## 8. Dashboard

Planned for Milestone 3; not built yet. Local only: `npm run dashboard` → `http://localhost:4321`.

**Views:**
- **Today:** live view of what Overnight heard, asked and had approved.
- **Ideas:** each idea's timeline with quote, brief, build notes, screenshot and link.
- **Nights:** per-night summary.
- **Settings:** read-only config.

It's the main visual in the demo video, so it must look good: clean, phone-friendly, light and dark modes.

**`overnight build-now <id>`** (built in Milestone 2) runs the same pipeline immediately, for testing and filming. If it's used in the video, say so on screen. It uses the real Bee, so in the daytime the wrist buzzes two minutes after it finishes (§7). To try the pipeline without reaching anyone, use `overnight rehearse` on a scratch data folder (§3).

The report the dashboard will read (`reports/<id>.json`) already carries what each check found, the timings, the two screenshots, `confirmedLive` (true, false, or not known) and the idea's note.

## 9. Privacy and safety

- All transcripts stay in `~/.overnight`. Only the detector's Kiro call and the one-page brief leave the machine. Published apps are public.
- Kiro may use prompts from individual accounts to improve its service unless that's switched off. Henry had both settings switched off on Oct 9 (`codeWhisperer.shareCodeWhispererContentWithAWS` and `telemetry.enabled`, in the default settings folder and the detector's own `KIRO_HOME`). The detector checks both are `false` at start-up and refuses to send real text otherwise. The Kiro CLI builder makes the same check before every build. A Kiro Crew build does not check them itself: it relies on the default settings folder, which a build job cannot write.
- The detector's prompt goes to Kiro on standard input, never on the command line, so it can't be read from the list of running programs (§5). Pending: the listener that is running today was started before that change and keeps the old way until it is restarted. The build and deliver sandboxes refuse reading other programs' command lines either way.
- Never commit any of these:
  - Bee data or transcripts
  - Real names
  - Screenshots of real conversations
  - `.env`
  - anything in `~/.overnight`
- Fixtures are synthetic and say so on their first line.
- Bee hears everyone nearby. The README tells users to let people know. The demo only shows people who agreed to be filmed.
- Kiro Crew runs inside Overnight's own sandbox, with its own sandbox switched off because the two can't be stacked, and build jobs alone run with `--approval-mode auto` (Henry's decisions of Oct 9 and Oct 10; see §6). A nightly check proves the GitHub login, the Bee login and the transcripts are out of the build agent's reach. Change no other Crew setting.
- Code an agent wrote is only ever run inside a sandbox, at build time and at verify time.
- A rehearsal can never reach Bee, and refuses the real data folder (§3).

### What a build job can and cannot reach

Measured on Oct 10 with the final sandbox profiles (§6). "Build job" means the build agent and anything it starts. The entry-by-entry lists are in `crew/README.md`.

**Out of reach, with either builder:**
- The GitHub login. The Keychain is cut off, the `gh` program can't be run, and its settings folder is closed.
- The Bee login. Even a copy of the Bee program that a job is able to run is refused.
- What Bee heard: the database, Overnight's logs, the detector's saved Kiro sessions, and the rest of the data folder apart from the folders a build works in.
- What a person keeps in the home folder: `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library` (other programs' data, browser profiles), `~/.ssh`, `~/.config`, this repo and its `.env`.
- Claude Code's own files (`~/.claude` and its scratch folders), which have held test output with real Bee data in it.
- The shared temporary folders. A build has one temporary folder of its own.
- Other programs: no signals to them, and no reading their command lines.
- Writing anywhere a program is installed or started from, or a setting is read from: `~/.local`, the Node.js folder, `/Applications`, this repo, the shell start-up files, `~/.gitconfig`, `~/Library/LaunchAgents`, Kiro's settings.
- The clipboard, the ssh agent, starting other apps, creating background jobs.

**The limits that remain.** Nothing below has been used against us, and each needs an agent that misbehaves. They are written down so that nobody reads "sandboxed" as "sealed".

1. **The network is open** during a build. The agent needs Kiro's model service and the npm registry, and the macOS sandbox can't filter by host name. Anything a job can read, it could send. That is why the list above matters, and why a brief holds no personal details.
2. **Another idea's workspace** (Kiro Crew builder only). One profile covers every job the gateway starts. A Crew job can read and change any folder under `workspaces/`: another idea's brief (a cleaned title and pitch), or an app built earlier the same night. A changed app is still verified in the morning before anything is published, but it would go out under the other idea's name. The Kiro CLI builder sees its own workspace only.
3. **The shared npm package store** (`~/.npm/_cacache`). A build can write to it, and every other `npm` run on this Mac reads from it. By reasoning, not demonstrated: a later `npm` or `npx` run outside a sandbox would trust what a build left there.
4. **Kiro's own files.** A build can read and write Kiro CLI's sign-in store and its saved sessions in `~/.kiro/sessions` (where Kiro CLI saves chats that were run without a folder of their own; the detector's are kept in Overnight's data folder and stay closed). A Crew job can read all of `~/.kiro`, including Kiro Crew's private files and the secret the gateway uses for its local web address, so it could add Crew jobs of its own. Overnight logs an error, and removes nothing, when Crew's list holds a job it did not add.
5. **Names in the home folder** (Kiro Crew builder only). A Crew job can list the names directly inside the home folder, `/Users` (the account names on this Mac), `~/workplace`, `~/.local` and the Node.js folder. It can't open what the names stand for. Kiro Crew will not start an agent otherwise (§6). Accepted on Oct 10: names only, nothing behind them, and Kiro Crew stays the first builder (it is the tool this entry is built on).
6. **The list of running programs.** A build job can see which programs are running: names and process numbers (over 900 entries when counted on Oct 10), not command lines. The deliver sandbox refuses this as well; the build sandboxes don't yet. Adding the same rule there is untested (Kiro Crew may need the list to manage its jobs), so it is left for the hardening in Milestone 3, to be tried with a real build.
7. **This Mac's name** is readable in every sandbox, and a Mac's name often holds its owner's first name. (Refusing it makes Node 24 stop at once.) The deliver step searches the built app for it before publishing, which catches accidents, not text hidden on purpose.
8. **macOS's own files** outside the home folder stay readable (`/Applications`, `/Library`, `/System`, `/usr`, `/private/etc`), so a job can tell which apps are installed.
9. **The nightly check tries twelve things, once per run.** It does not prove every rule, and it does not cover the Kiro CLI builder. Tests run both profiles for real for the rest.
10. **The brief still goes to Kiro's model service** to be built, and the finished app is public. Both hold only a title and a pitch that the detector wrote, with names left out.

**At verify time the fence is tighter** (`packages/deliver/sandbox/deliver.sb`, §7). Agent-written code can read only its own copy of the app, our test files, `node`, `npm`, `npx`, Playwright and its browser, and npm's package store. It can write only its own run folder. It reaches no macOS system service at all, no network but two local ports, and no information about any other program, not even the list. What remains there: a program that hides on purpose can stay running inside that sandbox after its step. It can no longer change what is published, because the folders it could write are taken away.

**Still pending.** All of this was measured with a throwaway Kiro Crew home, started by hand. The real install, started by launchd, gets its first check when the gateway job is installed (§10).

## 10. Milestones

Dates are targets. A milestone ends when its checks pass and the docs are updated.

**M0: Spikes (Fri Oct 9 – Sat Oct 10).** Prove each outside piece before building on it. **All eight spikes ran on Oct 9; results are in `docs/spikes.md`.** (A ninth was added on Oct 10.) Four decisions came out of them, and four more out of the Milestone 2 fix rounds; they are listed, with what was decided, in that file.
- One script per spike in `spikes/`. Results go in `docs/spikes.md`.
- Henry doesn't use Terminal. Claude Code runs everything and asks Henry for phone, watch and account steps one at a time.
- Every surprise goes in `docs/friction-log.md`.

The spikes:
1. Bee is logged in (`bee me --json` exits 0; not `bee status`, see §4). `bee stream --json` prints live utterances from an Apple Watch recording. Note the latency.
2. A recording under about 50 words: does it show up in the stream? Does it vanish later?
3. `bee todos create --alarm-at` set 2 minutes out:
   - Does it buzz the watch?
   - When it's ticked in the Bee app, does `todo-updated` arrive with `completed: true`?
4. `bee facts list` and `bee facts create` work.
5. Kiro Crew is installed and `kirocrew doctor` comes back clean. A scheduled test job runs a shell command at a set time.
6. `kiro-cli chat --no-interactive` builds a hello-world Vite app in an empty folder.
7. Publishing a hello-world `dist/` folder to a public `overnight-apps` repo with GitHub Pages turned on gives a working link.
8. `kiro-cli chat --no-interactive` (no tools) returns valid detector JSON for a few synthetic transcripts.
9. Added on Oct 10, during the Milestone 2 fix rounds: `kiro-cli chat --no-interactive` reads its whole prompt from standard input, so the prompt need not be on the command line. Passed.

**M1: Hear, notice, ask (Sat Oct 10 – Sun Oct 11).** **Built on Oct 9 and running as a background job in quiet mode.** Tests, typecheck, lint and the golden set pass. On Oct 10 the whole listening half ran for real: speech heard, an ordinary conversation judged not an idea, a spoken idea detected, the wrist asked, the tick seen, the idea queued (see `docs/spikes.md`). Asking has been on since then. Not yet tried with real speech: a rejection and an expiry.
- `overnight listen` runs under launchd and snapshots to SQLite.
- It survives disconnects (backfill).
- It detects ideas, asks via Bee to-do, and tracks approve, reject and expire.
- The detector golden set meets its targets. Unit tests are green.

**M2: Build and deliver (Mon Oct 12 – Tue Oct 13).** **Built on Oct 10, ahead of plan. Rehearsed for real on the evening of Oct 10. The first real night, Oct 10 to 11, worked end to end.** Tests, typecheck and lint pass (1,478 tests on Oct 10).
- Brief writer.
- Kiro Crew nightly job plus the kiro-cli fallback.
- Deliver step: smoke test, GitHub Pages, morning to-do, Bee fact.
- Also built: `build-now`, `preflight`, `rehearse`, the installer's four jobs, the three sandbox profiles and the nightly sandbox check.
- Proved for real so far, all on scratch data folders (`docs/spikes.md`):
  - five Kiro Crew agent builds and one sandboxed Kiro CLI build of an invented brief, the last of each under the final sandbox profiles;
  - the sandbox check, passing against a gateway inside our profile and failing against a loosened one;
  - the verifier, on agent-built apps, including apps made to misbehave;
  - stop signals during a build and during a deliver;
  - the morning flow with a stand-in for Bee and for the publisher.
- **The rehearsal, Oct 10, 10:43 pm** (`docs/spikes.md`, "The rehearsal"): an invented idea, "Practice Dice Roller", with the real Kiro Crew install inside our sandbox and a scratch data folder. Built by Kiro Crew in 2 min 19 s for 3.09 credits; checked in the deliver sandbox in 5 s; pushed by the real publisher as "Overnight" with the noreply address; live on GitHub Pages 21 s later; recorded as delivered. Bee was a stand-in. Two more invented ideas went through the Kiro CLI builder to "delivered" without publishing, one of them started by launchd the way the night jobs are.
- **Also proved on Oct 10:** the Kiro Crew gateway runs from its installed launchd job inside our sandbox, and `overnight preflight` ticks every line it can before the build and deliver jobs are installed, both from a shell and as a launchd job (the sandbox check included).
- **Two things only the real set-up could show, both fixed the same evening:**
  - Kiro's sign-in lasts an hour and cannot be renewed from inside the build sandbox, so our own code now renews it outside the sandbox before every build (§6).
  - macOS does not let a background job whose program is `sandbox-exec` read a file under `~/Documents`, so the gateway job is pointed at its own copy of the sandbox profile in the data folder (§6).
- **The first real night, Oct 10 to 11** (`docs/spikes.md`, "The first real night"). The idea was heard through Bee on the morning of Oct 10 and approved on the wrist. That night the build job started by itself, renewed Kiro's sign-in, passed the sandbox check, and Kiro Crew built the app in 160 s for 4.59 credits, with a gateway that had been idle for three hours. In the morning the deliver job checked it in the sandbox (6.6 s), published it (live after 26 s), created the real Bee to-do with the link and wrote the Bee fact. Both jobs ended with exit code 0. Nobody touched the Mac in between.
- **One thing was off: both jobs ran exactly an hour late** (2:00 and 7:30 instead of 1:00 and 6:30), so the alarm was set for about 7:32 instead of 7:00. macOS's scheduler was still working in the time zone the Mac had when it last restarted (the zone was changed a day later). A restart fixes it. Making Overnight's own code decide when it is time, instead of trusting macOS's calendar, is Milestone 3.
- **Confirmed by the wearer:** the watch buzzed at 7:32 am and the to-do said the app was built.
- **Still pending:** a night with the Mac's scheduler in the right time zone (after a restart).
- **Found by the independent check on Oct 10 and left for Milestone 3** (none blocks a night; `docs/spikes.md` has the list): a build job can still read the list of running programs and connect to other programs' local sockets and local ports; a Kiro Crew job can read and change Kiro Crew's own settings and another idea's workspace; the rehearsal's "not the real folder" rule can be got round by typing the folder in an unusual spelling; a brand-new Kiro install needs one Kiro command run outside the sandbox before the gateway can start an agent; `git` does not run inside the build sandboxes.
- **Decided Oct 10:** a Kiro Crew job listing the names in the home folder is accepted (§9, limit 5). Hiding the list of running programs from the build sandboxes waits for Milestone 3, where it can be tried with a real build (§9, limit 6).

**M3: Dashboard and hardening (Wed Oct 14 – Fri Oct 16).**
- Dashboard.
- Re-runs are safe to repeat. (Built in M2 for build and deliver.)
- Timeouts and cost caps. (Timeouts are built; there is no cost cap beyond `MAX_BUILDS_PER_NIGHT`.)
- `build-now`, `pause` and `resume`. (Already built, in M2 and M1.)
- README setup works from a clean clone (with fixtures).

**M4: Real nights and filming (Sat Oct 17 – Sun Oct 18).**
- Run every night on real ideas and fix what breaks.
- Film the demo footage.
- Optional: one meaningful pull request to `bee-computer/bee-cli`, fixing a real gap we hit, with a test. It goes toward the Open Source side prize.

**M5: Submission (Mon Oct 19 – Wed Oct 21).**
- Video, Devpost description, product feedback and friction log.
- README polish with an architecture diagram.
- MIT license visible.
- **Submit Wednesday night.**

## 11. Demo video (aim for 2:50)

- **0:00** Morning. The watch buzzes and a link opens a working app nobody typed. "I said this out loud yesterday."
- **0:15** Yesterday at lunch. A real conversation where the idea comes up naturally. Everyone on camera agreed.
- **0:35** Wrist: "💡 Build tonight?" → tick.
- **0:50** Night. The dashboard timeline, with Kiro Crew working (sped up).
- **1:30** Morning delivery: to-do buzz, link, the app in use on the phone.
- **1:55** How it works: Bee stream → Kiro detector → wrist approval → Kiro Crew → verify + GitHub Pages → Bee to-do + fact.
- **2:25** Why it matters, plus the guardrails: approval gate, transcripts stored only on the Mac, publishing kept out of the coding agent. (Add "sandboxed agents" back only after the M2 test proves it.)
- **2:45** Close: "Say it at lunch. Use it at breakfast."

## 12. Submission checklist

- [ ] Devpost: track **Bee**; side challenge **AWS Builder** (also Open Source if the PR happens)
- [ ] Text description: what it does, how it works, who it's for
- [ ] Public GitHub repo, MIT license visible, working README, no personal data
- [ ] Video under 3 minutes, public, English
- [ ] Product feedback for each tool: Bee CLI and stream, Bee to-dos and facts, Kiro Crew, Kiro CLI, GitHub Pages, Playwright
- [ ] AWS Builder: describe Kiro Crew use inside the product feedback answer
- [ ] Friction log entries: task, steps, expected vs. actual, severity, workaround, suggestion
- [ ] Feature requests, for example:
  - hosted third-party Bee app IDs
  - keep short recordings
  - a reliable "this is the wearer" speaker label
