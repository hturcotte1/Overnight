# Overnight: instructions for Claude Code

Overnight hears app ideas through Bee (Apple Watch). It asks on the wrist whether to build them, has Kiro Crew build them overnight, and delivers a live link in the morning.

- **SPEC.md is the source of truth.** Read it before planning any milestone, and update it when a decision changes.
- This is a hackathon entry: Amazon "Build, Ship, Shape", Bee track plus the AWS Builder side prize.
- Deadline: Fri Oct 23, 2026, 12:00 PT. Scope discipline beats extra features.

## Working with Henry

- **Henry doesn't use Terminal.** Run every command yourself.
- **Some steps need Henry:** his phone, his watch, signing up for something, paying, or approving a login in his browser. For those:
  - Ask for one thing at a time, in plain words.
  - Say roughly how long it takes.
  - Wait until he says it's done before moving on.
  - Group these requests so he's interrupted as little as possible.
- **The Bee app and Apple Watch belong to Henry's dad.** They're on his dad's iPhone, signed into his dad's Bee account, with Developer Mode already on. Save up anything that needs those devices (approving the Bee login, test reminders on the watch) and ask for it all at once, so Henry can do it with his dad in one sitting.
- **Don't assume jargon.** If a term is unavoidable, explain it in one short phrase.
- **Never add a new paid service or account without asking him first.** The plan uses only Bee, GitHub (he already has it) and Kiro Pro.
- **Finish each work session with a short summary:**
  - what works now
  - what's next
  - anything Henry needs to do

## Working agreement

- **One milestone at a time** (SPEC.md §10). Plan, build, then prove it works with real commands before calling it done.
- **Never guess an API shape.** If Bee, Kiro or GitHub Pages behavior is uncertain, write a spike in `spikes/` and record the result in `docs/spikes.md` before building on it.
- **Keep `docs/friction-log.md` current.** Whenever a Bee, Kiro or AWS tool surprises us, add an entry: task attempted, steps, expected vs. actual, severity, workaround, suggestion. This earns judging bonus points.
- **Keep `docs/product-feedback.md` current** for each tool:
  - what we used it for
  - what worked
  - what needs work
  - how onboarding went
  - whether we'd build with it again

## Hard rules

- **Never commit:**
  - Bee data or transcripts
  - real names or real screenshots
  - `.env`
  - anything under `~/.overnight`
- Fixtures are synthetic, and their first line says so.
- Never print, log or hand tokens (Bee, Kiro, GitHub) to the coding agent, and never put them in briefs. Publishing happens only in the deliver step.
- Code an agent wrote (a build, its tests, its `package.json` scripts) only ever runs inside a sandbox: Crew's gateway sandbox (or the Kiro CLI build sandbox, when the fallback builder runs) at build time, `packages/deliver/sandbox/deliver.sb` at verify time.
- All Bee access goes through `packages/bee`, and it must really call Bee at runtime. That's a hackathon requirement.
- Generated apps follow the app contract in SPEC.md §6: static, no backend, no keys. Published apps are public, so briefs never contain personal details.
- Kiro Crew runs inside Overnight's own macOS sandbox (`BUILD_SANDBOX=overnight`; Henry's decision, Oct 10, after tests showed Crew's own sandbox, even at `strict`, leaves the GitHub login, the Bee login and the transcripts reachable). macOS can't stack two sandboxes, so Crew's own is switched off with `agent.sandbox_allow_unsandboxed_exec = true`. Build jobs, and only build jobs, run with `--approval-mode auto` (decided Oct 9). Before each night's builds a probe must show all three are unreachable, or nothing is built with Crew. Change no other Crew setting.
- The build agent is only ever given `brief.md`: our own template plus the idea's title and pitch. Never the quote, other transcript text, names or Bee facts.
- No code, data, accounts or hardware from NQB8/Zelcast. Everything in this repo is Henry's.
- Keep the MIT `LICENSE` file at the repo root.

## Stack

- TypeScript (strict), Node 22.18+ (we use Node 24 LTS), ESM, npm workspaces
- SQLite via better-sqlite3; zod for every model output and every config value
- Tests: vitest. Browser smoke tests: Playwright. (The dashboard's browser tests are skipped when Playwright's headless browser is not installed.)
- Dashboard: a small Node web server with no framework. It makes each page on the server from a read-only look at the data.
- Detector runs through Kiro headless (`kiro-cli chat --no-interactive` with the no-tools `overnight-detector` agent). Its prompt goes in on standard input, never as a command-line argument, which other programs could read.
- Publishing: GitHub Pages via the GitHub CLI (`gh`) login
- Times stored in UTC, shown in America/Boise

## Commands (keep this list accurate as they're built)

Built and working (Milestones 0 and 1):

- `npm install` · `npm test` · `npm run typecheck` · `npm run lint`
- `npm run eval:detector`: detector golden set (precision ≥ 0.85, recall ≥ 0.7). Uses about 1 Kiro credit. It uses the data folder `.env` names. With no `.env` and no `OVERNIGHT_DATA_DIR` on the command it uses `~/.overnight`, and nothing refuses that.
- `npx overnight listen`: the always-on listener (one per data folder). Since Milestone 3 it asks macOS to keep the Mac awake on battery too, while the lid is open. (Not yet tried on battery. The live listener has run this code since it was restarted on Oct 20.)
- `npx overnight status [--json] [--check]` · `npx overnight ideas [--json] [--all]`
- `npx overnight pause|resume`: Overnight starts paused (quiet mode); `resume` turns asking on
- `npx overnight queue --approved --json`: the approved ideas waiting for a build (the nightly build reads the database itself)
- `node packages/bee/src/smoke.ts`: read-only check that Bee is reachable and logged in
- `node spikes/<name>.ts`: the spikes (see `docs/spikes.md`). Spikes 10 and 11 take a mode and a scratch folder; `node spikes/12-sqlite-read-only.ts` needs no Bee, no Kiro and no data folder.

