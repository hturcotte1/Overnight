# The demo video

`overnight-demo.webm` is the video for the entry: silent, captioned, 1280 x 720, 2 min 40 s, about 20 MB.
It is not committed (`.gitignore`); it is uploaded to YouTube or Vimeo. YouTube takes WebM as it is.

Every scene carries its own caption, so it works with the sound off. There is no sound track, so there is no music to clear.

## Make it again

```sh
node submission/record.ts    # about 2 min 45 s; writes overnight-demo.webm and scene-timings.json
node submission/frames.ts    # writes frames/*.png and prints the length
```

`record.ts` films one Playwright page from start to end as it moves through the scenes, so the video is one continuous file.
It needs the internet (the real app is loaded from GitHub Pages) and only what is installed already: Playwright, its browser and its ffmpeg.
It starts the dashboard with `--demo --play` on port 4391 (invented data in a throwaway folder) and stops it again.
It never opens Overnight's real data, never talks to Bee, Kiro or GitHub's API, publishes nothing and spends nothing.

## The scenes

| Starts at | Scene | What is on screen |
|---|---|---|
| 0:00 | 1. Title | "Overnight", "Say it at lunch. Use it at breakfast.", "Build, Ship, Shape: Bee track and AWS Builder" |
| 0:06 | 2. The idea | Three lines: people say "someone should make an app that..." and forget it; Overnight hears it through Bee and asks on the wrist; tick yes and it is built while you sleep |
| 0:16 | 3. How it works | The seven steps, one by one, drawn in HTML and SVG, each with its own caption |
| 0:36 | 4. The dashboard | The dashboard playing an invented night (`--demo --play`): two builds with a running clock and the ticks filling in, then the morning's checks. Its "DEMO DATA: invented" label stays in the picture |
| 1:24 | 4b. One idea's page | An invented idea, all seven steps done, its facts, and its brief opened |
| 1:38 | 5a. The first real night | The facts of Oct 10 to 11 (from `docs/spikes.md`, "The first real night") |
| 1:51 | 5b. The real app | The real public Plant Watering Tracker at phone size, with a tap on "Try an example" and a tap to water a plant |
| 2:02 | 5c. The to-do | The morning to-do's words, as `packages/deliver/src/announce.ts` makes them, and the Bee fact, in a card. An illustration, not a screenshot of Bee's app |
| 2:10 | 6. Guardrails | Six lines, one by one |
| 2:26 | 7. Built with | Bee CLI, Kiro CLI, Kiro Crew, GitHub Pages, Playwright; 3,588 tests; the repo address |
| 2:34 | 8. Close | "Say it at lunch. Use it at breakfast." and the repo address |

## What is real and what is invented

- Real: the Plant Watering Tracker page (fetched live), the facts of the first real night, the to-do's format and the brief's template.
- Invented: everything on the dashboard (it is the demo, and it says so on screen).
- Not in the video: any quote of what was said, any name, email, token, key link or file path, and any footage of people. There is no live footage, and the video does not pretend there is.
- Not claimed: nothing is said about building with the lid closed on battery, or about keeping the Mac awake on battery. Neither has been tried for real.

## Files

- `record.ts`: the recording. `frames.ts`: the still frames and the length.
- `scenes/index.html`: the title and text scenes, in the dashboard's colours and type. `scenes/dashboard-caption.js`: the caption strip on the dashboard pages; it acts only in the recording browser.
- `scene-timings.json`: when each scene starts, written by the last recording.
- `frames/` (not committed): one or more still frames per scene from the last recording, for checking by eye.
