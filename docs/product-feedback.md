# Product feedback

Feedback on every tool, API and SDK Overnight uses. The hackathon requires this for each one. Each section answers the same five questions. Specific surprises, with steps, live in [friction-log.md](friction-log.md) (entries F-001 to F-023); test results live in [spikes.md](spikes.md).

Last updated: 2026-10-09, at the end of Milestone 0 (spikes). Everything below comes from running the real tools on one Mac, one iPhone and one Apple Watch, plus reading their source where we say so. We haven't built the product on top of them yet, so "would we build with it again" is a first impression.

---

## Bee CLI and live stream (`@beeai/cli` 0.7.3)

- **What we used it for:** Logging a Mac in to a Bee account, and listening to the live event stream that will feed Overnight's listener. We also tried the backfill commands (`bee changed`, `bee conversations get/transcript`).
- **What worked:**
  - One `npm i -g` gave a working `bee` with no build step.
  - Login was the smoothest part of the whole day: the CLI prints a link, the link shows a QR code, the phone owner scans it and approves in the Bee app. 64 seconds, no password, token stored in the macOS Keychain without a prompt.
  - The stream is fast. During steady talk, words spoken near an Apple Watch reached our Mac in 1 to 10 seconds (median 6).
  - Nine streams at once worked without complaint.
  - Every command we planned around exists with the flags we expected, and `--json` is nearly everywhere. `bee ping` works before login, which separates "network" from "login" problems.
- **What needs work:**
  - The docs don't match the real stream. Real payloads carry a `type` field with the event name, which the docs say doesn't exist; utterances have no `speaker`, which the docs show; and the final conversation event carries the entire transcript with first names, which the docs don't mention at all (F-006, F-012). That last one matters for privacy: an app that logs events would log whole conversations.
  - Very short recordings are deleted about six minutes after they're made, and nothing documents it (F-010).
  - A conversation stays "capturing" for 6.5 minutes after the last word (F-011).
  - Reading the CLI source (0.7.3), the stream makes one connection and has no reconnect or resume. We haven't seen a drop yet, so this is untested.
  - Smaller things: a 478 MB install (F-001), `bee status` exits 0 when logged out (F-003), help text on standard output when a command fails (F-007), `--flag=value` rejected (F-008), a first `bee changed` that returns a whole day (F-014), `--clear-alarm` that doesn't clear (F-023).
- **Onboarding:** Quick: one install command, one QR scan, one stream command, and live utterances were on screen. The one thing we needed that we couldn't find written down was "turn on notifications for Bee".
- **Would we build with it again:** Yes. Live transcripts from the wrist in a few seconds, through a one-line stream command, is the thing that makes this project possible. We'd want accurate payload docs and a setting to keep short recordings.

## Bee library (`@beeai/cli/lib`)

- **What we used it for:** All of our Bee calls go through `createBeeClient()`: login check, stream, to-dos, facts, conversations.
- **What worked:** A tiny, readable wrapper (one 15 KB file). `sse.streamJson()` gives an async iterator, which suits a long-running listener. `runJson([...])` is a handy escape hatch for commands the library doesn't wrap.
- **What needs work:** It looks `bee` up on `PATH` instead of using the binary inside its own package, and reports a missing binary as "not authenticated" (F-004). It lacks helpers for transcript and fact search, and everything is typed `unknown` (F-005). Reading its source, closing a stream surfaces as an error thrown from the iterator, which callers have to expect.
- **Onboarding:** We learned the API by reading `dist/lib/*.d.ts`. Clear, but there are no response types, so every shape had to be discovered by running it.
- **Would we build with it again:** Yes, with our own typed layer on top.

## Bee to-dos and facts

- **What we used it for:** A to-do with an alarm is Overnight's wrist prompt ("Build tonight?"): ticking it means yes, deleting it means no. A fact records what was built so Bee remembers.
- **What worked:**
  - `bee todos create --text ... --alarm-at <UTC time>` stored the alarm exactly, and two minutes later **both the iPhone and the Apple Watch buzzed**. That's the core interaction of the product, working with one command.
  - Deleting the to-do in the app reached our Mac within a few seconds, both as a `todo-deleted` event and as `Todo not found.` from `bee todos get`.
  - `bee facts create` worked first time and the new fact was confirmed straight away. `facts list --unconfirmed` exposes what Bee inferred by itself.
- **What needs work:**
  - Ticking a to-do in the app never produced a `todo-updated` event, so the "yes" has to be found by polling (F-009).
  - Nothing documents that an alarm becomes a notification, or which notification settings the wrist buzz needs (F-013).
  - There's no purpose-built way to ask the wearer a question. A to-do works, but an "ask" with yes/no buttons on the watch would be a far better fit, and safer than overloading the to-do list.
- **Onboarding:** Trial and error with a real phone, since the behaviour we needed isn't documented.
- **Would we build with it again:** Yes for facts. For approvals, yes as a workaround; a real prompt API would replace it immediately.

