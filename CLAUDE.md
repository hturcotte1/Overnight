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
- All Bee access goes through `packages/bee`, and it must really call Bee at runtime. That's a hackathon requirement.
- Generated apps follow the app contract in SPEC.md §6: static, no backend, no keys. Published apps are public, so briefs never contain personal details.
- Don't weaken Kiro Crew's sandbox or approval settings.
- No code, data, accounts or hardware from NQB8/Zelcast. Everything in this repo is Henry's.
- Keep the MIT `LICENSE` file at the repo root.

## Stack

- TypeScript (strict), Node 20+, ESM, npm workspaces
- SQLite via better-sqlite3; zod for every model output and every config value
- Tests: vitest. Browser smoke tests: Playwright.
- Detector runs through Kiro headless (`kiro-cli chat --no-interactive`, no tools)
- Publishing: GitHub Pages via the GitHub CLI (`gh`) login
- Times stored in UTC, shown in America/Boise

## Commands (keep this list accurate as they're built)

- `npm install` · `npm test` · `npm run typecheck` · `npm run lint`
- `npm run eval:detector`: detector golden set (precision ≥ 0.85, recall ≥ 0.7)
- `npx overnight listen` · `npx overnight queue --approved --json` · `npx overnight build-now <id>` · `npx overnight deliver` · `npx overnight pause|resume`
- `npm run dashboard` → http://localhost:4321
- `scripts/install-agents.sh`: installs or reloads the launchd agents

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
