# Overnight: build spec

> Say it at lunch. Use it at breakfast.

Overnight listens through Bee for the moments you say "someone should build...". It asks on your wrist whether to build the idea. While you sleep, Kiro Crew builds, tests and publishes a small working web app. In the morning your watch buzzes with the link.

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
  - Published apps go in a second public repo, `hturcotte1/overnight-apps` (see §7). It doesn't exist yet; spike 7 creates it.
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
3. **Ask.** For a real idea, Overnight creates a Bee to-do with an alarm one minute out: `💡 Build tonight? <title>`. It buzzes the wrist through iPhone notification mirroring.
4. **Approve.** The Bee to-do decides what happens:
   - Ticked complete in the Bee app = approved.
   - Deleted = rejected.
   - Unanswered by the cutoff = expired.
5. **Build.** At 1:00 a.m., Kiro Crew builds each approved idea (max 2 per night) as a static single-page web app.
   - It works from a one-page brief.
   - It runs the app's test and writes build notes.
6. **Verify and publish.** At 6:30 a.m., Overnight runs each build's smoke test in a headless browser. Passing builds are published to GitHub Pages and screenshotted.
7. **Deliver.** At 7:00 a.m., a Bee to-do alarm buzzes: `☀️ Built overnight: <title> → <url>`. Overnight also writes a Bee fact so Bee remembers what was built.
8. **Review.** A local dashboard shows each idea's timeline: heard → asked → approved → built → published.

**Principles:**
- Never build without approval.
- Ask at most 3 times a day.
- One idea = one small app.
- Credentials never reach the coding agent.
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
                               │  track approvals    │◄── todo-updated events
                               └──────────┬──────────┘
                                          │ approved idea + brief.md
                               ┌──────────▼──────────┐
                               │ Kiro Crew nightly   │  scheduled job, 1:00 a.m.
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

One TypeScript repo: Node 20+, ESM, npm workspaces. CLI binary name: `overnight`.

| Path | What it is |
|---|---|
| `packages/core` | Shared types, config loader, SQLite store (better-sqlite3), logger, idea state machine |
| `packages/bee` | Thin wrapper over `@beeai/cli/lib` (`createBeeClient`) for stream, conversations, to-dos and facts. **All Bee access goes through here.** |
| `packages/listener` | `overnight listen`: stream → snapshots → conversation-quiet detection → detector → ask → approval tracking |
| `packages/detector` | Prompt, JSON schema (zod) and golden-set eval for "is this a buildable idea?" Runs through Kiro (`kiro-cli chat --no-interactive`, no tools), so no extra AI account is needed. If spike 8 shows Kiro can't do this reliably, ask Henry before adding any other AI service |
| `packages/builder` | Brief writer and two builder backends: `kiro-crew` (primary) and `kiro-cli` (fallback) |
| `packages/deliver` | `overnight deliver`: Playwright smoke test, publish to GitHub Pages, screenshot, morning Bee to-do, Bee fact, report |
| `apps/dashboard` | Local web UI (Vite + React) plus a tiny API server reading SQLite |
| `crew/` | Kiro Crew setup: `nightly-job.md` (the job text), `build-skill.md` (how to build one Overnight app), setup notes |
| `launchd/` + `scripts/install-agents.sh` | macOS LaunchAgents for `listen`, `deliver` and the fallback build; keeps the Mac awake while plugged in |
| `fixtures/` | **Synthetic** transcripts for tests only |
| `docs/` | `spikes.md`, `friction-log.md`, `product-feedback.md`, `architecture.md`, `demo-script.md` |

### Data

Data lives outside the repo and is never committed: `~/.overnight/` (override with `OVERNIGHT_DATA_DIR`).
- `overnight.db` (SQLite)
- `ideas/<id>/brief.md`
- `workspaces/<id>/`
- `reports/<id>.json`
- `screenshots/<id>.png`
- `logs/`

### Idea states

`heard` → `asked` → (`approved` | `rejected` | `expired`) → `building` → (`built` | `build_failed`) → (`published` | `publish_failed`) → `delivered`

### Config

`.env`, with `.env.example` committed:

`KIRO_API_KEY` (detector and build fallback), `GITHUB_PAGES_REPO=overnight-apps`, `OVERNIGHT_DATA_DIR`, `TZ=America/Boise`, `ASK_CUTOFF=23:00`, `BUILD_TIME=01:00`, `DELIVER_TIME=07:00`, `MAX_ASKS_PER_DAY=3`, `MAX_BUILDS_PER_NIGHT=2`, `BUILD_TIMEOUT_MIN=45`, `WRITE_BEE_FACTS=true`, `PAUSED=false`

`overnight pause` and `overnight resume` flip `PAUSED`. While paused, nothing is asked or built.

## 4. Bee integration notes

Verified against Bee's docs and the hackathon forum (Oct 2026). Re-check in M0.

**Setup.** The wearer is Henry's dad: the Bee app runs on his iPhone and Apple Watch under his own Bee account.
1. Done: in the Bee iOS app, chose "Try with Apple Watch".
2. Done: tapped **Version** 5 times in Settings to unlock Developer Mode.
3. Claude Code runs `npm i -g @beeai/cli`.
4. Claude Code runs `bee login`; Henry's dad approves it on his phone. Then `bee status`.

