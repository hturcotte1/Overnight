# Devpost submission

Everything to paste into Devpost, one field per heading. Copy the text under each heading as it is. Before submitting: put the video link in "Links" (and in the README's first lines), and choose the **Bee** track and the **AWS Builder** side challenge.

Every number here comes from [spikes.md](spikes.md), [product-feedback.md](product-feedback.md), [friction-log.md](friction-log.md) or the test run in the [README](../README.md).

---

## Project name

Overnight

## Tagline

Say an app idea at lunch, approve it when your watch asks, use it at breakfast.

## Inspiration

People say "someone should build..." all the time, and the idea is gone by dinner. Bee already hears those moments. Could a wearable and a coding agent turn that sentence into a working app by the next morning, with a person still deciding what gets built?

## What it does

Overnight runs on a Mac and listens to Bee's live stream from an Apple Watch. When a conversation goes quiet, Kiro decides whether someone described a small app. If so, the watch buzzes with a Bee to-do: "Build tonight? <title>". Tick it in the Bee app for yes, delete it for no. At 1:00 am Kiro Crew builds each approved idea as a small static web app. Overnight tests it in a sandbox, publishes it to GitHub Pages, and at 7:00 am the watch buzzes with the link. It is for builders with more app ideas than time.

## How we built it

TypeScript on Node 24, SQLite and zod, run as four macOS background jobs (listener, Kiro Crew gateway, build, delivery).

- Hear: one package makes every Bee call, through @beeai/cli, and saves each line from `bee stream` the moment it arrives.
- Notice: Kiro CLI, headless, with a no-tools agent; the reply is checked against a schema.
- Ask and approve: a Bee to-do with an alarm, then polling `bee todos get`.
- Build: one Kiro Crew agent job per idea, given one page (our template plus the idea's title and pitch, never the quote), with the whole gateway inside our own macOS sandbox. Kiro CLI, also sandboxed, is the fallback.
- Deliver: Playwright tests the app inside a second, tighter sandbox. Only then is it pushed to GitHub Pages. The agent never sees a token.
- See: a read-only dashboard on the Mac shows each idea's path from "heard" to "delivered" and its short quote (hidden in filming mode), never the transcript.

I wrote it with Claude Code as my coding assistant. 3,588 automated tests pass.

## Challenges we ran into

- A conversation's last stream event holds the whole transcript with first names, which Bee's docs don't mention. We drop it at once.
- Approvals send no event: ticking a to-do never produced `todo-updated`, so Overnight polls.
- Kiro Crew's own sandbox, even at `strict`, left the GitHub login in the Keychain readable from a job. macOS can't nest sandboxes, so the whole gateway runs inside ours, checked every night.
- Kiro's hourly sign-in can't be renewed inside that sandbox, so our code renews it outside before every build.
- On the first real night macOS ran both jobs an hour late: its scheduler still used the time zone the Mac had when it last restarted, and the zone had been changed since. Now Overnight keeps its own clock.

## Accomplishments that we're proud of

The whole loop ran for real once, with nobody touching the Mac. An idea said near the watch on Oct 10 was asked on the wrist and ticked on the phone. That night Kiro Crew built "Plant Watering Tracker" in 2 min 40 s for 4.59 credits. In the morning it was tested and published, and the watch buzzed with the link at 7:32 am instead of 7:00, because both night jobs ran an hour late (see Challenges). Along the way we wrote 56 friction-log entries.

## What we learned

Read the real payloads, not only the docs. Measure what a sandbox hides; its name won't tell you. And a laptop makes a hard server: sleep, time zones and an hourly sign-in shaped the design more than the AI did.

## What's next

More real nights (Bee has sent no new speech since Oct 10), and trying for real the cases that are only tested so far.

## Built with

TypeScript, Node.js, SQLite, better-sqlite3, zod, Bee, @beeai/cli, Kiro CLI, Kiro Crew, macOS sandbox-exec, launchd, Vite, Playwright, Vitest, ESLint, GitHub Pages, GitHub CLI, Claude Code

## Bee track: how Overnight uses Bee

Bee is how Overnight hears and talks to the wearer, called live at runtime through @beeai/cli. The always-on listener reads `bee stream` and catches up after a disconnect with `bee changed`. The question on the wrist is `bee todos create` with an alarm; the answer comes from polling `bee todos get`. In the morning a second to-do carries the link, and `bee facts create` records what was built. On Oct 10 and 11 the whole loop ran for real. Overnight keeps its copy of what was heard only on this Mac, and the build agent never sees it.

## AWS Builder: how Overnight uses Kiro

Kiro Crew is the builder. For each approved idea Overnight adds one unattended agent job that follows our build skill, starts it with `kirocrew cron trigger`, and reads Kiro Crew's own files for when it ended and what it cost (for a monthly ceiling of 400 credits). A zero-credit command job checks our sandbox before each night's builds. Kiro CLI is the idea detector and the fallback builder.

The numbers: nine Kiro Crew builds of small apps, all of which built, in 119 to 224 seconds and 2.6 to 4.6 credits each. The real night: 160 seconds, 4.59 credits. A detector call: 3 to 8 seconds, about 0.016 credits.

## Product feedback

**Bee CLI and live stream.** One install and one QR scan, and live lines from the watch reached the Mac in seconds (median 6 and 8.4 seconds in two tests). The docs don't match the real payloads. Short recordings vanish after about six minutes, undocumented. A dead stream looks like a quiet room.

**Bee to-dos and facts.** One command made a to-do whose alarm buzzed both the phone and the watch: the heart of Overnight. Facts worked first time. Ticking sends no event, so approvals need polling, and a create that times out can't be safely repeated.

**Kiro Crew.** It builds unattended, and a skill keeps each job message to one sentence. Free command jobs and plain-file usage records made our nightly check and budget possible. Its macOS sandbox doesn't keep the Keychain from a job, and it can't run inside an outer sandbox without switching its own off. Under default approvals an unattended agent did nothing and was recorded as a success.

**Kiro CLI.** Headless mode is fast, cheap and scriptable, and it reads its prompt from standard input. It was the easier builder to fence in. It lacks a no-tools flag, a structured-output mode and a timeout flag.

**GitHub Pages.** Free, scriptable through the GitHub CLI, and live 21 to 53 seconds after a push. Our code never handles a token: a background job publishes through the stored GitHub CLI login. Jekyll silently drops files starting with `_` until a `.nojekyll` file is added.

**Playwright.** The gate before anything goes public: it loads the app at two sizes, counts errors and outside requests, and takes screenshots, in 5 to 7 seconds inside a tight sandbox. Its default launch turns Chromium's own sandbox off, and other defaults need care with untrusted tests.

Full feedback: https://github.com/hturcotte1/Overnight/blob/main/docs/product-feedback.md
Friction log: https://github.com/hturcotte1/Overnight/blob/main/docs/friction-log.md

## Feature requests

1. Bee: a yes/no prompt on the watch for apps like ours, or at least a `todo-updated` event when a to-do is ticked.
2. Bee: keep very short recordings, or their text, or document when they are deleted.
3. Bee: a reliable speaker label on live lines that marks the wearer.

## What has not been tried for real

Only one real idea has gone all the way so far. Not yet tried for real: ticking the to-do on the watch, a rejection or expiry with real speech, the dashboard on real data, a night with the lid closed on battery (the rule is written and tested, not tried with a real lid), and whether the Mac stays awake on battery. Where the video shows the dashboard, it is invented demo data, marked "DEMO DATA: invented".

## Links

- Code: https://github.com/hturcotte1/Overnight
- The first real night's app: https://hturcotte1.github.io/overnight-apps/plant-watering-tracker/
- The launch film's app (an idea typed in; built for real by Kiro Crew on Oct 21): https://hturcotte1.github.io/overnight-apps/game-night-scores/
- A rehearsal app (an invented idea; Bee was a stand-in): https://hturcotte1.github.io/overnight-apps/practice-dice-roller/
- Demo video: (paste the YouTube link here)
