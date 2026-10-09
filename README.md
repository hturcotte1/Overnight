# Overnight

> Say it at lunch. Use it at breakfast.

Overnight listens through [Bee](https://bee.computer/) (on an Apple Watch) for the moments you say "someone should build...". It asks on your wrist whether to build the idea. While you sleep, Kiro builds, tests and publishes a small working web app. In the morning your watch buzzes with the link.

Built for Amazon's "Build, Ship, Shape" developer hackathon (Bee track, plus the AWS Builder side prize). The full plan is in [SPEC.md](SPEC.md).

## Status

**Milestone 0: spikes.** We are proving each outside piece (Bee, Kiro, GitHub Pages) before building on it. Nothing runs end to end yet. Results are recorded in [docs/spikes.md](docs/spikes.md).

## What's here today

| Path | What it is |
|---|---|
| `SPEC.md` | The build spec and source of truth |
| `spikes/` | One small script per spike. They call Bee for real through `@beeai/cli` |
| `docs/spikes.md` | What each spike proved |
| `docs/friction-log.md` | Every surprise we hit with Bee, Kiro and AWS tools |
| `docs/product-feedback.md` | Feedback on each tool we use |

## Setup

You need a Mac, [Node.js](https://nodejs.org/) 22.18 or newer (we use 24), and the Bee iOS app with Developer Mode turned on (Settings, then tap **Version** five times).

```bash
git clone https://github.com/hturcotte1/Overnight.git
cd Overnight
npm install
npx bee login     # approve it in the Bee app on your phone
npx bee status
```

`npm install` downloads the Bee CLI, which is about 480 MB. npm may warn that it skipped an install script for `@beeai/cli`; that's harmless.

## Running the Bee spikes

Each script prints the *shape* of what Bee returns (field names and types), never the words that were said. Raw output is saved under `~/.overnight/spikes/`, outside this repo.

```bash
node spikes/01-bee-stream.ts 5            # listen to the live stream for 5 minutes
node spikes/02-bee-short-recording.ts     # list recent conversations, or pass ids to re-check them
node spikes/03-bee-todo-alarm.ts 2 10     # create a test to-do with an alarm in 2 min, listen for 10
node spikes/04-bee-facts.ts               # read-only; add --create to write one test fact
```

Spikes 3 and 4 (`--create`) write one clearly labelled test item into the logged-in Bee account.

## Privacy

- Bee hears everyone nearby. If you wear it, tell the people around you.
- Transcripts stay on your Mac in `~/.overnight`. They are never committed to this repo.
- Test fixtures are synthetic and say so on their first line.

## License

[MIT](LICENSE)