**Live events:**
- Read them with `createBeeClient().sse.streamJson({ types: [...] })` or `bee stream --json`.
- Types we need: `new-utterance`, `new-conversation`, `update-conversation`, `todo-created`, `todo-updated`, `todo-deleted`.
- In `bee stream --json` output there is no top-level `event` field. Tell events apart by their keys (`utterance`, `conversation`, `todo`).

**The stream is at-most-once.** Events that happen during a disconnect are lost. On reconnect, backfill with:
- `bee changed --cursor <c> --json`
- `bee conversations transcript <id> --since <epochMs> --json`

**Short recordings disappear.**
- Bee deletes recordings under about 50 words as likely noise.
- Short Apple Watch captures can return 404 later.
- So snapshot every utterance the moment it arrives, and never rely on re-fetching.

**Speaker labels are unreliable** (often `Unknown`). Don't depend on knowing who spoke. The wrist approval is the real gate.

**Background media (TV, podcasts) gets transcribed** as if it were real conversation. The detector must flag likely media and skip it.

**To-dos:**
- Create with `bee todos create --text "..." --alarm-at <ISO8601> --json`.
- The `todo-updated` payload includes `completed`.
- Store each ask's to-do id against its idea.

**Facts:**
- Use `bee facts list|search|create`.
- Read preference facts (stack, design taste) into briefs.
- Write one fact per delivered build.

**Limits:**
- Third-party hosted apps can't get their own Bee app ID yet. Overnight runs locally under the user's own Developer Mode login. That's allowed, and it goes in the feature requests.
- Tokens don't expire and there's no usage limit (Amazon's FAQ). Still never print or log them.

## 5. Detector

**Input:**
- One conversation's utterances: text and timestamps only.
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

**When it runs:** after 2 minutes with no new utterances, or when `update-conversation` reports the conversation processed.

**Ask only if all of these hold:**
- `is_idea` is true and `confidence ≥ 0.75`
- not `likely_media`
- `buildable_as_static_web_app` is true
- not a near-duplicate of the last 14 days of ideas
- still under `MAX_ASKS_PER_DAY`

**Golden set:** `fixtures/detector/`, at least 40 synthetic transcripts.
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
- The user's relevant Bee preference facts.
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

**Primary: Kiro Crew.** One scheduled job, created once from Crew chat (job text in `crew/nightly-job.md`). At `BUILD_TIME` it:
1. Runs `overnight queue --approved --json`.
2. Builds each idea in `~/.overnight/workspaces/<id>/`, following `crew/build-skill.md`.
3. Runs `overnight mark-built <id>` or `overnight mark-failed <id> --reason "..."`.

**Fallback: kiro-cli headless.**
- `overnight build --backend kiro-cli` runs `kiro-cli chat --no-interactive --trust-tools=<minimal set> "<prompt>"` inside each workspace.
- Needs `KIRO_API_KEY`, which requires Kiro Pro.
- launchd runs it 20 minutes after `BUILD_TIME` for any approved idea Crew didn't pick up.

**Security:** the coding agent never gets Bee or GitHub credentials. Testing and publishing happen only in the separate deliver step.

## 7. Deliver

Runs at `DELIVER_TIME` minus 30 minutes, via launchd. For each `built` idea:

1. `npm ci && npm run build` in a clean copy of the workspace.
2. Playwright smoke test against `dist/`.
3. If it passes:
   - Copy `dist/` into `<slug>/` in a local clone of Henry's public `overnight-apps` repo (GitHub Pages turned on), then commit and push using his GitHub CLI login.
   - The link is `https://hturcotte1.github.io/overnight-apps/<slug>/`. Wait until it loads before sending the morning to-do.
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
- Never commit any of these:
  - Bee data or transcripts
  - Real names
  - Screenshots of real conversations
  - `.env`
  - anything in `~/.overnight`
- Fixtures are synthetic and say so on their first line.
- Bee hears everyone nearby. The README tells users to let people know. The demo only shows people who agreed to be filmed.
- Kiro Crew runs with its sandbox and default protections on. Don't weaken them.

## 10. Milestones

Dates are targets. A milestone ends when its checks pass and the docs are updated.

**M0: Spikes (Fri Oct 9 – Sat Oct 10).** Prove each outside piece before building on it.
- One script per spike in `spikes/`. Results go in `docs/spikes.md`.
- Henry doesn't use Terminal. Claude Code runs everything and asks Henry for phone, watch and account steps one at a time.
- Every surprise goes in `docs/friction-log.md`.

The spikes:
1. `bee status` is OK. `bee stream --json` prints live utterances from an Apple Watch recording. Note the latency.
2. A recording under about 50 words: does it show up in the stream? Does it vanish later?
3. `bee todos create --alarm-at` set 2 minutes out:
   - Does it buzz the watch?
   - When it's ticked in the Bee app, does `todo-updated` arrive with `completed: true`?
4. `bee facts list` and `bee facts create` work.
5. Kiro Crew is installed and `kirocrew doctor` comes back clean. A scheduled test job runs a shell command at a set time.
6. `kiro-cli chat --no-interactive` builds a hello-world Vite app in an empty folder.
7. Publishing a hello-world `dist/` folder to a public `overnight-apps` repo with GitHub Pages turned on gives a working link.
8. `kiro-cli chat --no-interactive` (no tools) returns valid detector JSON for a few synthetic transcripts.

**M1: Hear, notice, ask (Sat Oct 10 – Sun Oct 11).**
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
- **2:25** Why it matters, plus the guardrails: approval gate, data stays on the Mac, sandboxed agents.
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
