# Product feedback

Feedback on every tool, API and SDK Overnight uses. The hackathon requires this for each one. Each section answers the same five questions. Specific surprises, with steps, live in [friction-log.md](friction-log.md).

Last updated: 2026-10-09 (Milestone 0 in progress; sections fill in as we use each tool)

---

## Bee CLI and live stream (`@beeai/cli`)

- **What we used it for:** So far, installing it and reading its commands. Next: the live event stream that feeds Overnight's listener, plus backfill after disconnects.
- **What worked:** One `npm i -g` gave a working `bee` with no build step and no native compile. `bee <command> --help` is short and accurate, and every command we planned around in the spec exists with the flags we expected. `bee ping` works before login, which makes "is it the network or my login?" easy to answer. `--json` is available almost everywhere.
- **What needs work:** The package is 478 MB because it ships binaries for five platforms (F-001). npm 11 warns about a skipped install script (F-002). `bee status` exits 0 when logged out and has no `--json` (F-003).
- **Onboarding:** Smooth up to the login step. Not yet tested past it.
- **Would we build with it again:** Too early to say.

## Bee library (`@beeai/cli/lib`)

- **What we used it for:** All of Overnight's Bee access goes through `createBeeClient()`.
- **What worked:** A tiny, readable wrapper (one 15 KB file). `sse.streamJson()` gives an async iterator, which fits a long-running listener well.
- **What needs work:** It looks up `bee` on `PATH` instead of using the binary in its own package, and reports a missing binary as "not authenticated" (F-004). It lacks helpers for some CLI commands and returns `unknown` everywhere (F-005).
- **Onboarding:** We learned the API by reading `dist/lib/*.d.ts`; the type files are clear but there are no response types.
- **Would we build with it again:** Too early to say.

## Bee to-dos and facts

- **What we used it for:** Not used yet. Planned: a to-do with an alarm is the wrist approval prompt, and a fact records each delivered build.
- **What worked:** (pending spikes 3 and 4)
- **What needs work:** (pending)
- **Onboarding:** (pending)
- **Would we build with it again:** (pending)

## Kiro Crew

This section doubles as our AWS Builder side-prize write-up: it will describe exactly how Overnight uses Kiro Crew.

- **What we used it for:** Not used yet. Planned: the nightly scheduled job that builds each approved idea in a sandbox.
- **What worked:** (pending spike 5)
- **What needs work:** (pending)
- **Onboarding:** (pending)
- **Would we build with it again:** (pending)

## Kiro CLI

- **What we used it for:** Not used yet. Planned: the idea detector (text in, JSON out, no tools) and the fallback builder.
- **What worked:** (pending spikes 6 and 8)
- **What needs work:** (pending)
- **Onboarding:** (pending)
- **Would we build with it again:** (pending)

## GitHub Pages (via the GitHub CLI)

- **What we used it for:** Publishing each finished app as a public web page under `hturcotte1/overnight-apps`.
- **What worked:** `gh auth login --web` took about a minute: paste a code in the browser and the CLI is logged in, with the token in the macOS keychain. (Pages results pending spike 7.)
- **What needs work:** (pending)
- **Onboarding:** (pending)
- **Would we build with it again:** (pending)

## Playwright

- **What we used it for:** Not used yet. Planned: the smoke test that gates publishing, and the screenshot.
- **What worked:** (pending)
- **What needs work:** (pending)
- **Onboarding:** (pending)
- **Would we build with it again:** (pending)
