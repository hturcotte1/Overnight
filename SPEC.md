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
   - It works from a one-page brief.
   - It runs the app's own build and test as it works, and writes build notes. (The smoke test that decides whether to publish is step 6, not this.)
6. **Verify and publish.** At 6:30 a.m., Overnight runs each build's smoke test in a headless browser. Passing builds are published to GitHub Pages and screenshotted.
7. **Deliver.** At 7:00 a.m., a Bee to-do alarm buzzes: `☀️ Built overnight: <title> → <url>`. Overnight also writes a Bee fact so Bee remembers what was built.
8. **Review.** A local dashboard shows each idea's timeline: heard → asked → approved → built → published.

**Principles:**
- Never build without approval.
- Ask at most 3 times a day, and never during quiet hours (`ASK_CUTOFF` to `DELIVER_TIME`).
- One idea = one small app.
- Credentials are never given to the coding agent. (Closing the remaining gap is the first task of M2; see §6.)
- Approvals that arrive after build time roll to the next night.

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
                               │ Kiro Crew nightly   │  Crew job, started at 1:00 a.m. by our launchd timer
                               │ builds in sandbox   │  (fallback: kiro-cli headless)
                               └──────────┬──────────┘
                                          │ workspaces/<id>/dist + BUILD_NOTES.md
                               ┌──────────▼──────────┐
                               │ overnight deliver   │  launchd, 6:30 a.m.
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
| `packages/cli` | The `overnight` command: `listen`, `status`, `ideas`, `queue --approved --json`, `pause`, `resume`. Thin wiring only |
| `packages/detector` | Prompt, JSON schema (zod) and golden-set eval for "is this a buildable idea?" Runs through Kiro (`kiro-cli chat --no-interactive` with a no-tools agent), so no extra AI account is needed. Spike 8 showed this works |
| `packages/builder` | Brief writer and two builder backends: `kiro-crew` (primary) and `kiro-cli` (fallback) |
| `packages/deliver` | `overnight deliver`: Playwright smoke test, publish to GitHub Pages, screenshot, morning Bee to-do, Bee fact, report |
| `apps/dashboard` | Local web UI (Vite + React) plus a tiny API server reading SQLite |
| `crew/` | Kiro Crew setup: `nightly-job.md` (the job's prompt, passed to `kirocrew cron add`), `build-skill.md` (how to build one Overnight app), setup notes |
| `launchd/` + `scripts/install-agents.sh` | macOS LaunchAgents for `listen`, `deliver`, the build trigger and the fallback build; keeps the Mac awake while plugged in. LaunchAgents don't read shell profiles, so every program is called by its full path |
| `fixtures/` | **Synthetic** transcripts for tests only |
| `docs/` | `spikes.md`, `friction-log.md`, `product-feedback.md`, `architecture.md`, `demo-script.md` |

### Data

Data lives outside the repo and is never committed: `~/.overnight/` (override with `OVERNIGHT_DATA_DIR`).
- `overnight.db` (SQLite)
- `listen.lock` (held by the running listener, so a second one refuses to start)
- `kiro-detector/` (the detector's own Kiro settings and saved sessions) and `detector-cwd/` (an empty folder it runs in)
- `tmp/detector-eval/` (the same two folders for `npm run eval:detector`, which only ever sends synthetic text)
- `ideas/<id>/brief.md`
- `workspaces/<id>/`
- `reports/<id>.json`
- `screenshots/<id>.png`
- `logs/` (`listen.log`, moved to `listen.log.1` once it passes 10 MB; `listen.launchd.log` only catches crashes)

### Idea states

`heard` → `asked` → (`approved` | `rejected` | `expired`) → `building` → (`built` | `build_failed`) → (`published` | `publish_failed`) → `delivered`

### Config

`.env`, with `.env.example` committed:

`GITHUB_PAGES_REPO=overnight-apps`, `OVERNIGHT_DATA_DIR`, `TZ=America/Boise`, `ASK_CUTOFF=23:00`, `BUILD_TIME=01:00`, `DELIVER_TIME=07:00`, `MAX_ASKS_PER_DAY=3`, `MAX_BUILDS_PER_NIGHT=2`, `BUILD_TIMEOUT_MIN=45`, `WRITE_BEE_FACTS=true`, `PAUSED=true`

There is no Kiro key in the config. Kiro CLI and Kiro Crew both use the Kiro sign-in on this Mac (Henry's GitHub login, Kiro Pro plan), which takes priority over an API key anyway. One secret fewer to protect.

`overnight pause` and `overnight resume` flip the pause flag, which lives in the database; `PAUSED` in `.env` is only its starting value. While paused, Overnight still listens, saves and runs the detector, but nothing is asked and the build queue is empty.

**Overnight starts paused** ("quiet mode"). A fresh install never buzzes anyone's wrist until someone runs `npx overnight resume`. An idea heard while paused is recorded but not asked about later.

`OVERNIGHT_DATA_DIR` must be a full path (or start with `~/`), so every command means the same folder wherever it is run from. Only one `overnight listen` can run per data folder; a second one refuses to start.

**Stopping.** On a stop signal the listener closes the stream, waits up to 10 seconds for work in progress, and exits; lines it was still reading stay pending for the next start. The background job is given 30 seconds before macOS kills it.

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
- **Every event we received had a top-level `type` field with the event name** (Bee's docs say there is none). Plan on one stream with several `--types` and switch on `data.type`; M1 starts by checking that one stream behaves like the per-type streams the spikes used. The first line on a stream is `{ timestamp }` with no `type`; skip it.
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
- Read preference facts (stack, design taste) into briefs, but only once the M2 credential test passes (§6, Security). Until then facts stay out of briefs: Bee writes them from overheard speech, so they are not our own words.
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
- `kiro-cli chat --no-interactive --agent overnight-detector --model claude-haiku-4.5 "<prompt + transcript>"`, with our own 90-second timeout. About 4 seconds and well under 0.1 credits per call.
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

`ideas/<id>/brief.md`, written by Overnight, one page max.

**It contains:**
- Title, pitch and the verbatim quote.
- Who the app is for.
- 3 to 5 must-have features.
- What's out of scope.
- The user's relevant Bee preference facts (left out until the M2 credential test passes; see Security below).
- The app contract below.

**It leaves out:**
- Any other transcript text.
- Other people's names.

### App contract (every generated app)

- Static single-page web app built with Vite (vanilla TS or React).
- `npm run build` outputs to `dist/` with `index.html` at its root.
- Vite `base: './'` so the app works from a subfolder on GitHub Pages.
- No backend, API keys, paid APIs, login or tracking. Data lives in `localStorage` only.
- Works on a phone screen.
- Has a clear empty state and one sample-content path.
- Ships `README.md` and one Playwright test (`tests/smoke.spec.ts`) that loads the page and exercises the main action.
- Finishes within `BUILD_TIMEOUT_MIN`. If that's not possible, ship the smallest working slice and explain in `BUILD_NOTES.md`.

### Backends

**Primary: Kiro Crew.** One scheduled job, created once with `kirocrew cron add` (its prompt is the text of `crew/nightly-job.md`). When started it:
1. Runs `overnight queue --approved --json`, once. The queue is empty while Overnight is paused, and holds at most `MAX_BUILDS_PER_NIGHT` ideas, oldest approval first, so both rules are kept by code and not by the job's prompt. (The cap is per call: M2 must read the queue once a night, or make the queue count that night's builds.)
2. Builds each idea in `~/.overnight/workspaces/<id>/`, following `crew/build-skill.md`.
3. Runs `overnight mark-built <id>` or `overnight mark-failed <id> --reason "..."`.

What spike 5 changed:
- **Our own timer starts the job.** Crew delays daily jobs by a random 0 to 59 minutes (seen in spike 5) and, per its source, skips a run if the Mac is asleep (not tested). So a launchd timer at `BUILD_TIME` runs `kirocrew cron trigger <job id>`, which starts the job within a second; launchd should catch up after a wake (per Apple's docs, not tested). The Crew job's own schedule must never be due at `BUILD_TIME`: a job that is already waiting out its random delay answers `cron trigger` with `Error: HTTP 409` and still exits 0. Which schedule the real job gets is settled in M2. The trigger wrapper checks for the `Triggered job:` reply, not the exit code.
- **Approvals (decided Oct 9).** Under Crew's default approval settings our unattended agent job was denied the one file write and the one shell command it tried (and was still recorded as a success). Crew's default agent config pre-approves only reading tools, so such a job can look but not build. Crew's documented setting for unattended jobs is the per-job flag `--approval-mode auto`. Henry's decision: the nightly build job, and only that job, gets that flag, and Crew's sandbox is raised to its `strict` level at the same time. Crew's deny rules stay on. M2 starts with a test that shows what the `strict` sandbox does and doesn't block before any real build runs.
- The Crew gateway must be running (`kirocrew service install`), and the Mac must be awake.

**Fallback: kiro-cli headless** (proved in spike 6: a hello-world Vite app in 52 seconds).
- `overnight build --backend kiro-cli` runs `kiro-cli chat --no-interactive --trust-tools read,write,shell "<prompt>"` inside each workspace, with our own timeout that kills the whole process group (Kiro has no timeout flag).
- It uses the Kiro sign-in on this Mac. No API key.
- launchd runs it 20 minutes after `BUILD_TIME` for any approved idea Crew didn't pick up.
- Never trust the exit code or the agent's own report. Deliver rebuilds from a clean copy and checks the contract itself.

**Security:** the coding agent is never *given* Bee or GitHub credentials, and Kiro is started with a stripped-down environment. The smoke test that gates publishing, and publishing itself, happen only in the separate deliver step. **Known gap (spike 5):** Crew's default sandbox does not stop a job from reaching the GitHub and Bee logins on this Mac, and we expect the same of plain `kiro-cli`, because both run as the Mac user. Closing that gap (Crew's `strict` sandbox level, Kiro permission rules, a test that proves it) is the first task of M2. Until then, briefs must contain only our own words plus the short verbatim quote (no Bee facts, no other transcript text), never anything that could act as instructions.

## 7. Deliver

Runs at `DELIVER_TIME` minus 30 minutes, via launchd. For each `built` idea:

1. `npm ci && npm run build` in a clean copy of the workspace.
2. Playwright smoke test against `dist/`.
3. If it passes:
   - Copy `dist/` into `<slug>/` in a local clone of Henry's public `overnight-apps` repo (GitHub Pages turned on, serving branch `main` from `/`), then commit and push using his GitHub CLI login.
   - The repo root must keep its `.nojekyll` file. Without it GitHub Pages drops files whose names start with `_` (spike 7).
   - The link is `https://hturcotte1.github.io/overnight-apps/<slug>/`. Wait until it serves the new build before sending the morning to-do: poll for content unique to this build, not just a 200. Spike 7 measured 20 to 60 seconds from push to live.
   - Everything published is public, which is why briefs never contain personal details.
   - Take a screenshot.
   - Create a Bee to-do `☀️ Built overnight: <title> → <url>` with `--alarm-at <DELIVER_TIME>`.
   - Write the Bee fact, if enabled.
   - Write the report JSON.
4. If it fails:
   - Create a Bee to-do `🌙 Couldn't finish <title>, details on the dashboard`.
   - Set state to `publish_failed`.

## 8. Dashboard

Local only: `npm run dashboard` → `http://localhost:4321`.

**Views:**
- **Today:** live view of what Overnight heard, asked and had approved.
- **Ideas:** each idea's timeline with quote, brief, build notes, screenshot and link.
- **Nights:** per-night summary.
- **Settings:** read-only config.

It's the main visual in the demo video, so it must look good: clean, phone-friendly, light and dark modes.

**`overnight build-now <id>`** runs the same pipeline immediately, for testing and filming. If it's used in the video, say so on screen.

## 9. Privacy and safety

- All transcripts stay in `~/.overnight`. Only the detector's Kiro call and the one-page brief leave the machine. Published apps are public.
- Kiro may use prompts from individual accounts to improve its service unless that's switched off. Henry had both settings switched off on Oct 9 (`codeWhisperer.shareCodeWhispererContentWithAWS` and `telemetry.enabled`, in the default settings folder and the detector's own `KIRO_HOME`). The detector checks both are `false` at start-up and refuses to send real text otherwise.
- Never commit any of these:
  - Bee data or transcripts
  - Real names
  - Screenshots of real conversations
  - `.env`
  - anything in `~/.overnight`
- Fixtures are synthetic and say so on their first line.
- Bee hears everyone nearby. The README tells users to let people know. The demo only shows people who agreed to be filmed.
- Kiro Crew runs with its sandbox on (at the `strict` level) and its deny rules on. The one loosened setting is `--approval-mode auto` on the nightly build job alone (Henry's decision, Oct 9; see §6). Change nothing else.

## 10. Milestones

Dates are targets. A milestone ends when its checks pass and the docs are updated.

**M0: Spikes (Fri Oct 9 – Sat Oct 10).** Prove each outside piece before building on it. **All eight spikes ran on Oct 9; results are in `docs/spikes.md`.** Four decisions came out of them; they are listed, with what was decided, at the end of that file.
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

**M1: Hear, notice, ask (Sat Oct 10 – Sun Oct 11).** **Built on Oct 9 and running as a background job in quiet mode.** Tests, typecheck, lint and the golden set pass. Still to do with the wearer present: watch real speech go through (including that all event types arrive on the one stream), then `npx overnight resume` and one real ask, approval, rejection and expiry.
- `overnight listen` runs under launchd and snapshots to SQLite.
- It survives disconnects (backfill).
- It detects ideas, asks via Bee to-do, and tracks approve, reject and expire.
- The detector golden set meets its targets. Unit tests are green.

**M2: Build and deliver (Mon Oct 12 – Tue Oct 13).**
- Brief writer.
- Kiro Crew nightly job plus the kiro-cli fallback.
- Deliver step: smoke test, GitHub Pages, morning to-do, Bee fact.
- **First real end-to-end overnight run: Tuesday night.**

**M3: Dashboard and hardening (Wed Oct 14 – Fri Oct 16).**
- Dashboard.
- Re-runs are safe to repeat.
- Timeouts and cost caps.
- `build-now`, `pause` and `resume`.
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
