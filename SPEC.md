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
5. **Build.** At 1:00 a.m. (`BUILD_TIME`), by Overnight's own clock, Kiro Crew builds each approved idea (max 2 per night) as a static single-page web app.
   - It works from a one-page brief, the only thing it is given, inside Overnight's own sandbox.
   - It runs the app's own build and test as it works, and writes build notes. (The smoke test that decides whether to publish is step 6, not this.)
   - A build that was stopped or cut off (the job was stopped, the Mac restarted or went to sleep) is not a failed build. The next nightly run tries it once more, and nobody is told in between (§6).
   - **Overnight keeps its own time (Milestone 3).** macOS only wakes the build job every minute; Overnight's own code, which knows its time zone (`TZ`), decides when it is 1:00. Each day's build starts at most once. (This is built and tested. The jobs on Henry's Mac are still started by macOS's calendar until they are moved over: pending, §10.)
   - **A missed night catches up.** If the Mac was asleep, switched off or had no internet at 1:00, the build starts a minute or two after that is no longer so, any time before the next night's build (§6, The night clock).
   - **A monthly ceiling.** No build starts once the Kiro credits Overnight has counted for the month reach `MAX_BUILD_CREDITS_PER_MONTH` (400 unless set). Approved ideas then wait for next month. Nothing buzzes; `overnight status` says why (§6).