## Kiro Crew (0.8.0)

This section doubles as our AWS Builder side-prize write-up. So far Kiro Crew has only been tested, not built on. The plan is for it to run Overnight's nightly build job: at 1:00 a.m. it picks up each approved idea and builds it as a small web app in a workspace folder. How much of that Crew's own agent does depends on the approval decision described below, and this section will be updated when Milestone 2 is built.

- **What we used it for:** Installed it, ran its health check, scheduled jobs (zero-credit "command" jobs and one small agent job), ran a job on demand, and probed what a sandboxed job can reach.
- **What worked:**
  - A one-line install with no admin rights that brings its own Python, plus version pinning (`--version 0.8.0`).
  - One-shot jobs ran to the second. `kirocrew cron trigger <id>` starts a job within a second.
  - Zero-credit command and script jobs are a thoughtful feature: not every scheduled task needs a model.
  - Job history is written as plain JSON lines, easy for our dashboard to read.
  - It refuses jobs whose command mentions credential folders like `~/.ssh`.
- **What needs work:**
  - Under default approvals an unattended agent job can read but can't write a file or run a build command; ours waited six minutes finding that out and was recorded as a success (F-021).
  - The "sandbox" on macOS doesn't keep the user's GitHub or Bee logins away from a job (F-022).
  - Daily jobs start at a random time up to 59 minutes late, and the CLI flag the docs give for turning that off doesn't exist in 0.8.0 (F-020).
  - `kirocrew doctor` fails a healthy install over an optional voice feature (F-019), and its output is very long.
  - Docs and released CLI disagree in several places.
- **Onboarding:** Install to first scheduled job in about ten minutes, all from the command line. Working out why the health check failed, and why an agent job silently did nothing, took reading its source.
- **Would we build with it again:** Probably, as a scheduler and job runner. For unattended coding it needs a clearer, safer story: an explicit "unattended" mode with honest failure reporting and a sandbox that actually withholds credentials.

## Kiro CLI (2.29.0)

- **What we used it for:** Two headless jobs through `kiro-cli chat --no-interactive`: (1) the idea detector, a no-tools call that turns a transcript into one JSON verdict, and (2) building a hello-world Vite app in an empty folder.
- **What worked:**
  - Headless mode is solid. A short request returns in about 4 seconds with clean text on standard output and tool activity on standard error.
  - As a detector with a no-tools custom agent: 6 of 6 synthetic transcripts gave valid, correct JSON on the first try, for under 0.1 credits in total.
  - As a builder: a working Vite + TypeScript app, built and self-checked, in 52 seconds for about 0.4 credits. It followed every instruction, including writing honest build notes about what it had not verified.
  - `/usage` works headless, so a script can read the plan and credits used. Per-model credit multipliers make cost easy to reason about.
  - A missing agent name fails fast with exit code 4.
- **What needs work:**
  - The Mac install is a desktop app (364 MB download, about 650 MB installed) with a login item (F-015).
  - Sign-in and upgrade have several traps (F-016).
  - No `--no-tools` flag: the default agent can read files with no trust flags given (F-018).
  - No timeout flag, so every caller must build their own.
  - Docs describe options the latest release lacks (F-017).
- **Onboarding:** Install and sign-in took about ten minutes including one wrong-account detour. After that, the first headless call worked first time.
- **Would we build with it again:** Yes. Fast, cheap, and scriptable. Using the same tool for classification and for building means one account and one bill.

## GitHub Pages (via the GitHub CLI)

- **What we used it for:** Publishing each finished app as a public web page under `hturcotte1/overnight-apps`, one folder per app. Spike 7 created the repo, turned Pages on and published a test page, all from a script.
- **What worked:** `gh auth login --web` took about a minute: paste a code in the browser and the CLI is logged in, with the token in the macOS keychain. Our code never touches the token. One API call turns Pages on (`gh api -X POST repos/<owner>/<repo>/pages -f "source[branch]=main" -f "source[path]=/"`). The first publish was live 53 seconds after the push and the second after 21 seconds. `pages/builds/latest` reports build status and duration, which makes "is it live yet?" checkable. The default login scopes were enough for everything.
- **What needs work:** By default Pages runs Jekyll, which silently drops files whose names start with `_`; our test file returned 404 until we added an empty `.nojekyll` file at the repo root. Nothing in the push or build output warns about it. Run without a terminal, `gh auth login` doesn't connect git to the login, so `gh auth setup-git` is a separate step you have to know about.
- **Onboarding:** Easy. No admin rights needed: the official zip unpacks into the home folder.
- **Would we build with it again:** Yes. Free, fast enough for a morning delivery, and fully scriptable.

## Playwright

- **What we used it for:** Not used yet. Planned for Milestone 2: the smoke test that gates publishing, and the screenshot.
- **What worked:** (pending)
- **What needs work:** (pending)
- **Onboarding:** (pending)
- **Would we build with it again:** (pending)
