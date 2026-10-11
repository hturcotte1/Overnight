# Overnight

> Say it at lunch. Use it at breakfast.

Overnight listens through [Bee](https://bee.computer/) (on an Apple Watch) for the moments you say "someone should build...". It asks on your wrist whether to build the idea. While you sleep, [Kiro](https://kiro.dev/) builds a small working web app; Overnight then tests and publishes it. In the morning your watch buzzes with the link.

Built for Amazon's "Build, Ship, Shape" developer hackathon (Bee track, plus the AWS Builder side prize). The full plan is in [SPEC.md](SPEC.md).

## Status

| Milestone | What | State |
|---|---|---|
| 0 | Prove each outside piece (Bee, Kiro, GitHub Pages) with a small script against the real tools | Done. Results in [docs/spikes.md](docs/spikes.md) |
| 1 | Hear, notice, ask: an always-on listener that saves what Bee hears, spots ideas with Kiro, asks through a Bee to-do and tracks the answer | Done. Running on real Bee data; the first real idea was heard, asked about on the wrist and approved on Oct 10 |
| 2 | Build and deliver: Kiro Crew builds approved ideas overnight; Overnight tests, publishes and sends the link | Built, tested and rehearsed for real on Oct 10. **The first real night is the night of Oct 10 to 11** (see below) |
| 3 to 5 | Dashboard, real nights, submission | Later |

So today Overnight can hear, notice an idea, ask on the wrist and record the answer, for real. The building half is written and its tests pass. What has and has not been proven about it:

- **Proven for real, on scratch data:** Kiro Crew and Kiro CLI each built an invented app inside Overnight's sandbox. The morning's checks ran on apps a Kiro agent built, and on apps made to misbehave. Stopping a build or a delivery half-way leaves nothing running and nothing stuck.
- **Rehearsed for real on Oct 10:** an invented idea went the whole way with the real Kiro Crew install inside the sandbox: built in 2 minutes 19 seconds, checked, published by the real publisher and live 21 seconds later, at [practice-dice-roller](https://hturcotte1.github.io/overnight-apps/practice-dice-roller/). Bee was a stand-in. The backup builder (Kiro CLI) and the morning's checks also ran as a background job, the way the night jobs do.
- **Pending:** the build and deliver jobs have not yet fired by themselves at their set times, and the morning Bee to-do and fact have never been created for real. The first real night does both.

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

## How the building half works

```
approved idea
     │
┌────▼──────────────────────┐
│ overnight build   1:00 am │  writes a one-page brief, then one Kiro Crew job per idea
│  Kiro Crew builds the app │  inside Overnight's own sandbox (fallback: Kiro CLI, also sandboxed)
└────┬──────────────────────┘
     │ a folder with the app in it
┌────▼──────────────────────┐
│ overnight deliver 6:30 am │  rebuilds and tests the app inside a tighter sandbox,
│  test, publish, tell      │──► GitHub Pages ──► bee todos create (7:00 alarm), bee facts create
└───────────────────────────┘
```

- **The brief.** The build agent is given one page: our own fixed instructions, plus a cleaned title and a short pitch that the detector wrote. Never the quote, never other transcript text, never names.
- **Build.** At 1:00 a.m. each approved idea (at most two a night) is built as a small static web app with Vite and TypeScript. Kiro Crew goes first; if it fails or can't start, Kiro CLI gets one try.
- **A sandbox around the builder.** A sandbox is a set of rules macOS enforces on a program and on everything it starts. The build agent can't read the GitHub login, the Bee login, what Bee heard, or the rest of the home folder, and it can't write anywhere a program is started from. Before each night's builds, a check that costs no Kiro credits has to prove that, or nothing is built with Kiro Crew that night.
- **Test.** At 6:30 a.m. Overnight rebuilds each app from a clean copy and tests it in a headless browser (a browser with no window), inside a second, tighter sandbox. There the app's code can reach nothing on the network except our own test server on this Mac and, when a package is missing, the npm registry. Only what passes is published.
- **Deliver.** The link goes into a Bee to-do, `☀️ Built overnight: <title> → <link>`, with its alarm at 7:00 a.m. If an app couldn't be finished, the wearer gets one `🌙 Couldn't finish` note.
- **One more try.** A build that was stopped or cut off (the Mac restarted, the job was stopped) is not counted as a failure. The next nightly run builds it once more, and nobody is told unless that fails too.

The sandbox is a fence, not a sealed box. The network is open during a build, and a few other limits remain. [SPEC.md §9](SPEC.md) lists exactly what a build job can and cannot reach.

## What's in the repo

| Path | What it is |
|---|---|
| `SPEC.md` | The build spec and source of truth |
| `packages/core` | Shared types, settings, the idea state machine, logger, SQLite store |
| `packages/bee` | The only code that talks to Bee, through the official `@beeai/cli` library. It strips transcripts and names out of events before anything else sees them |
| `packages/detector` | The idea detector (Kiro CLI, no tools) and its evaluation script |
| `packages/listener` | The always-on logic: save, detect, ask, track answers, catch up after a disconnect |
| `packages/builder` | The night: the brief, the two builders (Kiro Crew and Kiro CLI), their sandbox rules, and the nightly sandbox check |
| `packages/deliver` | The morning: test a built app inside a sandbox, publish it, tell the wearer |
| `packages/cli` | The `overnight` command |
| `crew/` | What the build agent is told: the build skill and the one-sentence job message. [crew/README.md](crew/README.md) explains how one build runs |
| `fixtures/detector/` | 66 synthetic transcripts the detector is scored against. Each file's first line says it is synthetic |
| `launchd/`, `scripts/install-agents.sh` | The four macOS background jobs: the listener, the Kiro Crew gateway, the nightly build, the morning delivery |
| `spikes/` | The Milestone 0 scripts, and one more from Milestone 2 |
| `docs/` | Spike results, the friction log (every surprise with Bee, Kiro and Playwright), and product feedback per tool |

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
npx overnight status            # mode, what has been heard, ideas, asks today, and tonight's plan
npx overnight listen            # run the listener in this terminal (Ctrl-C to stop)
npx overnight ideas             # today's ideas and what happened to each
npx overnight resume            # turn asking on (it starts paused)
npx overnight pause             # back to quiet mode
```

To keep the listener running in the background (it starts at login and restarts if it stops):

```bash
scripts/install-agents.sh install listen
scripts/install-agents.sh status listen
scripts/install-agents.sh uninstall listen
```

Always name the job. With no job named, `install` and `restart` act on all four jobs, which also stops and restarts a listener that is running.

Only one listener runs per data folder; a second one refuses to start. Logs are in `~/.overnight/logs/`. Overnight's own logs hold ids, counts and states, never what was said.

Settings go in `.env` (copy `.env.example`). The defaults: at most 3 asks a day, asks expire at 23:00, nothing is asked between 23:00 and 07:00, builds at 01:00, delivery at 07:00, at most 2 builds a night, time zone America/Boise.

## Setting up the night

The night needs three more things than the listener: Kiro Crew, a GitHub login for publishing, and a browser for the tests.

**What to have in place first**

- [Kiro Crew](https://kiro.dev/) 0.8.0, installed and healthy (`kirocrew doctor`; [docs/spikes.md](docs/spikes.md) says how this Mac was set up). A build has cost between 2.6 and 4.2 Kiro credits so far.
- The [GitHub CLI](https://cli.github.com/) logged in (`gh auth login`, then `gh auth setup-git`), and a public repo for the apps with GitHub Pages turned on and an empty `.nojekyll` file at its root. Its name goes in `GITHUB_PAGES_REPO`.
- Playwright's headless browser: `npx playwright install --only-shell`.
- `npx overnight resume`, if Overnight is still in quiet mode. Nothing is built while it is paused.

**The steps, in this order**

```bash
# 1. The one Kiro Crew setting Overnight needs (see below for why).
~/.local/bin/kirocrew config set agent.sandbox_allow_unsandboxed_exec true

# 2. The Kiro Crew gateway, inside Overnight's sandbox. Also installs the build skill.
scripts/install-agents.sh install crew

# 3. Check everything tonight needs. Each line has a tick or a cross and the fix.
#    (The build and deliver jobs show a cross until step 4.)
npx overnight preflight

# 4. The nightly build (01:00) and the morning delivery (06:30). Neither runs when installed.
scripts/install-agents.sh install build
scripts/install-agents.sh install deliver

# 5. Check again. It should end with "Ready".
npx overnight preflight
```

So far only the listener's job has been installed for real. The three night jobs have been installed only in a dry run, with a made-up home folder and stand-ins for Kiro Crew and for macOS's job system, and `preflight` has only run with none of them installed (crosses where expected). The real install on this Mac is pending, so "Ready" has not been seen yet.

**Why that one Kiro Crew setting.** Kiro Crew has a sandbox of its own, but on a Mac it leaves the GitHub login, the Bee login and the saved transcripts within a build job's reach (measured; see [docs/spikes.md](docs/spikes.md)). So Overnight starts the whole Kiro Crew gateway inside its own, stricter sandbox. macOS can't put one sandbox inside another, and Kiro Crew refuses to run any job inside a sandbox it did not make unless this setting is on. Turning it on switches Kiro Crew's own sandbox off, and Overnight's takes its place. The installer never changes the setting for you: it stops and prints the command, because it is the owner's decision.

If you would rather not change it, set `BUILD_SANDBOX=crew` in `.env`. Kiro Crew's own sandbox is then used at its strict level, which does not protect those three things.

**When to run `install crew` again.** After changing `crew/build-skill.md`, after changing `BUILD_SANDBOX`, and after updating Kiro Crew or Node.js: the gateway's job holds the full paths of both programs.

**What to leave on overnight**

- The Mac plugged in to power, with the lid open, and logged in. Background jobs only run for a logged-in user, and the listener keeps the Mac awake only while it is on mains power.
- The phone with Bee on it, with notifications allowed, so the 7:00 alarm can buzz.

**In the morning**

```bash
npx overnight status                     # "Last delivered", and what waits for tonight
scripts/install-agents.sh status build   # last exit code and the last log lines
scripts/install-agents.sh status deliver
```

Logs are `~/.overnight/logs/build.log` and `deliver.log`.

## Rehearsing

A rehearsal tries the night and the morning on an invented idea. It can never reach Bee, and it refuses to run on the real data folder, so nothing lands on anyone's wrist.

```bash
# Add one invented idea, already approved. Prints its id.
OVERNIGHT_DATA_DIR=/private/tmp/overnight-rehearsal npx overnight rehearse new "Zebra Dice Roller" "Roll one to six dice on a phone and show the total."

# Build it for real and test it for real. --no-publish keeps it off the public page.
OVERNIGHT_DATA_DIR=/private/tmp/overnight-rehearsal npx overnight rehearse run <id> --no-publish
```

- The scratch folder must be named on the command itself, as above. A value that only comes from `.env` is refused.
- Use made-up words for the title and pitch. Without `--no-publish` the app is published for real, on the public apps page.
- What Bee would have been told is written to `rehearsal-bee.log` in the scratch folder.
- A rehearsal uses real Kiro credits.
- The Kiro Crew gateway's sandbox is tied to the one data folder it was installed for. A rehearsal uses a different folder, so with the installed gateway we expect the sandbox check to fail and the build to fall back to Kiro CLI. (That comes from reading the rules; it has not been run.) Rehearsing a Kiro Crew build needs a gateway started for the scratch folder.
- To try one real idea right away instead, `npx overnight build-now <ideaId>` builds and delivers it. That one uses the real Bee: in the daytime the wrist buzzes two minutes later.

So far the rehearsal command has run for real only with stand-ins for the two builders. The full rehearsal, with a real build and a real publish, is pending.

## Backing out

In this order. The listener and all saved data are left alone.

```bash
scripts/install-agents.sh uninstall deliver   # first, so a stopped build can't send a "couldn't finish" note
scripts/install-agents.sh uninstall build
scripts/install-agents.sh uninstall crew
~/.local/bin/kirocrew config set agent.sandbox_allow_unsandboxed_exec false   # Kiro Crew's own sandbox back on
```

- `npx overnight pause` stops asking and building, but an app that is already built is still delivered in the morning. To stop the morning as well, uninstall the `deliver` job.
- `install crew` keeps a build skill it replaced beside the new one, as `SKILL.md.bak-<time>` in `~/.kiro/crew/skills/overnight-build/`.
- A published app stays public until its folder is removed from the apps repo.

## Tests and checks

```bash
npm test                 # unit tests; none calls Bee, spends Kiro credits or publishes anything
npm run typecheck
npm run lint
npm run eval:detector    # runs the 66 synthetic transcripts through the real detector (about 1 Kiro credit)
```

On a Mac, some tests start the real macOS sandbox around harmless commands in made-up folders, to check that the sandbox rules refuse what they should. If Kiro's tools are installed, those tests also ask them for their version number.

The detector's last evaluation: precision 1.00 and recall 1.00 on 66 synthetic transcripts (targets: 0.85 and 0.7). That measures the plumbing and the prompt on made-up speech, not real-world accuracy.

## Privacy

- Bee hears everyone nearby. If you wear it, tell the people around you.
- Transcripts stay on your Mac in `~/.overnight`, in files only your user can read. They are never committed to this repo.
- Two things leave the Mac. The first is what the detector sends to Kiro. Turn off Kiro's content sharing first (`kiro-cli settings codeWhisperer.shareCodeWhispererContentWithAWS false` and `kiro-cli settings telemetry.enabled false`); the detector also switches both off in its own settings folder, and refuses to run if it can't. The second is the one-page brief, which Kiro reads to build the app. It holds a title and a pitch the detector wrote, with names left out.
- The detector hands Kiro its text on standard input, not on the command line, so other programs on the Mac can't read it from the list of running programs.
- Bee's "conversation finished" event contains the whole transcript and first names. `packages/bee` drops all of that; nothing downstream can store or log it.
- The build agent and the code it writes only ever run inside a sandbox. [SPEC.md §9](SPEC.md) says exactly what it can and cannot reach, including the limits that remain.
- Test fixtures are synthetic and say so on their first line.
- Everything Overnight publishes is public, so build briefs never contain personal details.

## License

[MIT](LICENSE)