6. **Verify and publish.** At 6:30 a.m., by the same clock, Overnight rebuilds each app and runs its smoke test in a headless browser, all inside a sandbox, because an AI wrote that code. Passing builds are screenshotted and published to GitHub Pages. A morning the Mac slept through runs when the Mac is next awake and online (§7).
7. **Deliver.** A Bee to-do carries the link: `☀️ Built overnight: <title> → <url>`. Its alarm buzzes at 7:00 a.m. (`DELIVER_TIME`). Overnight also writes a Bee fact so Bee remembers what was built.
   - The alarm rule, as built: the normal 6:30 run sets the alarm for `DELIVER_TIME`. Any run during quiet hours, or within two minutes of them, also waits for `DELIVER_TIME`. That includes `build-now` used at night.
   - A run in the daytime (a late run, or a daytime `build-now`) has no morning to wait for: its alarm rings two minutes out. So an app that is late buzzes when it is ready, and never between 11 p.m. and 7 a.m. (Henry's decision, Oct 11; the rule itself is unchanged from Milestone 2.)
8. **Review.** A local, read-only dashboard shows each idea's story in seven steps: heard → asked → approved → built → checked → published → delivered (§8).

**Principles:**
- Never build without approval.
- Ask at most 3 times a day, and never during quiet hours (`ASK_CUTOFF` to `DELIVER_TIME`).
- One idea = one small app.
- Credentials are never given to the coding agent, and it works inside a sandbox that keeps the GitHub login, the Bee login and the transcripts out of its reach (§6).
- Approvals that arrive after that night's build has started roll to the next night.
- A build that was stopped or cut off gets one more try before anyone is told it couldn't be finished.
- Each night's build and each morning's delivery start at most once a day, and the start is written down before the work begins.
- Builds stop for the month at a ceiling of counted Kiro credits. The ceiling is silent on the wrist.

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
                               │ overnight build     │  launchd wakes it every minute. At 1:00 a.m. by
                               │  Kiro Crew builds   │  Overnight's own clock it writes brief.md, then starts
                               │  in our sandbox     │  one Crew job per idea, inside our sandbox
                               └──────────┬──────────┘  (fallback: kiro-cli headless, also sandboxed)
                                          │ built/<id>/: the finished workspace, moved out of
                                          │ the builders' reach (dist + BUILD_NOTES.md)
                               ┌──────────▼──────────┐
                               │ overnight deliver   │  launchd wakes it every minute. 6:30 a.m. by
                               │ sandboxed build and │  Overnight's own clock
                               │ smoke test → Pages  │──► bee todos create (7:00 alarm)
                               │ screenshot, report  │──► bee facts create
                               └──────────┬──────────┘
                                          ▼
                             dashboard (this Mac only, read-only)
```

### Components

One TypeScript repo: Node 22.18+ (we use Node 24 LTS), ESM, npm workspaces. CLI binary name: `overnight`. Node 20 is too old for the current better-sqlite3 and vitest, and 22.18 is the first Node 22 release that runs `.ts` files without a flag, which the spikes rely on.

| Path | What it is |
|---|---|
| `packages/core` | Shared types, config loader, SQLite store (better-sqlite3), logger, idea state machine. Since Milestone 3 also the night clock (the rule for when a night job runs), the ledger of what builds cost with its monthly ceiling, and the keep-awake helper |
| `packages/bee` | Thin wrapper over `@beeai/cli/lib` (`createBeeClient`) for stream, conversations, to-dos and facts. **All Bee access goes through here.** |
| `packages/listener` | The always-on logic behind `overnight listen`: stream → snapshots → conversation-quiet detection → detector → ask → approval tracking → backfill after a disconnect. Written against the interfaces in `packages/core`, so all its tests run on fakes |
| `packages/cli` | The `overnight` command (see Commands below). Thin wiring only |
| `packages/detector` | Prompt, JSON schema (zod) and golden-set eval for "is this a buildable idea?" Runs through Kiro (`kiro-cli chat --no-interactive` with a no-tools agent), so no extra AI account is needed. Spike 8 showed this works |
| `packages/builder` | Brief writer, the night's build flow, two builder backends (`kiro-crew` primary, `kiro-cli` fallback), the sandbox profiles they run in, and the nightly sandbox check. Since Milestone 3 also: moving a finished build out of the builders' reach ("sealing"), and counting what each build try cost |
| `packages/deliver` | `overnight deliver`: rebuild and smoke-test the app inside our sandbox, publish to GitHub Pages, screenshot, morning Bee to-do, Bee fact, report |
| `packages/dashboard` | Built in Milestone 3: a web page on this Mac that only reads (`npm run dashboard`, §8). A small Node web server with no framework makes the pages from the database (opened read-only), the two night logs, the reports, the screenshots and the build notes. `npm run dashboard:demo` shows the same pages on invented data. (The first plan was `apps/dashboard` with Vite and React; it was built without either, so it adds no package) |
| `crew/` | Kiro Crew setup: `nightly-job.md` (the build job's message), `build-skill.md` (how to build one Overnight app; installed as a Crew skill), and `README.md` (how a build runs and what it can reach) |
| `launchd/` + `scripts/install-agents.sh` | Four macOS LaunchAgents (background jobs): `listen`, `crew` (the Kiro Crew gateway), `build` and `deliver`. The installer takes a job name, so one job can be changed without touching the others. LaunchAgents don't read shell profiles, so every program is called by its full path. `listen` and `crew` run all the time. `build` and `deliver` are started by macOS every 60 seconds, and once when they are loaded (at login and at install); each start asks Overnight's own clock whether it is time and ends at once if it is not (§6, The night clock). macOS's calendar is not used. The listener keeps the Mac awake while it runs, and a night run does the same while it is going (§6, Keeping the Mac awake) |
| `spikes/` | One script per question asked of a real tool (§10). Spikes 10 to 12 are Milestone 3's |
| `fixtures/` | **Synthetic** transcripts for tests only |
| `docs/` | `spikes.md`, `friction-log.md`, `product-feedback.md`, and `images/` (four pictures of the dashboard, made from invented data). Planned for the submission: `architecture.md`, `demo-script.md` |

### Commands

Every command is run as `npx overnight <command>` from the repo.

| Command | What it does |
|---|---|
| `listen` | The always-on listener. One per data folder |
| `status [--json] [--check]` | What has been saved, asked, built and delivered; whether the listener and the night jobs are in place and whether the night jobs keep their own time; this month's build credits; the last and the next build and deliver; what tonight's build will take. It only reads. `--json` is also what the installer reads (`paused`, `timeZone`, `buildTime`, `deliverTime`, `buildSandbox`, and `nightClock.build.checkedAt` and `nightClock.deliver.checkedAt`: when each night job last looked at the clock). It counts ideas waiting to build (`waitingToBuild`) and how many of those are second tries (`waitingForSecondTry`). The rows Milestone 3 added are described below the table |
| `ideas [--json] [--all]` | Today's ideas (or all), with the link once published and the reason if something failed. It says when a cut-off build will be tried once more, and marks rehearsal ideas `[rehearsal]` |
| `queue --approved --json` | The approved ideas for the next build. Empty while paused. (It does not list second tries; `status` counts those) |
| `pause` / `resume` | Quiet mode on or off |
| `build [--if-due]` | Tonight's builds, now (§6). With `--if-due` it first asks Overnight's own clock and does nothing unless a build is due. The `build` job runs it that way every minute, so the build starts at `BUILD_TIME`, or once the Mac is awake and online again, at most once a day. It holds a lock, so a second one refuses to start. It starts no build while paused or once the month's build credits are used up, and it refuses a data folder that holds a rehearsal idea. Exit code 0 whenever it ran, even if a build failed |
| `deliver [--if-due]` | The morning, now (§7): verify, publish, tell the wearer. The `deliver` job runs it with `--if-due` every minute: the morning starts 30 minutes before `DELIVER_TIME` by Overnight's own clock, or once the Mac is awake and online again, at most once a day. It holds its own lock |
| `build --from-now`, `deliver --from-now` | Start that job's clock from now: today's time counts as handled, so nothing that was due before now is run, and the first run is at the job's next time. The installer uses it. Exit code 1, with nothing changed, while that job is running. Not to be combined with `--if-due` |
| `build-now <ideaId>` | The night and the morning for one idea, right away, for testing and filming. It builds an approved idea (or one whose build failed), and goes straight to verify and publish for one that is already built. It ignores the nightly limit, refuses while paused or once the month's build credits are used up, and uses the real Bee |
| `preflight` | Thirteen checks of what tonight needs, each with a tick or a cross and the fix: not paused, Bee, Kiro, the Kiro Crew gateway, its setting, the build skill, the build sandbox, the GitHub login, the apps repo, the test browser, the three night jobs, that the build and deliver jobs keep their own time, and that the gateway job matches `BUILD_SANDBOX`. Exit code 0 only if every check passes. It changes nothing; the sandbox check adds one zero-credit Kiro Crew job and removes it again, and is skipped while a build is running |
| `rehearse new "<title>" "<pitch>"` | Adds one invented idea, already approved and dated yesterday, and prints its id |
| `rehearse run <ideaId> [--no-publish]` | Builds that idea for real, verifies it in the sandbox, publishes it for real (a stand-in with `--no-publish`) and records it as delivered. Bee is always a stand-in: nothing reaches the wrist, and what would have been sent is written to `rehearsal-bee.log` in the data folder |

The dashboard has its own three commands, `npm run dashboard`, `npm run dashboard:filming` and `npm run dashboard:demo` (§8).

**What `status` says about the night (added in Milestone 3).**
- **Build credits:** what has been counted against `MAX_BUILD_CREDITS_PER_MONTH` this month, how much of that is an estimate, and, once the ceiling is reached, that nothing more is built until next month or until the setting is raised.
- **Last build** and **Last deliver:** when the last run started, whether it was on time or how many minutes late, and whether it was cut short.
- **Next build** and **Next deliver** name the run the clock will really start. A run that is going is said to be going. A run that is due and has not started says what holds it up: waiting for the internet; waiting for the lid to be opened or the Mac to be plugged in (the Mac is on battery with its lid closed, §6); waiting for the build to finish first; another build or delivery is going on this data folder right now (a `build-now`, or one started by hand); the job is awake and tries every minute but the work does not start (the reason is in the job's log); `status` could not look at the job's lock file, which the job needs to start ("could not tell whether a build is going on this data folder right now"); or simply "as soon as the Mac has been awake for a minute or two". For the second or so in which the job's own run is starting, the row says "starting now, or waiting for the build that is going on this data folder right now": a held lock does not say who holds it, so both are said.
- **Night clock:** that the build and deliver jobs check the time every minute, or what is wrong: a job is still on macOS's calendar (the old way); its settings file could not be read; it has never checked the time, or not for more than three minutes; it checks the time but the run that is due does not start; or its record is "dated ahead". That last one happens when `BUILD_TIME`, `DELIVER_TIME` or `TZ` is changed on a day whose run has already happened, or the Mac's clock is moved back: the next run is then a day later than the new time, until `install build` or `install deliver` starts the clock from now. The row says so and gives the date.
- **Power:** mains power, or battery. On battery it says whether a listener is running to keep the Mac awake, and that nothing runs with the lid closed.
- **Tonight:** one line. Nothing will be built when Overnight is paused, when the data folder holds a rehearsal idea, when the night jobs were installed for another data folder, when the build job is not installed, when nothing is approved, when the month's credits are used up or when the day's limit is used up. Otherwise it says how many ideas the next build takes.
- On a scratch data folder, `status` says that the installed background jobs belong to another folder, and leaves the Night clock row out.
- `--json` adds `nightClock` (for each job: where its night stands, how macOS starts it, `checkedAt`, `nextStartAt`, `lockHeld`, `notStarting`, `mayBeStarting`, `recordAhead`), `buildCredits`, `rehearsalIdeas`, `power` and `jobsBelongHere`.

**What the thirteen checks add (Milestone 3).**
- "Do the night jobs keep their own time?" passes when both jobs are woken every minute and each has looked at the clock in the last 3 minutes (or is running right now). It fails when a job is still on macOS's calendar, when its record is dated ahead, when it has stopped looking at the clock, and when it is awake but a run that is due has not started three minutes after the first try. Its fix for a job that has not looked at the clock starts with "if the Mac has only just woken, wait two minutes and run this again": a Mac that has just woken shows exactly this for a minute or two, and installing the job again would skip a run that is still due. The check is not made (a dash, not a cross) until the build and deliver jobs are both installed.
- The last check, in `overnight` mode, also compares the gateway job's own copy of the sandbox rules (`sandbox/crew-gateway.sb` in the data folder) with the repo's file, and fails when they differ or the copy is missing. A copy that is not the repo's means the rules changed since `install crew` was last run.
- Two things it does not catch (known, left as they are). While a build or a delivery holds its lock on this data folder, the clock check passes and says only that one "is running right now": a held lock does not say who started it (the night job, a `build-now` or a run by hand). And a look at the clock that fails before it can hand over to the work (its lock file cannot be used) still passes this check: the job has looked at the clock, and nothing is stored about the failed try. Each such look leaves a line in the job's `*.launchd.log`, and `status` says in that job's Next row that it could not tell whether a build (or a delivery) is going, because the lock file could not be used.

**Rehearsals never touch the real data** (decided Oct 10). Both `rehearse` commands refuse unless `OVERNIGHT_DATA_DIR` is set on the command itself (a value that only comes from `.env` does not count), and refuse `~/.overnight`, the folder `.env` names, the folders the installed background jobs were installed for, and anything inside any of them. Since Milestone 3 folders are compared by what the disk says they are (its device and file numbers), not by how they are spelled. So a link, other capitals, and macOS's two other names for the same place (`/System/Volumes/Data/...` and `/.vol/...`) are refused too; the Milestone 2 rule let those two through (`docs/spikes.md`). If a folder cannot be looked at, the rehearsal refuses. A rehearsal never loads the Bee package at all. In turn `listen`, `build`, `deliver` and `build-now` refuse a data folder that holds a rehearsal idea, so a test idea can never reach the real Bee. (The background jobs say so once a night, not once a minute.)

**The background jobs** are installed one at a time: `scripts/install-agents.sh <install | uninstall | restart | status> [listen | crew | build | deliver]`. With no job named, `install` and `restart` act on every job, which also restarts a running listener; name the job to touch only that one. The installer reads Kiro Crew's settings and never changes one.
- **`install build` and `install deliver`** do three more things, in this order. They refuse while that job is in the middle of its work (it has a process on two looks, two seconds apart). They start the job's clock from now (`--from-now`) before anything is stopped, so a run that was still due is skipped and the first run is at the job's next time. And once the job has started, they wait up to 30 seconds for its first look at the clock, and say so plainly if it does not come. A failure before the stop changes nothing.
- **`restart build` and `restart deliver`** refuse and wait in the same way, and leave the clock alone: a run that is due is still due after a restart. `uninstall` is never refused.
- **Do not install a night job within a minute of its time.** Starting the clock from now at that moment can skip that night's run or cut it off.
- If the Mac's own clock is in another time zone than `TZ`, `install` says so in one line and goes ahead: the night jobs go by `TZ`. (The Milestone 2 installer refused.)
- **`install crew`** also installs the build skill (a different one already there is kept beside it as `SKILL.md.bak-<time>`), makes the build jobs' temporary folder (`tmp/build/` in the data folder) if it is missing and, in `overnight` mode only, the other folders the gateway must find in place (`~/workplace/kirocrew-workspace`, four of Kiro's own under `~/.kiro` — `agents`, `sessions`, `settings`, `crew-auth-staging` — and npm's `_cacache` and `_logs`), and waits up to 60 seconds for the gateway to answer. In `overnight` mode it gives the gateway job its own copy of the sandbox rules, `sandbox/crew-gateway.sb` in the data folder. The copy is replaced at one moment only: after the old gateway has stopped and before the new one starts. An install that refuses leaves it as it was.
- `status <job>` says how macOS starts a night job: "wakes every: 60 seconds, and at login", or, for a job still installed the Milestone 2 way, "runs at: ... on macOS's calendar".

### Data

Data lives outside the repo and is never committed: `~/.overnight/` (override with `OVERNIGHT_DATA_DIR`).
- `overnight.db` (SQLite). Since Milestone 3 it also holds the night clock's three small values per job (`night.<job>.run`, `night.<job>.last` and `night.<job>.checkedAt`) and the ledger of what builds cost (the table `build_costs`). Code from Milestone 2 opens the same file and ignores both (tried, `docs/spikes.md`)
- `listen.lock`, `build.lock`, `deliver.lock` (each is held while its command runs, so a second listener, build or deliver refuses to start)
- `kiro-detector/` (the detector's own Kiro settings and saved sessions) and `detector-cwd/` (an empty folder it runs in)
- `tmp/detector-eval/` (the same two folders for `npm run eval:detector`, which only ever sends synthetic text)
- `ideas/<id>/brief.md` (a copy of the brief, kept for the dashboard) and `kiro-cli-output.log` (what Kiro CLI printed, when that builder ran)
- `workspaces/<id>/` (where a build is made. It starts with only `brief.md`; then what the build agent wrote. A folder from an earlier try is renamed `<id>.old-<time>`, never deleted. A finished build does not stay here)
- `built/<id>/` (a finished build: the workspace is moved here as soon as the idea is recorded as built, and no build job can reach it, see §6. An older finished build of the same idea is renamed `<id>.old-<time>`, never deleted. Two more names can appear: `.overnight-probe-marker`, a file of Overnight's own that keeps the folder from being empty for the nightly check, and `<id>.sealing`, a scratch folder that is only left behind if a move was killed half-way)
- `sandbox/crew-gateway.sb` (the gateway job's own copy of the sandbox rules, made by `install crew`, see §6)
- `tmp/build/` (the build jobs' own temporary folder, private to the user; the only temporary folder a sandboxed build can use, see §6)
- `tmp/build-probe/` (the counts and marks the nightly sandbox check writes)
- `tmp/deliver/<id>/run-…/` (the throwaway folders one verification works in, see §7)
- `pages/` (our clone of the public apps repo; a damaged clone is renamed `<repo>.aside-<time>` and cloned again, never deleted)
- `reports/<id>.json`
- `screenshots/<id>.png` (phone size) and `screenshots/<id>-desktop.png`
- `logs/`:
  - `listen.log`, moved to `listen.log.1` once it passes 10 MB
  - `build.log` and `deliver.log`, the night's and the morning's own logs
  - `listen.launchd.log`, `build.launchd.log`, `deliver.launchd.log`: what each job printed outside its log (a crash, a bad setting). A night job's look at the clock that finds nothing due prints nothing and opens no log file
  - `crew.launchd.log`: what the Kiro Crew gateway printed (its own log is shown by `kirocrew logs`)
- `spikes/` (what the spike scripts saved)
- `rehearsal-bee.log` (only in a rehearsal's scratch data folder: what Bee would have been told)

Overnight's own logs (`listen.log`, `build.log`, `deliver.log`) hold ids, counts, states and our own reasons. Never a title, a pitch or anything that was said.

### Idea states

`heard` → `asked` → (`approved` | `rejected` | `expired`) → `building` → (`built` | `build_failed`) → (`published` | `publish_failed`) → `delivered`

Two steps back are allowed: `build_failed` → `building` (a second try, §6) and `publish_failed` → `published` (publishing again with `build-now`, §7).

### Config

`.env`, with `.env.example` committed:

`GITHUB_PAGES_REPO=overnight-apps`, `OVERNIGHT_DATA_DIR`, `TZ=America/Boise`, `ASK_CUTOFF=23:00`, `BUILD_TIME=01:00`, `DELIVER_TIME=07:00`, `MAX_ASKS_PER_DAY=3`, `MAX_BUILDS_PER_NIGHT=2`, `BUILD_TIMEOUT_MIN=45`, `MAX_BUILD_CREDITS_PER_MONTH=400`, `WRITE_BEE_FACTS=true`, `BUILD_BACKEND=kiro-crew`, `BUILD_SANDBOX=overnight`, `PAUSED=true`

`TZ`, `BUILD_TIME` and `DELIVER_TIME` are what the night clock goes by (§6). After changing one of them, run `scripts/install-agents.sh install build` and `install deliver`: that starts their clocks from now. `MAX_BUILD_CREDITS_PER_MONTH` (Henry's decision, Oct 11: 400) is the monthly ceiling on what builds may cost, as Overnight counts it; it can be 0 (never build) to 100000. How the credits are counted is in §6, "What builds cost". The dashboard's port, 4321, is not a setting: both build sandboxes refuse that port by its number.

There is no Kiro key in the config. Kiro CLI and Kiro Crew both use the Kiro sign-in on this Mac (Henry's GitHub login, Kiro Pro plan), which takes priority over an API key anyway. One secret fewer to protect.

`overnight pause` and `overnight resume` flip the pause flag, which lives in the database; `PAUSED` in `.env` is only its starting value. While paused, Overnight still listens, saves and runs the detector, but nothing is asked and the build queue is empty. `overnight build` starts no build while paused (it still records a build that was cut off earlier as failed, so that idea is never stuck). The morning's deliver is not paused: an app that is already built is still published and delivered.

**Overnight starts paused** ("quiet mode"). A fresh install never buzzes anyone's wrist until someone runs `npx overnight resume`. An idea heard while paused is recorded but not asked about later.

`OVERNIGHT_DATA_DIR` must be a full path (or start with `~/`), so every command means the same folder wherever it is run from. Only one `overnight listen` can run per data folder; a second one refuses to start.

**Stopping.** On a stop signal the listener closes the stream, waits up to 10 seconds for work in progress, and exits; lines it was still reading stay pending for the next start. The background job is given 30 seconds before macOS kills it.

The night's commands (`build`, `deliver`, `build-now`, `rehearse run`) stop cleanly too. On Ctrl-C, a closed window or macOS stopping the job, they first end what they started (a Kiro Crew run, Kiro CLI, an install, the test browser), which takes up to 10 seconds, then release their lock and exit. They stop waiting after 20 seconds, and a second signal ends them at once. Their background jobs are given 60 seconds. What a stop does to the idea in progress is in §6 (build) and §7 (deliver). Since Milestone 3 they stop in the same way when the Mac slept through part of a run (§6, "If the Mac sleeps during a run"). If one of these commands hits an error nobody caught, it writes one log line (the kind of error and where, never its message), tells its work to stop, releases its lock and exits with code 1 at once. It waits for nothing on this path, so a Kiro Crew job that was running is not cancelled: it runs on until its own time limit, and the idea is found "interrupted" by the next run (§6).

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
- The listener that was running on Oct 10 had been started before this change. The Mac's restart on Oct 11 started the listener again (§10), so the one running now was started after it. This was not read back from its log.
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
- `npm run eval:detector` prints a confusion matrix. Since Milestone 3 it finds the data folder the way every `overnight` command does: `OVERNIGHT_DATA_DIR` on the command first, then `.env`. With neither it uses `~/.overnight`; it has no refusal of the real folder. (It keeps its own two Kiro folders under `tmp/detector-eval/` there and only ever sends synthetic text.)

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

### The night clock (built in Milestone 3)

**Why.** On the first real night macOS's calendar started both night jobs exactly an hour late, because it was still counting in the time zone the Mac had before its last restart (§10). So macOS no longer decides when a night runs. It only wakes the two jobs; Overnight's own code, which knows `TZ`, decides.

**The rule, in plain words** (`packages/core/src/night-clock.ts`, and `packages/cli/src/commands/night-tick.ts` for what one look does):
- macOS starts each night job every 60 seconds, and once when it is loaded (at login, and when it is installed), as `overnight build --if-due` and `overnight deliver --if-due`. Nearly every one of these looks ends at once. It writes down that the job is awake (its "heartbeat"), finds nothing due, and is gone, without taking a lock, printing a word or opening a log file.
- Each job has one time a day, in `TZ`: build at `BUILD_TIME`, deliver 30 minutes before `DELIVER_TIME`. The run in question is always the latest one at or before now, and it is named by its local day.
- **One start per job per day.** Before the work begins, the start is written into the database, under the job's lock, after the record has been read again under that lock. A run that started and never ended (its process died) is closed as "cut short" by the next look, and nothing is started again for it. What a cut-off build left is tried once more the next night, under the retry rule below.
- **A run stays due until the next day's time comes.** So a Mac that was asleep or switched off catches up when it wakes. A Mac that was off for three days makes one build, for the latest day, and then one delivery.
- **Just woken: one minute's wait.** If the job's look before this one was more than two and a half minutes ago (or there was none), the Mac has only just woken or been switched on. A run that is due then waits one minute in place before it starts, so a Mac that woke for a moment starts nothing. If that minute itself took more than two, the Mac slept again: nothing is started, and the next look starts over.
- **On battery with the lid closed: wait.** A run that is due does not start while the Mac is on battery and its lid is closed. The run stays due, the reason is stored and logged once ("night clock: waiting for the lid to be opened or the Mac to be plugged in"), and it starts at the first look that finds the lid open or the Mac on mains power (and the internet there, as below). This holds for the build and for the delivery (a delivery with a late build to wait for names the build first).
  - *Why.* Such a Mac sleeps whatever is asked (below). But a sleeping Mac wakes by itself for a short while now and then, and some of those wakes last longer than the minute above: on this Mac, 8 of 329 on Oct 8 and 9. A job that macOS starts in one would find its run due, wait its minute and start a build, and the sleep that follows would cut that build short. That uses up the idea's one more try (below). Two such nights, and a good idea is failed and the wearer is told "couldn't finish". Nothing can finish in that state anyway, so nothing is started in it.
  - *How it is asked.* Of macOS's own tools, only by a look that would otherwise start a run, after the minute's wait: `pmset -g ps` for the power source and, only on battery, `ioreg -r -k AppleClamshellState -d 4` for the lid (its line `"AppleClamshellState" = Yes` means closed). Each has 5 seconds. With the lid closed on battery the internet is not asked.
  - *A reading that cannot be made never holds a run up:* a power source that is not known, a Mac without a lid, a tool that fails or takes too long.
  - *Nothing else changes.* On mains power a run starts with the lid closed as before (the first real night ran that way), and on battery it starts with the lid open as before. `build-now` and `rehearse run` do not ask: a person is there.
  - **Pending:** a real closed lid on battery. So far the rule has met tests and a made-up night, and the two readings have been made on this Mac with its lid open and on battery (`docs/spikes.md`). One case is knowingly held up: a Mac that is awake on battery with its lid closed because a screen is plugged into it. It goes by the lid and the power source alone.
- **No internet: wait.** A run that is due starts only when `https://api.github.com/` answers (one request with no login in it, 5 seconds at most). Until then it stays due and the next look asks again. The reason: a Mac that has just woken can be on a network with no way out. A build started then cannot reach Kiro, and when neither builder can start the idea is failed for good. A delivery started then fails its publish for good.
- **The delivery gives a late build 20 minutes.** When the delivery is due and the build is running, or is due too and its job is awake, the delivery waits, so that the app goes out the same day. Time the Mac is asleep and time without the internet do not count: the 20 minutes start again when the Mac wakes and when the internet comes back. After 20 minutes the delivery runs anyway, and an app still being built goes out the next morning.
- **A job's first look ever** takes today's time as already handled and runs nothing. It cannot know whether today's run already happened some other way (the old calendar job, a run by hand). That can cost one night and can never double one. `--from-now` does the same thing on purpose, which is what the installer uses.
- **Plain `overnight build` and `overnight deliver`** (no switch) mean "do it now". They neither read nor write the clock's records. A person who runs one by hand on a night the job also runs is bounded as before: by the lock, by the nightly limit and by each idea being read again before it is built.
- **When the clocks change.** On the autumn night when 1:00 comes twice, both are the same day's run, and the next build is 25 hours later. A `BUILD_TIME` inside the hour that the clocks skip in spring runs an hour early that one night (02:30 runs at 01:30). Both are pinned by tests.
- **A record dated ahead.** If `BUILD_TIME`, `DELIVER_TIME` or `TZ` is changed on a day whose run has already happened, or the Mac's clock is moved back, the stored record is for a later day than the clock has come to. Nothing starts until that day is past. `status` and `preflight` say so and give the date of the next run; `install build` or `install deliver` starts the clock from now.

**What still delays or loses a night, by design:**
- The Mac asleep (lid closed on battery), switched off, logged out or without internet until the next day's time: that day's run is not made up, the next day's takes its place. The ideas are not lost; they are built by the next run.
- A record that is missing or cannot be read counts as a first look: one night is skipped, never doubled.
- A job that fails every time it is started (a bad `.env` value, a builder that will not load) now fails once a minute, and writes a line or two to its `*.launchd.log` each time, until it is fixed. `preflight` fails for it in most cases: the job has stopped looking at the clock, or its run is due and does not start. §3 names the one case `preflight` does not catch; `status` shows it in the job's Next row.

**Keeping the Mac awake** (Henry's decision, Oct 11: on battery, with the lid open, Overnight keeps the Mac awake).
- The listener asks macOS to keep the Mac awake for as long as it runs, on mains power and on battery (`caffeinate -i -s`). The Milestone 2 listener asked with `-s` alone, which only works on mains power. Whether the new way holds on battery has not been tried (the last line here).
- A night run that is actually going (not the every-minute looks) asks in the same way, and so does `build-now`. `rehearse run` does not: someone is at the Mac.
- **With the lid closed on battery the Mac sleeps whatever is asked.** Nothing is heard and nothing runs until it is opened. A run that was due then starts a minute or two after. In the moments such a Mac wakes by itself, a run that is due is not started (the rule above).
- There is no "builds only on mains power" rule. The first design had one; it was dropped because it contradicts the decision above. The lid rule is not that rule come back: on battery with the lid open, a build runs.
- Measured on Oct 11, on mains power: `-s` alone holds one of macOS's two "do not sleep" marks, `-i -s` holds both, and the helper is gone within a tenth of a second of its owner being killed. **Pending:** that it keeps this Mac awake on battery with the lid open (§10).

**If the Mac sleeps during a run.** Every time limit in a build goes by the clock on the wall, and that clock keeps going while the Mac sleeps. Without care, a build the lid was closed on would wake hours later "past its time limit", a good idea would be failed for good and the wearer told "couldn't finish". So `build`, `deliver`, `build-now` and `rehearse run` watch for a sleep: a timer ticks every 5 seconds, and a tick that arrives a minute or more late means the Mac slept. When that is seen the run is stopped exactly as a stop signal stops it.
- A build in progress is ended and recorded as "the build was stopped". One that was on its first start gets its one more try on a later night. One that was on its second start counts as failed, like any second start that ends badly.
- A delivery leaves its ideas `built`. Its run for that day is closed as cut short, so they are delivered by the next morning's run (or by `overnight deliver` by hand).
- `build` and `deliver` then end with exit code 0 (nothing went wrong that a person must fix). `build-now` and `rehearse run` end with 1, because 0 there means "delivered"; running the same command again carries on.
- This also holds when the sleep outlasted the command's own last-resort time limit: the command still waits, up to 20 seconds, for the builder or the deliver step to finish stopping.
- The watch also fires if the Mac's clock is set forward by a minute or more during a run.
- **Pending:** a real sleep of the Mac. So far this was tried with a frozen process (stopped and continued by a signal), never with the lid (§10).

### Backends

**Our own code drives the night.** The build agent never runs the `overnight` command, never sees the database, and never publishes.

`overnight build` is started by the night clock at `BUILD_TIME` (above), or by a person. If nobody is logged in, no background job runs at all.
1. Any idea still `building` from a run that was killed is recorded as `build_failed` with the reason "the build was interrupted". "Killed" means it has been building for longer than `BUILD_TIMEOUT_MIN` plus 15 minutes. This happens even while paused, so an idea is never stuck.
2. If paused, stop here.
3. Take the ideas waiting for a build, oldest approval first: approved ideas, plus builds that were stopped or cut off and are due one more try (below). Take up to `MAX_BUILDS_PER_NIGHT` minus builds already started that local day. A second try counts as a start like any other. Before each idea, ask the month's ceiling on build credits; once it is reached, start nothing more ("What builds cost", below).
4. For each, one at a time: make a slug (the short name in the link) from the title, move an older finished build of the same idea aside (`built/<id>.old-<time>`), prepare an empty workspace `~/.overnight/workspaces/<id>/`, write `brief.md`, move the idea to `building`.
5. Run the primary backend. If it fails or can't start, run the other backend once in a fresh workspace. **Before each of those tries, renew Kiro's sign-in outside the sandbox.** Kiro's sign-in lasts about an hour, and Kiro renews it with a secret in the Keychain, which a sandboxed build can't reach (found in the rehearsal on Oct 10: a gateway started inside the sandbox after an idle hour said "You are not logged in"). So our own code asks `kiro-cli whoami -vvv` outside the sandbox first. That renews a sign-in that has run out, and every Kiro program then finds the new one. Kiro has no command to renew early, so when fewer than ten minutes are left, we wait for the sign-in to run out and ask again. If Kiro says it is signed out, the try isn't started and the reason says so. What Kiro prints there names the account; it is read in memory and goes nowhere.
6. Success means: the workspace has `BUILD_STATUS.json` saying `built`, written after the build started, and `dist/index.html` exists. Then the idea is `built`; otherwise `build_failed` with a plain-words reason.
7. A finished build is then moved out of the builders' reach, to `built/<id>/`, and its files are made anew ("sealed", next). Every try that started an agent is counted in the month's ledger ("What builds cost", below).

**Finished builds are sealed (built in Milestone 3).** A workspace is where an agent works, so a build job can read and write there. With Kiro Crew that means every idea's workspace, because one sandbox covers every job the gateway starts. A finished app left in `workspaces/` could be changed by a later job before the morning publishes it, and it would go out under the other idea's name. So:
- As soon as the idea is recorded as `built`, its workspace is renamed to `built/<id>/` (`packages/builder/src/seal.ts`), whichever builder made it. Both builder profiles close all of the data folder except three folders (`workspaces/`, `tmp/build/` and `tmp/build-probe/`), so nothing in `built/` can be read, listed, written, run or moved by a build job. The nightly sandbox check tries two of those every night (below).
- **Then every plain file in it is made anew:** copied, and the copy put in the old file's place under the same name, with the same permissions and time. A rename moves the same files, and a build can have kept two other ways to them. Both were shown for real on Oct 11, in both profiles: a program the build left running writes through a file it had open, and a hard link (a second name for the same file) made in a folder jobs may write lets any later job write through it. After the copy, the file the morning reads is one no build ever had open and no second name leads to.
- That has 8 seconds in all; installed packages (`node_modules`) are done last, and a file over 1 GB is left alone. Measured: about 10,000 files and 590 MB took between 1.3 and 2.8 seconds.
- The order is "record, then move, then make anew". Killed before the move, the app is still in `workspaces/`, and the morning looks there when there is nothing in `built/`. Killed while the files are being made anew, the app is whole and in `built/`.
- Before an idea is built again, an older finished build of it is renamed `built/<id>.old-<time>`, never deleted, so the morning can never pick up yesterday's app. If that cannot be done, the build is not started.
- If the move itself fails, the idea stays `built`, the log has an error, and the morning uses the app where it is.
- **What sealing does not cover:**
  - A workspace while it is being built, and the folders that failed tries leave in `workspaces/`.
  - The second or so between the move and a file being made anew.
  - **A file that could not be made anew** (out of time, over 1 GB, or marked "locked" by its build so that nothing can be put in its place). The move still counts as done, the idea stays `built`, and `build.log` has an error with the count. The independent check showed the weak point for real on Oct 12: a build that left a hard link to a file and then locked it kept a way in, a later job unlocked the file by its other name and changed it, and the morning would still have tested and published that app. **Open:** whether a build with such a file may be delivered at all, or the seal should clear the lock first. Not decided, not built.
  - `BUILD_SANDBOX=crew`. There Overnight's profile is not in force, and a job can write in `built/` directly.

**What builds cost: the ledger and the monthly ceiling (built in Milestone 3; Henry's decision, Oct 11: 400 credits a month, silent on the wrist).**
- **One row per build try that started an agent**, in the table `build_costs`. A build that needed both builders has two rows. A try that could not start has none.
- **Kiro Crew's own figure, when it is one the try could have used.** After the run is over (cancelled first, if it had to be) Overnight reads Kiro Crew's usage file for that job. That goes for a build that failed, ran past its time limit or was stopped as much as for one that worked. The figure is believed only up to 10 credits for each minute the agent ran (and up to 2 for a try of a few seconds), and never when it is negative. The real builds used 1.3 to 1.7 credits a minute.
- **Otherwise an estimate:** 2 credits for each minute the agent ran, at least 0.1. Kiro CLI gives no figure, so its builds are always estimated.
- **Why the figure is not simply believed.** Kiro Crew keeps its usage file in a folder its own jobs can write. Before this rule, one line added by a job closed the month, and a figure of 100,000 closed it so that no setting could open it again (found by the review on Oct 11).
- **An agent's time is the time it was at work.** Time the Mac slept during the build is measured (the same way the sleep watch above sees a sleep) and left out, to within 5 seconds. As a second bound, it is never taken to be longer than the build's time limit (for Kiro Crew: the time limit plus the 90 seconds Kiro Crew is given to stop the run itself). Before this, a build the lid was closed on two minutes in counted as a full-length try, 90 credits.
- **Asked before each idea, never during one.** So one build can take the month over the line, and the next one waits. It is a soft ceiling.
- **Per data folder, by the calendar month in `TZ`.** `0` means never build.
- **When it is reached:** `overnight build` starts nothing more and says "this month's build credits are used up (… of … counted): approved ideas wait until Nov 1, or until MAX_BUILD_CREDITS_PER_MONTH in .env is raised". `build-now` refuses with the same words. `status` and the dashboard say it too. Nothing buzzes.
- **It fails open.** If the ledger cannot be read or written, that is logged as an error and the build goes ahead. A fault in the ceiling must not cost a night.
- **What it is not:** Kiro's bill. It counts what Overnight saw. Not counted: the detector, the detector's evaluation, and a build whose process was killed before it could write its row. A rehearsal is counted in its own scratch folder's ledger, not in the real one.
- **What a build job can still do to the count:** make it too low, by rewriting its own lines in Kiro Crew's usage file (what is really spent is still bounded by `MAX_BUILDS_PER_NIGHT`); and make one try count for up to 10 credits a minute: 465 for a Kiro Crew try that ran its full 45 minutes and the 90 seconds after them, which raising the ceiling opens again.

**What a stop does, and the one retry (decided Oct 10).**
- When `overnight build` or `build-now` is told to stop (Ctrl-C, macOS stopping the job, logout), it ends the build in progress within 10 seconds: a Kiro Crew run is cancelled and its job removed; Kiro CLI and everything it started is killed. The idea becomes `build_failed` with the reason "the build was stopped". Nothing further starts.
- A build that was stopped or interrupted is not the idea's fault, so **the next nightly run builds it once more**. It waits in the same line as the approved ideas, in order of approval, and counts toward the nightly limit.
- Each idea gets at most two starts this way, counted by how many times it moved into `building`. If the second start is also stopped, interrupted or fails, the idea stays failed.
- The wearer is told "couldn't finish" only then. Until the second start has ended badly, the morning says nothing about the idea (§7).
- A build that really failed (the agent couldn't make the app, or neither builder could start) is never tried again by the nightly run. Neither is an idea the wearer has already been told about.
- `build-now <id>` is not bound by this: it builds any approved or failed idea when a person asks.
- The rule lives in one place, `packages/core/src/build-retry.ts`. The builder, the deliver step and `status` all ask it.
- A build the Mac slept through is stopped in the same way when the Mac wakes ("If the Mac sleeps during a run", above), so it falls under this rule too.
- Two honest limits, known and left as they are. A stop that lands before the agent has started still uses up one of the idea's two starts: starts are counted by moves into `building`, and the sign-in step before the agent can wait up to ten minutes. And a build is only sure of ten minutes of Kiro's sign-in when it starts, while its time limit is 45; builds have taken 2 to 4 minutes, so this has not shown.

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
- In `overnight` mode, Overnight's own `kirocrew` commands run inside the gateway's sandbox profile too, so nothing of Crew's runs outside the fence at night. (They read the profile from the repo; the gateway job reads its own copy, which matches the repo's only if `install crew` has been run since the rules last changed.) They start in `~/.overnight/tmp/build/`, because kirocrew stops with an error when it may not look at the folder it starts in, and the repo is closed to it.
- Real Kiro Crew builds so far: seven, each about 2 to 4 minutes and 2.6 to 4.6 Kiro credits (`docs/spikes.md`). The sixth was the rehearsal on Oct 10, with the real Kiro Crew install. The seventh was the first real night's, started by the nightly launchd job. Milestone 3 has added none yet: its real builds are among the proofs still to be run (§10).

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
  - **Finished builds are out of reach** (Milestone 3): `built/` is not one of the three folders a job works in (above, "Finished builds are sealed").
  - **Other programs' socket files are refused** (added in Milestone 3). A socket file is how a program on the same Mac is reached without a port: a terminal that keeps sessions, a container tool, an editor, a password manager's helper. None of the file rules covered connecting to one (found Oct 10). Now every socket file is refused, except the system's name service (without it no host name can be looked up) and socket files inside folders a job may write anyway; Kiro Crew keeps its own in its home.
  - **The dashboard's port, 4321, is refused** (added in Milestone 3), both for connecting to it and for taking it. It is refused by its number on every address, so port 4321 on other machines is refused too. The first form of the rule named "localhost", and that left this Mac reachable by another spelling of its own address (`::ffff:127.0.0.1`): found by the review on Oct 11 and closed.
  - **These last two rules have only met stand-ins so far.** They are tested with the real `sandbox-exec` around harmless commands on made-up home folders. **Pending:** a real Kiro Crew gateway and a real Kiro CLI build under them (§10).
  - **When Milestone 3's rules begin is not the same for everything.** Overnight's own `kirocrew` commands and the Kiro CLI builder load the rules from the repo on every run, so for those two the rules are in force from the moment this code is the code the night jobs run. A Kiro Crew agent, like everything else the gateway starts, runs inside the gateway's fence, and the gateway job goes by its own copy of the rules (`sandbox/crew-gateway.sb` in the data folder). For an agent the new rules begin only when `install crew` has been run again. Until then it is fenced by the rules as they were at the last `install crew`: on Henry's Mac today, Milestone 2's. The last check of `preflight` says when the copy is not the repo's (§3).
- **Before each night's builds, a zero-credit sandbox check must pass. If it doesn't, nothing is built with Crew that night** and the Kiro CLI builder is used. One Crew command job tries fourteen things from where a build agent would run:
  - three reads: the Keychain entry with the GitHub login; Bee as the logged-in user (with a copy of the Bee program that a job is able to run); the transcript database;
  - three lists: `~/Documents`, `~/Library` and `~/.claude`;
  - one look at another program: `pgrep -f` for a harmless stand-in process that Overnight starts outside the sandbox for the length of the check;
  - five writes: a new file in the home folder, this repo, the folder node is in, the folder Kiro Crew's program is in, and `~/Library/LaunchAgents`;
  - two more at the finished builds (added in Milestone 3): listing `built/`, and making a new file in it. Overnight keeps one small file of its own there, `.overnight-probe-marker`, so that the folder is never empty and "nothing listed" can only mean "refused".

  The job writes only counts and 0/1 marks. Every one must come back 0. A check that can't finish within 3 minutes counts as failed.

  For the six writes the job's own marks are not the last word. When the job is over, Overnight looks from outside the sandbox for the six files the job tried to make; one that is there counts as written, whatever the job said, and is removed. (Measured Oct 11: where a job may write but not look, `touch` makes the file and still ends with an error, so the job reports "not written". Going by the marks alone, a fence opened for writing only would have passed. That was true of the five Milestone 2 writes too.)
- **What the check proves:** the gateway that is running right now was started inside a fence that refuses those fourteen things. A gateway started with no profile, or with a loosened one, fails it. (Tried on Oct 10 with the first twelve: a deliberately loosened copy failed and named each opened thing. Each of the fourteen also fails, in the tests, on a copy of the profile loosened in exactly that way.) The fourteen-line check has not met a real gateway yet (§10). Run with the real sandbox on a made-up home, it passes under the Milestone 2 rules as well, because those already close `built/`.
- **What it does not prove:**
  - every other rule of the profile. For those there are tests that run the profile for real around harmless commands;
  - anything about the network, which is open, or about the names a Crew job can list (below);
  - anything after the check: it runs once per `overnight build` run, so it says nothing about a gateway that was restarted later the same night;
  - anything about the Kiro CLI builder, which needs no such check: Overnight starts it inside its own profile every time.
- `overnight preflight` runs the same check on its own, through the same code.
- **It is a fence, not a sealed box.** What a Crew job can still reach:
  - the network, and every port on this Mac except the dashboard's;
  - every workspace that is being built or was left by a failed try, not only its own. One profile covers every job the gateway starts, so it can't tell one idea from another. A finished build is not among them: it has been moved to `built/`;
  - all of Kiro's own folder, `~/.kiro`, for reading: Kiro CLI's settings and saved sessions, and Kiro Crew's own private files (the gateway and the agent share one sandbox). Kiro CLI's sign-in store too;
  - npm's package store, which the rest of this Mac shares;
  - the names (only the names) of what is directly inside the home folder, `/Users`, `~/workplace`, `~/.local` and the Node.js folder. Kiro Crew 0.8.0 will not start an agent unless it can open every folder above its own, and the macOS sandbox can't allow opening a folder without letting its names be listed. Nothing behind the names can be opened;
  - the list of programs running on this Mac, and of the apps (names and process numbers, not command lines). The rule that hides the list also refuses a job its own process group (measured Oct 11), and Kiro Crew's code asks for exactly that to look after its jobs, so the list stays open in this profile;
  - macOS's own files outside the home folder.

  §9 says what each of these means. The brief rule above stays load-bearing: what the agent is fed is the first protection, and the sandbox is the second.
- `BUILD_SANDBOX=overnight` selects this. `BUILD_SANDBOX=crew` (Crew's own `strict` sandbox, no check) exists for people who can't or won't switch Crew's sandbox off.
- Proved with the Milestone 2 rules: on Oct 10 a real gateway start, the sandbox check and a real agent build all ran under that profile, with a throwaway Kiro Crew home on another port. The real install (`~/.kiro/crew`), started by launchd, passed the check and built an app on the first real night, Oct 10 to 11 (§10). **Pending:** all of that again under the Milestone 3 rules.

**Fallback: kiro-cli headless** (spike 6: a hello-world Vite app in 52 seconds for 0.4 credits).
- `kiro-cli chat --no-interactive --model auto --trust-tools read,write,shell "<the skill text + where the brief is>"` inside the workspace, wrapped in our own sandbox (`packages/builder/sandbox/kiro-cli-build.sb`), with our own time limit that kills the whole process group (Kiro has no timeout flag).
- The profile is the same fence as the gateway's, and narrower: the one workspace of this build is the only folder of Overnight's it can see or write, nothing of Kiro Crew's can be reached, and the home folder can't even be listed. Its temporary folder is its own corner of that folder, `~/.overnight/tmp/build/kiro-cli/`, emptied before each build. The rest of `tmp/build/` belongs to the running Kiro Crew gateway and is left alone.
- Since Milestone 3 it has the same two rules about socket files and the dashboard's port, and two rules the gateway's profile cannot have: the list of running programs is refused (a build can still ask about a program it started itself, by its number), and so is the list of running apps. **Pending:** a real Kiro CLI build under these rules (§10). One thing is known beforehand: under the new socket rule Node itself asks for the system log's socket file when it starts and is refused. That showed in macOS's log on some starts and not on others, and it did no harm in the tests.
- Before the brief is sent, Overnight asks Kiro (inside the same sandbox) for its two content-sharing settings and refuses to build unless both are off (§9).
- The prompt here is a command-line argument. That is acceptable because it holds only our own words (the skill text and a path), never anything from the idea.
- It uses the Kiro sign-in on this Mac. No API key.
- Never trust the exit code or the agent's own report.
- A real build under the Milestone 2 profile passed on Oct 10: 99 seconds, with `npm install`, the build and the Playwright test all working inside the sandbox.

**Security summary:** the coding agent is never *given* Bee or GitHub credentials, runs inside our sandbox, and is fed only `brief.md`. Code it wrote is only ever run inside a sandbox (§7). Publishing happens only in the deliver step, by our code.

## 7. Deliver

`overnight deliver` is started by the night clock (§6) at `DELIVER_TIME` minus 30 minutes, once a day. A morning that was missed (the Mac asleep, switched off or without internet at 6:30) runs when the Mac is next awake and online, under the same alarm rule as any other run (below). It waits up to 20 minutes for a build that is running late; time asleep and time without internet do not count toward the 20 minutes. For each `built` idea, one at a time:

1. **Clean copy.** Copy the finished build (`built/<id>`, or `workspaces/<id>` if it was never moved there) to a throwaway folder: plain files and folders only (symbolic links are refused), without `node_modules`, `dist`, `.git` or `test-results`, with caps on size and file count (2,000 files, 50 MB). The app must have a `package.json` with a `build` script, a `package-lock.json` and `tests/smoke.spec.ts`.
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
   - One case is said more carefully since Milestone 3. If the push ran into its time limit, the reason ends with "The push may have reached GitHub all the same, so the app may be public." The idea is still `publish_failed`: no link is recorded and the wearer gets the 🌙 to-do. `overnight build-now <id>` publishes it again and replaces whatever the first push left.
5. Ideas that failed to build (`build_failed`) get that same 🌙 to-do, once, so the wearer isn't left waiting. **The exception (decided Oct 10):** a build that was stopped or cut off, and still has its second start left (§6), is not a failure yet. The morning says nothing about it. The wearer is told only when the second start has also ended badly. If the number of starts can't be read, that run stays silent about a stopped or cut-off build (a build that really failed is still told): a missed note can be made up for, a wrong buzz can't be taken back. Since Milestone 3 each failed idea is also read again just before Bee is asked: one that is being built again by then, or that another run has already told the wearer about, is skipped.

Running deliver twice never publishes twice or buzzes twice. Before Bee is asked for a to-do, a mark is saved on the idea; if Bee's reply is lost, or Overnight is stopped at that moment, no second to-do is ever made. Delivery of something already built still happens while Overnight is paused; only asking and building stop.
- **If Bee gives no usable answer** (no reply in time, or a reply that cannot be read), the idea is closed as delivered with a note like "Bee was asked for the to-do but its reply was lost (timeout), so the to-do may or may not exist; no second one is made". The word in brackets says how it was lost.
- **If Overnight was stopped at that moment**, the next run closes the idea with the note "Bee was being told when Overnight stopped, so its to-do may or may not exist; no second one is made". The Bee fact, if enabled, is still written.
- Both notes used to say "told in Bee", which claimed more than was known. The honest limit they name: a reply lost, or a hard kill, at the very instant Bee is asked can lose the wearer's note for good. A missed note was chosen over a second buzz.

**The alarm rule, as built.** It is the same for the ☀️ and the 🌙 to-do.
- The normal run, half an hour before `DELIVER_TIME`, sets the alarm for `DELIVER_TIME`.
- Nothing buzzes at night. A run at any time in quiet hours (`ASK_CUTOFF` to `DELIVER_TIME`), or so close to them that an alarm two minutes out would land inside, also waits for `DELIVER_TIME`. That includes `build-now` late in the evening.
- A late run, or `build-now` during the day, has no morning to wait for: its alarm rings two minutes out, the same notice the ask uses.
- One more case, which the default settings never reach: outside quiet hours, a run less than two hours before `DELIVER_TIME` also waits for it. (It only matters if quiet hours are set very short or switched off.)
- Milestone 3 did not change this rule. It only makes a late run likelier, because a morning the Mac slept through now runs when the Mac wakes. Four times are pinned by tests: a to-do made at 6:50 rings at 7:00; at 6:58:30, at 7:00:30 (never less than two minutes ahead); at 10:04, at 10:06; at 23:30, at 7:00 the next day.

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

**Pushed but not seen live (decided Oct 10).** If the push went through but the page was not seen serving this build before the 10-minute wait ran out, that is not a failure. GitHub Pages usually catches up a little later. The idea is recorded as `published` and the wearer is told as usual, with a note on the idea and `confirmedLive: false` in the report saying the page was not confirmed. The honest limit: the page is never looked at again on later mornings. If Pages is switched off or its own build failed, the wearer has a dead link until someone notices. (One small gap: if Bee's reply to the to-do is then lost, the note on the idea is replaced by the lost-reply note. The report and the idea's timeline still say the page was not confirmed.) Since Milestone 3 the line the morning prints says so too ("pushed but not seen live yet"), and so does `build-now`.

**What a stop does.** On a stop signal the step in progress is ended, its programs are killed, and the command answers within 10 seconds.
- Stopped while verifying or publishing: the idea stays `built` and the next run verifies and publishes it again. If the stop came once the push had started, the note on the idea reads "the push to GitHub was started, but Overnight was stopped before the link was confirmed; the next run publishes it again", and the next run replaces that version cleanly. The stop can land during the push itself, so the note does not claim the app reached GitHub.
- Stopped while Bee was being asked for the to-do: the saved mark stays, so the next run closes the idea without asking Bee a second time.
- If the Mac sleeps during the morning's run, the run is stopped in the same way when it wakes (§6). What was not delivered stays `built`. That day's run is then over, so those apps go out with the next morning's run, or sooner with `overnight deliver` by hand.

**Run for real** on the first real night, Oct 10 to 11 (§10): the real publisher against GitHub, the real wait for Pages, the real morning Bee to-do and fact, and this job under launchd, as Milestone 2 built them. The verifier has also run for real many times on apps a Kiro agent built in the experiments (about 5 seconds each with a warm npm cache). **Pending:** a morning started by Overnight's own clock, and a delivery read from `built/` on a real night. So far the real verifier has read a sealed build only in a test run on an invented app, with stand-ins for Bee and for the publisher.

## 8. Dashboard

Built in Milestone 3 (`packages/dashboard`). Its tests pass, and it has been run for real on invented data (looked at in a browser, at phone and desktop size, light and dark) and on the scratch folder the Oct 10 rehearsal left. **Pending:** the first look at the real data folder, beside the running listener, with Henry at the screen (§10).

**What it is.** A web page on this Mac that only reads. A small Node web server with no framework makes each page from one look at the data: the database (opened read-only), the two night logs, the reports, the screenshots and the build notes. It talks to nobody: not Bee, not Kiro, not GitHub. It is the main visual in the demo video, so it has light and dark modes and fits a phone screen.

**Starting it** (Henry's decisions, Oct 11: it opens from a link with a key that is new at each start; the lines Bee heard are never shown; an idea's quote is shown unless filming).
- `npm run dashboard` prints a link that starts with `http://127.0.0.1:4321/?key=`. The page opens from that link and shows nothing without it. Opening the link stores the key in the browser (a cookie) and shows the plain address. An old link stops working when the dashboard is started again.
- `npm run dashboard:filming` is the same with **filming mode** on. It hides every quote, the title and pitch of every idea nobody has approved, and the build notes (an agent wrote those). `npm run dashboard -- --filming --show-quote <ideaId>` lets one idea through whole, for a quote whose speaker agreed to be filmed. Every page with data on it says "FILMING" when it is on, and "Shows what was said" when it is not.
- `npm run dashboard:demo` shows the same pages on invented data (below).
- Options go after the two dashes (`npm run dashboard -- --filming`). Typed before them npm keeps them for itself and the dashboard never sees them. It notices that and refuses to start, because starting without `--filming` or `--demo` is the unsafe way to be wrong. `npm run dashboard -- --help` lists the options.
- Real data is only ever shown on port 4321; `--port` and `--play` only work with the demo. It is stopped with Ctrl-C.

**Never the heard lines.** In no mode does the dashboard read what Bee heard. The only thing it asks about a saved line is how long it is; the Today page draws counts, times and bars from that. What it can show of speech is each idea's short quote (25 words at most, §5), and filming mode hides that too. A test puts a mark on every invented line, quote, build note and unapproved title, asks for every page, and fails if a mark turns up where it should not.

**Views.** Four tabs, and one page per idea.
- **Today.** One line about last night. One idea in the lead, with its story. Three lanes: Heard (how many lines since the last `DELIVER_TIME`, and the latest six conversations as bars), Asked (asks on the wrist, out of the day's limit) and Tonight's build (the time, and the ideas in line). Then the other ideas as cards. The page asks for itself again every 2 to 5 seconds and swaps in only the parts that changed. If the dashboard has stopped, the page says so.
- **Ideas.** Every idea as a card (the newest 200).
- **One idea.** Its title, pitch and quote, its story, the two screenshots as the app was checked, the facts (which builder, how long, Kiro credits, the checks, files and size, how soon it was live), the brief, the build notes and its history.
- **Nights.** One card per night: a headline ("Worked: 2 apps built and delivered."), the counts, the build run and the morning run with their times, and a row per idea. A run started by hand (`build-now`, `rehearse`) is tagged.
- **Settings.** Read-only: each setting in plain words with its `.env` name, whether the data is real or invented, the address, what is hidden, and what has been counted this month against `MAX_BUILD_CREDITS_PER_MONTH`.

**An idea's story is always the same seven steps:** Heard, Asked, Approved, Built, Checked, Published, Delivered. They come from the database alone, so they are right even when a log is lost. The smaller ticks under them (Kiro's sign-in, the sandbox check, the agent at work, built, moved out of the build jobs' reach, the checks, the push, live, told) come from `build.log` and `deliver.log`, and only those that belong to the idea's present build are shown.
- A build that was cut short and waits for its one more try is not shown as failed: it reads "Cut short", and a night counts it on its own ("1 cut short, to be built once more"). When the log says the Mac went to sleep during a run, the pages say that, and do not show the hours asleep as a build time.
- A rehearsal idea is always marked as one and never says the wrist was asked or buzzed.
- One known slip (by reading the code, not run): a delivered idea whose Bee to-do "may or may not exist" (§7) still reads "Sent to the wrist" on its Delivered step. Its history shows the careful note.
- A report is shown only for an idea that is published, delivered or failed at publishing, and its screenshots only for one that is published or delivered; left-overs from an earlier try are not.
- The pages say whether tonight's build will happen by the same stored facts as `overnight status`: the month's build credits, whether the data folder holds rehearsal ideas, and the night clock's records ("Running late: the … build is waiting for the internet."). They cannot tell whether the night jobs are installed. `overnight status` can.

**Reading beside the listener** (measured first, in spike 12). The listener writes to the database for weeks on end and must never wait for a viewer.
- Every look opens the database read-only, reads everything in one short transaction, and closes. Nothing is kept open between looks: a read left open is the one thing that hurts the listener (its write-ahead file then grows without limit).
- The dashboard never uses the `Store` class the other programs use, because that one upgrades the database when it opens it. An older database without the ledger table is read without it.
- Whether the listener, a build or a delivery is running is read from their lock files, read-only, at most once a second.
- Outside its demo, nothing in the package writes a file, makes a folder or opens a database for writing. A test reads the sources and fails otherwise.
- **The honest footnote:** when no other Overnight program has the database open, SQLite itself leaves two small side files beside it (`overnight.db-shm`, 32,768 bytes, and an empty `overnight.db-wal`), private to the user. The database file does not change, and the next Overnight command removes them. While the listener runs they exist anyway.

**The demo** (`npm run dashboard:demo`). Thirteen invented ideas in every state an idea can be in, in a throwaway folder that is removed again when the demo stops, shown by a pretend clock that reads 1:02 a.m. Every page says "DEMO DATA: invented", and `.env` is not read.
- `npm run dashboard:demo -- --play` plays one invented night the way a real one goes: one build run builds two ideas, the pretend clock skips to 6:30 a.m. for the checks and to 7:00 a.m. before anyone is told, and one morning run delivers both. One step every 2.5 seconds, about 70 seconds in all.
- `-- --port <n>` puts the demo on another port.
- Only the demo's own code writes, and only into a folder it made or one that carries its `DEMO-DATA.txt`. It refuses the real data folder, anything inside it and anything that holds it, also by a link or by one of macOS's other names for the same place.
- The demo scene holds two rehearsal ideas, so `listen`, `build`, `deliver` and `build-now` would refuse its folder.
- Per §1, invented data never appears in the video as if it were real: if the demo is filmed, its "DEMO DATA" label stays in the picture.

**`overnight build-now <id>`** (built in Milestone 2) runs the same pipeline immediately, for testing and filming. If it's used in the video, say so on screen. It uses the real Bee, so in the daytime the wrist buzzes two minutes after it finishes (§7). To try the pipeline without reaching anyone, use `overnight rehearse` on a scratch data folder (§3).

The report the dashboard reads (`reports/<id>.json`) carries what each check found, the timings, the two screenshots, `confirmedLive` (true, false, or not known) and the idea's note.

## 9. Privacy and safety

- All transcripts stay in `~/.overnight`. Only the detector's Kiro call and the one-page brief leave the machine. Published apps are public.
- Kiro may use prompts from individual accounts to improve its service unless that's switched off. Henry had both settings switched off on Oct 9 (`codeWhisperer.shareCodeWhispererContentWithAWS` and `telemetry.enabled`, in the default settings folder and the detector's own `KIRO_HOME`). The detector checks both are `false` at start-up and refuses to send real text otherwise. The Kiro CLI builder makes the same check before every build. A Kiro Crew build does not check them itself: it relies on the default settings folder, which a build job cannot write.
- The detector's prompt goes to Kiro on standard input, never on the command line, so it can't be read from the list of running programs (§5). The listener was started again by the Mac's restart on Oct 11, after that change (not read back from its log). The build and deliver sandboxes refuse reading other programs' command lines either way.
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
- A rehearsal can never reach Bee, and refuses the real data folder, however that folder is spelled (§3).
- **The dashboard** (§8) shows short quotes of what people said, on a port every program on this Mac can reach. So:
  - It listens on `127.0.0.1` only, and answers only `GET` and `HEAD` requests that carry the key of this start. Six checks are made on every request, always in the same order, before anything is looked up.
  - Another website can send a person to a dashboard page by a link and nothing else: its pictures, frames, scripts and background requests are refused. Pages load nothing from anywhere else.
  - A request without the key cannot make the dashboard read anything: the page it gets never looks at the database. A screenshot is only served for an idea that is published or delivered.
  - It never shows the lines Bee heard, and filming mode hides the quotes as well (§8).
  - Both build sandboxes refuse its port (§6), so a build job cannot ask it for a page or take the port to serve a look-alike.
  - **The link is written with `127.0.0.1`, not `localhost`.** The name `localhost` also means `::1`, where the dashboard does not listen and another program may. Tried with a stand-in on that address: a browser and `curl` both sent a `localhost` link, key and all, to the stand-in. Typing `localhost:4321` by hand has the same risk.
  - What remains: any program running as this user, outside a sandbox, could read the same files the dashboard reads. The key keeps other web pages and sandboxed build jobs out; it is not a wall between programs of the same user.

### What a build job can and cannot reach

Measured on Oct 10 with the Milestone 2 sandbox profiles (§6). What Milestone 3 added is marked; those rules are tested with the real sandbox on made-up home folders and have not yet met a real Kiro Crew or Kiro CLI build (§10). "Build job" means the build agent and anything it starts. The entry-by-entry lists are in `crew/README.md`.

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
- **Finished builds** (Milestone 3). Nothing in `built/` can be read, listed, written, run, moved or linked into, and the files in it are made anew so that neither a file its build kept open nor a hard link it left leads to what the morning reads (§6). The one known gap is a file its build locked; §6 says what that leaves open.
- **Other programs' socket files** (Milestone 3): all but the system's name service and those in the folders a job may write anyway.
- **The dashboard's port** (Milestone 3): port 4321 can be neither connected to nor taken, on any address.
- **With the Kiro CLI builder only** (Milestone 3): the list of running programs and the list of running apps.

**The limits that remain.** Nothing below has been used against us, and each needs an agent that misbehaves. They are written down so that nobody reads "sandboxed" as "sealed".

1. **The network is open** during a build. The agent needs Kiro's model service and the npm registry, and the macOS sandbox can't filter by host name. Anything a job can read, it could send. That is why the list above matters, and why a brief holds no personal details.
2. **A workspace while it is being built** (Kiro Crew builder only). One profile covers every job the gateway starts, so a Crew job can read and change any folder under `workspaces/`: another idea's brief (a cleaned title and pitch), a build that is in progress at that moment, and the folders that failed tries left. Since Milestone 3 a finished build is no longer there: it is moved to `built/`, which no build job can reach, as soon as it is recorded as built. What sealing does not cover is listed in §6. The Kiro CLI builder sees its own workspace only.
3. **The shared npm package store** (`~/.npm/_cacache`). A build can write to it, and every other `npm` run on this Mac reads from it. By reasoning, not demonstrated: a later `npm` or `npx` run outside a sandbox would trust what a build left there. (Giving builds a package store of their own was looked at for Milestone 3 and left out: the risk is reasoned, not shown, and three packages, the installer and the gateway job would have to change in step.)
4. **Kiro's own files.** A build can read and write Kiro CLI's sign-in store and its saved sessions in `~/.kiro/sessions` (where Kiro CLI saves chats that were run without a folder of their own; the detector's are kept in Overnight's data folder and stay closed). A Crew job can read all of `~/.kiro`, including Kiro Crew's private files and the secret the gateway uses for its local web address, so it could add Crew jobs of its own, and it can write in Kiro Crew's own folder. What is noticed: a changed Kiro Crew setting is caught by the check before the next build, a changed skill stops the next Crew build, and a job Overnight did not add is logged as an error at the next run (nothing is removed, so a person can look). Reading the secret or the settings is never noticed.
5. **Names in the home folder** (Kiro Crew builder only). A Crew job can list the names directly inside the home folder, `/Users` (the account names on this Mac), `~/workplace`, `~/.local` and the Node.js folder. It can't open what the names stand for. Kiro Crew will not start an agent otherwise (§6). Accepted on Oct 10: names only, nothing behind them, and Kiro Crew stays the first builder (it is the tool this entry is built on).
6. **The list of running programs** (Kiro Crew builder only, since Milestone 3). A Crew job can see which programs and apps are running: names and process numbers (over 900 entries when counted on Oct 10), not command lines. The rule that hides the list also refuses a job its own process group (measured Oct 11), and Kiro Crew's code asks for exactly that to look after its jobs. So the list stays open there, and that is accepted. The Kiro CLI builder and the deliver sandbox refuse it.
7. **This Mac's name** is readable in every sandbox, and a Mac's name often holds its owner's first name. (Refusing it makes Node 24 stop at once.) The deliver step searches the built app for it before publishing, which catches accidents, not text hidden on purpose.
8. **macOS's own files** outside the home folder stay readable (`/Applications`, `/Library`, `/System`, `/usr`, `/private/etc`), so a job can tell which apps are installed.
9. **The nightly check tries fourteen things, once per run.** It does not prove every rule, and it does not cover the Kiro CLI builder. It tries nothing about socket files or ports: for those, and for the rest, tests run both profiles for real.
10. **The brief still goes to Kiro's model service** to be built, and the finished app is public. Both hold only a title and a pitch that the detector wrote, with names left out.
11. **Local web addresses** (new to this list in Milestone 3; the gap is older). A build job can connect to any port on this Mac except the dashboard's. The gateway's own port has to stay open, and a build serves its own preview on one. So anything else that listens on this Mac without a password is in a build's reach. An allow-list of ports was left out: what Kiro Crew needs is not measured.
12. **The credit ceiling is a count, not a wall** (Milestone 3). It counts what Overnight saw, not Kiro's bill; it is asked before a build and never during one; a build job can make the count too low; and if the ledger cannot be read the build goes ahead (§6).
13. **The dashboard's port rule is tied to the number 4321.** It protects nothing if the dashboard is ever moved to another port. A test ties both profiles to the one constant in the code.

**At verify time the fence is tighter** (`packages/deliver/sandbox/deliver.sb`, §7). Agent-written code can read only its own copy of the app, our test files, `node`, `npm`, `npx`, Playwright and its browser, and npm's package store. It can write only its own run folder. It reaches no macOS system service at all, no network but two local ports, and no information about any other program, not even the list. While an app is tested, its code cannot read, list, change or run anything in `built/` or `workspaces/` (now pinned by a test against the real sandbox). What remains there: a program that hides on purpose can stay running inside that sandbox after its step. It can no longer change what is published, because the folders it could write are taken away.

**What has met the real install, and what has not.** The Milestone 2 rules were measured on Oct 10 with a throwaway Kiro Crew home, started by hand. The real install, started by launchd, then passed the nightly check and built an app on the first real night (§10). **Pending:** the Milestone 3 rules (socket files, the dashboard's port, the two Kiro CLI rules, the two new lines of the check) against a real Kiro Crew gateway and a real Kiro CLI build; and the gateway job reinstalled so that it runs behind them.

## 10. Milestones

Dates are targets. A milestone ends when its checks pass and the docs are updated.

**M0: Spikes (Fri Oct 9 – Sat Oct 10).** Prove each outside piece before building on it. **All eight spikes ran on Oct 9; results are in `docs/spikes.md`.** (A ninth was added on Oct 10, and three more in Milestone 3.) Four decisions came out of them, and four more out of the Milestone 2 fix rounds; they are listed, with what was decided, in that file. Milestone 3's decisions are in M3 below.
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
10. Added in Milestone 3 (`spikes/10-night-clock.ts`): does macOS really wake the two night jobs every minute, and does Overnight's own clock then start the build once, at its minute, and catch up after a sleep? **Written; its two real modes (`run` and `sitting`) are pending.** Only `check` and `dry`, which load no job, have run.
11. Added in Milestone 3 (`spikes/11-hardening-proof.ts`): do the two builder sandbox profiles, with the new rules, still let Kiro Crew and Kiro CLI do their work? **Written; its two real modes (`p1` and `p2`) are pending.** Only `check`, which starts no gateway, has run.
12. Added in Milestone 3 (`spikes/12-sqlite-read-only.ts`): can a second program read the database beside the listener without ever making it wait? Passed on Oct 11. The rule that came out of it: never leave a read open.

**M1: Hear, notice, ask (Sat Oct 10 – Sun Oct 11).** **Built on Oct 9. It has run as a background job ever since: in quiet mode at first, and with asking on since Oct 10.** Tests, typecheck, lint and the golden set pass. On Oct 10 the whole listening half ran for real: speech heard, an ordinary conversation judged not an idea, a spoken idea detected, the wrist asked, the tick seen, the idea queued (see `docs/spikes.md`). Asking has been on since then. Not yet tried with real speech: a rejection and an expiry.
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
- **After a restart on Oct 11**, macOS registered the two jobs for 1:00:00 AM and 6:30:00 AM Mountain Daylight Time (its own log), and all four jobs came back by themselves. **Still pending:** a night that shows it, written down. (The live jobs stay on macOS's calendar until the switch-over below.)
- **Found by the independent check on Oct 10 and left for Milestone 3** (none blocked a night). What Milestone 3 did with each:
  - *A build job can read the list of running programs.* Closed for the Kiro CLI builder. Accepted for Kiro Crew, which needs it (§9, limit 6).
  - *A build job can connect to other programs' socket files.* Refused in both profiles (§6).
  - *A build job can connect to any local port.* Only the dashboard's port is refused. The rest is accepted and written down (§9, limit 11).
  - *A Kiro Crew job can read and change Kiro Crew's own settings and secret.* Unchanged: it comes with running the whole gateway inside one fence. What is noticed, and what is not, is in §9, limit 4. Watching Kiro Crew's files around every build was looked at and left out: each kind of change is already noticed before the next build, and a false alarm would quietly move every night off Kiro Crew.
  - *A Kiro Crew job can read, write and rename another idea's workspace.* A finished build is now moved out of reach and its files made anew (§6). A workspace in progress is still in reach (§9, limit 2).
  - *A job can make a folder named `kirocrew...` in Kiro's agents folder.* Left as it is: a job can already rewrite Kiro Crew's own agent files there, so tightening the name gains nothing.
  - *`rehearse` could be pointed at the real data folder by an unusual spelling.* Fixed: folders are compared by identity (§3).
  - *A brand-new Kiro home cannot start an agent inside the sandbox* (F-052). No installer check was built. The README's set-up now has the two Kiro settings commands as a required step, and those create the files in question.
  - *`git` and `mktemp -t` do not work inside the build sandboxes.* Left as it is: the build skill already forbids git, and no build has needed either.
  - *The morning's printed line did not say when a page was pushed but not seen live.* Fixed (§7).
- **Decided Oct 10:** a Kiro Crew job listing the names in the home folder is accepted (§9, limit 5).

**M3: Dashboard and hardening (Wed Oct 14 – Fri Oct 16).** **Built on Oct 11, ahead of plan. Reviewed by four independent reviews the same night and fixed. Tests, typecheck and lint pass (3,546 tests in 116 files on Oct 12; one race test in the builder's safe-read tests used to fail now and then in its own clean-up, and was fixed that night: 30 runs in a row passed). Proved against the real tools in the small hours of Oct 12 (proofs P1, P2, P3, P5 and the first half of P4: `docs/spikes.md`, "Still to be proved for real"): the new sandbox rules passed a real build with each builder, the every-minute jobs kept time under real launchd, and a clean clone passes everything. It is not yet what runs at night:** the live night jobs still run the Milestone 2 code, on macOS's calendar, until the sleep test with Henry at the Mac is done and the jobs are moved over.

*Henry's decisions of Oct 11:*
1. On battery, with the lid open, Overnight keeps the Mac awake, so that it keeps listening and can build at night.
2. A late app buzzes when it is ready, never between 11 p.m. and 7 a.m. (the alarm rule Milestone 2 already had; no change).
3. The monthly ceiling on build credits is 400. It is silent on the wrist; `status` says why nothing is built.
4. The dashboard opens from a link with a key that is new at each start. The lines Bee heard are never shown, in any mode. An idea's quote is shown by default and hidden by `--filming`.

Two things followed from decision 1. There is no "builds only on mains power" rule (the first design had one). And a run the Mac sleeps through is stopped when it wakes, instead of being failed for running past its time limit: a build on its first start is tried once more, and a delivery is made by the next morning's run.

*The plan's five items, and what became of them:*
- Dashboard. **Built** (`packages/dashboard`, §8): four views and a page per idea, the key link, filming mode, a demo on invented data that can play a night.
- Re-runs are safe to repeat. (Built in M2 for build and deliver. Milestone 3 added: one start per night job per day, §6.)
- Timeouts and cost caps. (Timeouts were built in M2. **Built in Milestone 3:** the monthly ceiling on counted build credits, `MAX_BUILD_CREDITS_PER_MONTH`, and a sleep that stops a run instead of running it past its time limit.)
- `build-now`, `pause` and `resume`. (Already built, in M2 and M1.)
- README setup works from a clean clone (with fixtures). **The README is rewritten in true order, and a clean clone passed on Oct 12 (P5): `npm ci`, typecheck, lint, all 3,546 tests, the README's commands, and the detector's evaluation.**

*Also built in Milestone 3:*
- **Overnight's own clock** for the two night jobs (§6): macOS only wakes them every minute.
- **Keeping the Mac awake on battery**, asked for by the listener and by a night run while it is going (§6). Whether it holds on battery is pending (P4).
- **Sealed builds:** a finished build is moved to `built/` and its files are made anew (§6).
- **Sandbox:** other programs' socket files and the dashboard's port are refused in both builder profiles; the Kiro CLI profile also hides the lists of running programs and apps; the nightly check tries fourteen things and no longer goes by the job's own marks alone for writes (§6).
- **Rehearsals:** the real data folder is recognised by identity, not by spelling; `build` joins the commands that refuse a data folder holding a rehearsal idea; `status` on a scratch folder says when the installed jobs belong to another one (§3).
- **`preflight`:** thirteen checks (§3).
- **The installer:** night jobs on a 60-second timer; their clock started from now at install; the gateway's copy of the sandbox rules replaced only between the old gateway stopping and the new one starting (§3).
- **More careful words in the morning:** the three notes about Bee and about a push no longer claim more than is known; a failed idea is read again before the wearer is told; the printed line says when a page was not seen live (§7).
- `npm run eval:detector` honours `.env` (§5).

*Left out on purpose:*
- One more try when neither builder could start, or when GitHub could not be reached in the morning. Both would change the retry rule and when the wearer is told. The clock's "is there internet" question covers the case the new clock makes likelier.
- A package store of their own for builds (§9, limit 3); an allow-list of local ports (limit 11); hiding the list of running programs from Kiro Crew jobs (limit 6).
- Waking the Mac on a schedule (it needs an administrator password and changes a system setting).
- A wrist note when the ceiling stops builds; a command that removes a rehearsal idea; tidying away old sealed builds (`built/<id>.old-<time>` folders are kept for good); rotating the `*.launchd.log` files.

*Known after the review round, and still open:*
- **The seal and a locked file** (§6, "What sealing does not cover"): needs a decision.
- **Spike 11's deciding step** was found wanting by the review: it passed when macOS's log could not be read, and failed on another program's refusals. It was rewritten on Oct 12, after the review round. As the script now stands, that step first proves the log was read, counts only the refusals made to this run's own programs, and prints the one refusal that is expected (next line) without failing. The rewrite has not been through a real `p1` or `p2` either.
- **Node and the system log.** Inside the new Kiro CLI profile, Node asks for the system log's socket file when it starts and is refused. That is expected and harmless, and it must not be read as a failed proof. A socket path is only ever to be added to a profile's list when it lies in a folder the job may already write: never one that a program outside the sandbox listens on (Kiro's desktop app keeps two such socket files in this account's temporary folder).
- **The detector's evaluation has no refusal of the real data folder** (§5). In a clean clone, which has no `.env`, it must be run with `OVERNIGHT_DATA_DIR` on the command.
- Two small gaps in `preflight`'s clock check (§3).

*Still to be proved for real, in this order* (the plan; `docs/spikes.md` has the detail and will get the results). All in the daytime, on scratch data folders, with throwaway job names and a throwaway Kiro Crew home on another port. Budget: about 10 Kiro credits, and never past 20 without asking Henry.
- **P1** (no credits): a throwaway Kiro Crew gateway under the new rules. The fourteen-line check passes, and fails by name on a loosened copy. Overnight's own `kirocrew` commands add, start, cancel and remove a job under the new rules. Kiro CLI answers a settings question inside its profile. **Pending.**
- **P2** (about half a credit): one one-line Kiro CLI chat and one one-line Kiro Crew agent job, each inside its profile. **Pending.**
- **P3** (4 to 8 credits): two rehearsal builds without publishing, one by each builder. Both delivered; `built/<id>` there and `workspaces/<id>` gone; a measured row and an estimated row in the ledger; a run with the ceiling set to 1 refused before any agent starts; `build`, `deliver` and `build-now` refused on that folder. **Pending.**
- **P4** (no credits): the every-minute jobs under real launchd, with throwaway names (spike 10, `run`). Then one sitting with Henry (spike 10, `sitting`): the power plug pulled and the lid closed across the build's time. It has to be on battery: plugged in, the running listener keeps this Mac awake with the lid closed, as on the first real night. **Pending.** The sitting answers one open question for certain: how soon after waking macOS starts a job. It shows the wakes a sleeping Mac makes by itself only if one happens in those few minutes (the script prints macOS's own power log for the time). Two more questions are not answered by spike 10 itself. Whether Overnight's sleep watch sees a real sleep as it saw a frozen process: the watch is not in the spike's run, which only notices the sleep with a timer of its own that works the same way. And whether `caffeinate -i -s` keeps this Mac awake on battery with the lid open: that is a look of its own, by hand (`docs/spikes.md` has the steps). **Both pending.**
- **P5** (about 1 credit): a clean clone. `npm ci`, typecheck, lint and tests; the tests again under an empty made-up home folder; the README's commands as written; the two odd spellings of a real folder refused by `rehearse new`; the detector's evaluation once. **Pending.**
- **The switch-over** of the live system: merge, restart the listener, reinstall the gateway and the two night jobs, `preflight` with thirteen ticks. **Pending.** Until `restart listen` has run, the live listener still keeps the Mac awake on mains power only.
- **The first night on Overnight's own clock**, read from the logs the next morning. **Pending.**
- **The dashboard on the real data folder**, beside the running listener, with Henry at the screen. **Pending.**

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
- **0:50** Night. The dashboard timeline, with Kiro Crew working (sped up). The dashboard runs in filming mode. If the invented demo is shown instead of a real night, its "DEMO DATA" label stays in the picture (§1).
- **1:30** Morning delivery: to-do buzz, link, the app in use on the phone.
- **1:55** How it works: Bee stream → Kiro detector → wrist approval → Kiro Crew → verify + GitHub Pages → Bee to-do + fact.
- **2:25** Why it matters, plus the guardrails: approval gate, transcripts stored only on the Mac, publishing kept out of the coding agent, and sandboxed agents. (The last one may be said: the sandbox check passed on the real install on the first real night, §10.)
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