Built in Milestone 2 and hardened in Milestone 3. The rehearsal (Oct 10) and the first real night (Oct 10 to 11) worked. Milestone 3 was proved on the real tools on Oct 12, and the live jobs were moved over to it on Oct 20 (`preflight` 13 of 13). The first night on Overnight's own clock (Oct 20 to 21) started on time. Still pending: a night with the lid closed on battery, and whether the Mac stays awake on battery (SPEC.md §10):

- `npx overnight build [--if-due]`: tonight's builds, now. With `--if-due` it asks Overnight's own clock first and does nothing unless a build is due. The `build` job runs it that way every minute, so the build starts at `BUILD_TIME`, at most once a day. Nothing is built while paused, or once the month's `MAX_BUILD_CREDITS_PER_MONTH` is used up.
- `npx overnight deliver [--if-due]`: the morning, now: test each build in the sandbox, publish, tell the wearer. The `deliver` job runs it with `--if-due` every minute; the morning starts 30 minutes before `DELIVER_TIME`.
- `npx overnight build --from-now` · `npx overnight deliver --from-now`: start that job's clock from now, so nothing that was due before now is run. The installer uses these; there is seldom a reason to run one by hand.
- `npx overnight build-now <ideaId>`: build and deliver one approved idea right away. It uses the real Bee: in the daytime the wrist buzzes two minutes later.
- `npx overnight preflight`: thirteen checks of what tonight needs, each with its fix. Exit code 0 only if all pass. Changes nothing.
- `OVERNIGHT_DATA_DIR=<scratch folder> npx overnight rehearse new "<title>" "<pitch>"`, then `... rehearse run <ideaId> [--no-publish]`: try the night and the morning on an invented idea. Bee is always a stand-in, and the real data folder is refused, however it is spelled. This is the way to test the pipeline; never point a test at `~/.overnight`. In turn `listen`, `build`, `deliver` and `build-now` refuse a data folder that holds a rehearsal idea.
- `scripts/install-agents.sh install|uninstall|restart|status [listen|crew|build|deliver]`: the four launchd background jobs (`crew` is the Kiro Crew gateway). **Always name the job.** With none named, `install` and `restart` act on all four, which restarts the live listener.

Before touching the night jobs, know these four things:

- **Installing a night job starts its clock from now.** `install build` and `install deliver` count today's time as handled, so a run that was still due is skipped and the first run is at the job's next time. (`restart` leaves the clock alone.) Run both after changing `TZ`, `BUILD_TIME` or `DELIVER_TIME`.
- **Never install one within a minute of the build time or the deliver time** (30 minutes before `DELIVER_TIME`): that night's run could be skipped or cut off. Both refuse while that job is at work.
- **If `preflight` says a night job has not checked the time, wait two minutes and run `preflight` again before reinstalling anything.** A Mac that has only just woken shows exactly that for a minute or two, and reinstalling would skip a run that is still due.
- **The night jobs run the code in the working copy the installer was run from**, and on Henry's Mac that is this repo's main working copy. So build new work in a second working copy (a git worktree), prove it there, and merge. In the second copy, never run the installer's `install`, `uninstall` or `restart`, and put `OVERNIGHT_DATA_DIR=<scratch folder>` on every command: a new working copy has no `.env`, so a bare command would open the real `~/.overnight`.

Built in Milestone 3 (tests pass; it has not yet been looked at on the real data folder, SPEC.md §8):

- `npm run dashboard`: the dashboard, a web page on this Mac that only reads, on port 4321. It prints a link with a key in it (`http://127.0.0.1:4321/?key=...`); the page opens only from that link, so give Henry the link. Stop it with Ctrl-C.
- `npm run dashboard:filming`: the same with what was said hidden (every quote, the ideas nobody approved, the build notes). `npm run dashboard -- --filming --show-quote <ideaId>` lets one idea's quote through.
- `npm run dashboard:demo`: the same pages on invented data in a throwaway folder. Add `-- --play` to have an invented night tick through, `-- --port <n>` for another port. This is the way to try the dashboard or to work on it.
- Options go after the two dashes (`npm run dashboard -- --filming`). Typed before them npm keeps them, and the dashboard refuses to start rather than start without them. `npm run dashboard -- --help` lists them.
- The plain dashboard shows real quotes. In a coding session use the demo, or a scratch folder (`OVERNIGHT_DATA_DIR=<scratch folder> npm run dashboard`), unless Henry is at the screen and asked for it.
- It only reads: outside `packages/dashboard/src/demo` nothing in that package writes a file or opens a database for writing, and `packages/dashboard/test/read-only.test.ts` fails if that changes.

## Code style

- Small modules with clear names. Pure functions where possible; side effects (Bee, filesystem, network) at the edges.
- Validate model output against its zod schema. Retry once, then log and skip. Never crash the listener over one bad response.
- Every outside call has a timeout and a clear error message.
- Idea state changes go through the state machine in `packages/core`. No ad-hoc status strings.

## Definition of done (every milestone)

- Tests and typecheck pass.
- The milestone's checks in SPEC.md pass on Henry's Mac, with real Bee data where the milestone requires it.
- README matches what actually exists and how to run it.
- Friction log and product feedback are updated.
