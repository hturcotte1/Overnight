# Overnight

> Say it at lunch. Use it at breakfast.

Overnight listens through [Bee](https://bee.computer/) (on an Apple Watch) for the moments you say "someone should build...". It asks on your wrist whether to build the idea. While you sleep, [Kiro](https://kiro.dev/) builds a small working web app; Overnight then tests and publishes it. In the morning your watch buzzes with the link.

Built for Amazon's "Build, Ship, Shape" developer hackathon (Bee track, plus the AWS Builder side prize). The full plan is in [SPEC.md](SPEC.md).

## Status

**Milestone 0 (spikes) has run.** Before building anything, we proved each outside piece with a small script against the real tools: Bee's live stream, to-do alarms and facts on a real iPhone and Apple Watch; Kiro CLI as an idea detector and as a builder; Kiro Crew's scheduler; and GitHub Pages publishing. Results are in [docs/spikes.md](docs/spikes.md).

Nothing runs end to end yet. The listener, builder, deliver step and dashboard are the next milestones.

A page published by the GitHub Pages spike: https://hturcotte1.github.io/overnight-apps/hello-spike/

## What's here today

| Path | What it is |
|---|---|
| `SPEC.md` | The build spec and source of truth |
| `spikes/` | One small script per spike. They call Bee, Kiro and GitHub for real |
| `fixtures/detector/` | Synthetic transcripts for tests. Each file's first line says so |
| `docs/spikes.md` | What each spike proved, and the decisions that came out of them |
| `docs/friction-log.md` | Every surprise we hit with Bee and Kiro, with steps and suggestions |
| `docs/product-feedback.md` | Feedback on each tool we use |

## Setup

You need:

- A Mac with [Node.js](https://nodejs.org/) 22.18 or newer (we use 24).
- The Bee iOS app with Developer Mode turned on (in Bee's Settings, tap the app **Version** five times), and **notifications allowed for Bee** on the iPhone.
- For the Kiro spikes: [Kiro CLI](https://kiro.dev/docs/cli/) signed in (`kiro-cli login`), and [Kiro Crew](https://kiro.dev/docs/crew/) for spike 5.
- For the publishing spike: the [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`).

```bash
git clone https://github.com/hturcotte1/Overnight.git
cd Overnight
npm install
node spikes/00-bee-login.ts     # prints a link; open it, scan the QR code with the phone, approve in Bee
```

`npm install` downloads the Bee CLI, which is about 480 MB. npm may warn that it skipped an install script for `@beeai/cli`; that's harmless.

## Running the spikes

Each script prints the *shape* of what a tool returns (field names, types, timings), never the words that were said. Raw output is saved under `~/.overnight/spikes/`, outside this repo.

| Command | What it does | Writes anything outside this Mac? |
|---|---|---|
| `node spikes/01-bee-stream.ts 5` | Listens to the Bee live stream for 5 minutes | No |
| `node spikes/02-bee-short-recording.ts [id ...]` | Lists recent conversations, or re-checks the given ids | No |
| `node spikes/03-bee-todo-alarm.ts 2 10` | Creates a test to-do with an alarm in 2 minutes, watches it for 10 | One labelled test to-do in the Bee account |
| `node spikes/04-bee-facts.ts [--create]` | Lists and searches facts | With `--create`: one labelled test fact |
| `node spikes/05-crew-scheduled-job.ts` | Health check and scheduled test jobs in Kiro Crew (needs `kirocrew gateway` running) | No |
| `node spikes/06-kiro-build.ts` | Has Kiro build a hello-world Vite app in `~/.overnight/spikes/`, then checks it | Uses Kiro credits (about 0.4) |
| `node spikes/07-pages-publish.ts` | Publishes a test page to `<you>/overnight-apps` on GitHub Pages | A public repo and a public page |
| `node spikes/08-kiro-detector.ts` | Runs the no-tools idea detector on the synthetic transcripts | Uses Kiro credits (under 0.1) |

## Privacy

- Bee hears everyone nearby. If you wear it, tell the people around you.
- Transcripts stay on your Mac in `~/.overnight`. They are never committed to this repo.
- Test fixtures are synthetic and say so on their first line.
- Everything Overnight publishes is public, so build briefs never contain personal details.

## License

[MIT](LICENSE)
