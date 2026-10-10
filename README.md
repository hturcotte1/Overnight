# Overnight

> Say it at lunch. Use it at breakfast.

Overnight listens through [Bee](https://bee.computer/) (on an Apple Watch) for the moments you say "someone should build...". It asks on your wrist whether to build the idea. While you sleep, [Kiro](https://kiro.dev/) builds a small working web app; Overnight then tests and publishes it. In the morning your watch buzzes with the link.

Built for Amazon's "Build, Ship, Shape" developer hackathon (Bee track, plus the AWS Builder side prize). The full plan is in [SPEC.md](SPEC.md).

## Status

| Milestone | What | State |
|---|---|---|
| 0 | Prove each outside piece (Bee, Kiro, GitHub Pages) with a small script against the real tools | Done. Results in [docs/spikes.md](docs/spikes.md) |
| 1 | Hear, notice, ask: an always-on listener that saves what Bee hears, spots ideas with Kiro, asks through a Bee to-do and tracks the answer | Built and tested. Running on real Bee data in quiet mode |
| 2 | Build and deliver: Kiro Crew builds approved ideas overnight; Overnight tests, publishes and sends the link | Next |
| 3 to 5 | Dashboard, real nights, submission | Later |

So today Overnight can hear, notice an idea, ask on the wrist and record the answer. It cannot build or deliver yet.

## How the listening half works

```
Apple Watch (Bee app) ──► Bee cloud ──► bee stream
                                           │
                              ┌────────────▼────────────┐
                              │ overnight listen        │  always on (launchd)
                              │  save every line        │──► SQLite in ~/.overnight
                              │  2 quiet minutes?       │
                              │  ask Kiro: an idea?     │──► kiro-cli, no tools
                              │  ask on the wrist       │──► bee todos create (alarm)
                              │  ticked or deleted?     │◄── bee todos get (polling)
                              └─────────────────────────┘
```

- **Hear.** Every utterance is saved the moment it arrives. Bee deletes very short recordings a few minutes later, and those are exactly where one-sentence ideas live.
- **Notice.** After two quiet minutes, the new lines of that conversation go to Kiro CLI running a custom agent with no tools. The reply is checked against a schema; the quote it gives must be word for word from the conversation.
- **Ask.** A real, buildable, non-repeated idea becomes a Bee to-do, `💡 Build tonight? <title>`, with an alarm two minutes out. That buzzes the phone and the watch. At most three asks a day, none at night.
- **Answer.** Ticking the to-do means yes. Deleting it means no. No answer by 11 pm means it expires.

Overnight starts **paused** ("quiet mode"): it listens, saves and detects, but never asks. `npx overnight resume` turns asking on.

## What's in the repo

| Path | What it is |
|---|---|
| `SPEC.md` | The build spec and source of truth |
| `packages/core` | Shared types, settings, the idea state machine, logger, SQLite store |
| `packages/bee` | The only code that talks to Bee, through the official `@beeai/cli` library. It strips transcripts and names out of events before anything else sees them |
| `packages/detector` | The idea detector (Kiro CLI, no tools) and its evaluation script |
| `packages/listener` | The always-on logic: save, detect, ask, track answers, catch up after a disconnect |
| `packages/cli` | The `overnight` command |
| `fixtures/detector/` | 66 synthetic transcripts the detector is scored against. Each file's first line says it is synthetic |
| `launchd/`, `scripts/install-agents.sh` | The macOS background job for the listener |
| `spikes/` | The Milestone 0 scripts |
| `docs/` | Spike results, the friction log (every surprise with Bee and Kiro), and product feedback per tool |

## Setup

You need:

- A Mac with [Node.js](https://nodejs.org/) 22.18 or newer (we use 24).
- The Bee iOS app with Developer Mode on (in Bee's Settings, tap the app **Version** five times), and **notifications allowed for Bee** on the iPhone.
- [Kiro CLI](https://kiro.dev/docs/cli/) signed in (`kiro-cli login`). The detector uses about 0.02 Kiro credits per conversation.

```bash
git clone https://github.com/hturcotte1/Overnight.git
cd Overnight
npm install
node spikes/00-bee-login.ts     # prints a link; open it, scan the QR code with the phone, approve in Bee
node packages/bee/src/smoke.ts  # read-only check: prints "loginState: logged-in"
npm test
```

`npm install` downloads the Bee CLI, which is about 480 MB. npm may warn that it skipped an install script for `@beeai/cli`; that's harmless.

## Running it

```bash
npx overnight status            # mode, what has been heard, ideas, asks today
npx overnight listen            # run the listener in this terminal (Ctrl-C to stop)
npx overnight ideas             # today's ideas and what happened to each
npx overnight resume            # turn asking on (it starts paused)
npx overnight pause             # back to quiet mode
```

To keep the listener running in the background (it starts at login and restarts if it stops):

```bash
scripts/install-agents.sh install
scripts/install-agents.sh status
scripts/install-agents.sh uninstall
```

Only one listener runs per data folder; a second one refuses to start. Logs are in `~/.overnight/logs/listen.log`. They hold ids, counts and states, never what was said.

Settings go in `.env` (copy `.env.example`). The defaults: at most 3 asks a day, asks expire at 23:00, nothing is asked between 23:00 and 07:00, time zone America/Boise.

## Tests and checks

```bash
npm test                 # unit tests; nothing here touches Bee, Kiro or the network
npm run typecheck
npm run lint
npm run eval:detector    # runs the 66 synthetic transcripts through the real detector (about 1 Kiro credit)
```

The detector's last evaluation: precision 1.00 and recall 1.00 on 66 synthetic transcripts (targets: 0.85 and 0.7). That measures the plumbing and the prompt on made-up speech, not real-world accuracy.

## Privacy

- Bee hears everyone nearby. If you wear it, tell the people around you.
- Transcripts stay on your Mac in `~/.overnight`, in files only your user can read. They are never committed to this repo.
- The only text that leaves the Mac is what the detector sends to Kiro. Turn off Kiro's content sharing first (`kiro-cli settings codeWhisperer.shareCodeWhispererContentWithAWS false` and `kiro-cli settings telemetry.enabled false`); the detector also switches both off in its own settings folder, and refuses to run if it can't.
- Bee's "conversation finished" event contains the whole transcript and first names. `packages/bee` drops all of that; nothing downstream can store or log it.
- Test fixtures are synthetic and say so on their first line.
- Everything Overnight publishes will be public, so build briefs never contain personal details.

## License

[MIT](LICENSE)
