# Product feedback

Feedback on every tool, API and SDK Overnight uses. The hackathon requires this for each one. Each section answers the same five questions. Specific surprises, with steps, live in [friction-log.md](friction-log.md) (entries F-001 to F-056); test results live in [spikes.md](spikes.md).

Last updated: 2026-10-12, after Milestone 3 (dashboard and hardening) was built. Everything below comes from running the real tools on one Mac, one iPhone and one Apple Watch, plus reading their source where we say so. The listening half of the product runs every day on Bee and Kiro CLI. The building half is built on Kiro Crew, Kiro CLI and Playwright. It was rehearsed for real on Oct 10 and ran its first real night on Oct 10 to 11: an idea heard through Bee was built by Kiro Crew, tested with Playwright, published to GitHub Pages and put on the wearer's wrist through Bee, with nobody at the Mac.

Each section ends with what Milestone 3 taught. One thing to keep in mind while reading those parts: Milestone 3's new sandbox rules and its every-minute night jobs have so far met tests and stand-ins only, not a real Kiro Crew gateway, a real Kiro CLI build or the real macOS job system. Where a lesson rests on that, it says so.

---

## Bee CLI and live stream (`@beeai/cli` 0.7.3)

- **What we used it for:** Logging a Mac in to a Bee account, and the live event stream that feeds Overnight's always-on listener (`packages/listener`). After a disconnect the listener catches up with `bee changed` and `bee conversations transcript`.
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
  - For an always-on listener: a dead connection can't be told from silence (F-030), and lines recovered after a disconnect can't be matched to saved lines by id (F-024).
  - Smaller things: a 478 MB install (F-001), `bee status` exits 0 when logged out (F-003), help text on standard output when a command fails (F-007), `--flag=value` rejected (F-008), a first `bee changed` that returns a whole day (F-014), `--clear-alarm` that doesn't clear (F-023).
- **Onboarding:** Quick: one install command, one QR scan, one stream command, and live utterances were on screen. The one thing we needed that we couldn't find written down was "turn on notifications for Bee".
- **Would we build with it again:** Yes. Live transcripts from the wrist in a few seconds, through a one-line stream command, is the thing that makes this project possible. We'd want accurate payload docs and a setting to keep short recordings.
- **What Milestone 3 taught:**
  - A stream needs a listener that is awake, and catching up afterwards does not cover everything. Lines missed during a gap can be fetched again for conversations Bee keeps, but very short recordings are deleted after about six minutes (F-010), and those are where one-sentence ideas live. By reasoning from those two measured facts, not by a test: a Mac that sleeps loses exactly the ideas Overnight is for. That is one reason the listener now asks macOS to keep the Mac awake on battery too (built, and not yet tried on battery). A way to fetch short recordings later, or to keep them, would take that pressure off every always-on client.

## Bee library (`@beeai/cli/lib`)

- **What we used it for:** Every Bee call in the product goes through `createBeeClient()` inside `packages/bee`: login check, stream, to-dos, conversations. `node packages/bee/src/smoke.ts` is a read-only check that it works.
- **What worked:** A tiny, readable wrapper (one 15 KB file). `sse.streamJson()` gives an async iterator, which suits a long-running listener. `runJson([...])` is a handy escape hatch for commands the library doesn't wrap.
- **What needs work:** It looks `bee` up on `PATH` instead of using the binary inside its own package, and reports a missing binary as "not authenticated" (F-004). It lacks helpers for transcript and fact search, and everything is typed `unknown` (F-005). It can crash the host program when the binary is missing (F-025), can corrupt text on the stream (F-026), and has no error codes, only English sentences (F-032). Reading its source, closing a stream surfaces as an error thrown from the iterator, which callers have to expect.
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
  - A create that times out can't be safely repeated (F-031), and `--clear-alarm` doesn't clear (F-023).
  - There's no purpose-built way to ask the wearer a question. A to-do works, but an "ask" with yes/no buttons on the watch would be a far better fit, and safer than overloading the to-do list.
- **Onboarding:** Trial and error with a real phone, since the behaviour we needed isn't documented.
- **Would we build with it again:** Yes for facts. For approvals, yes as a workaround; a real prompt API would replace it immediately.
- **The first real night and Milestone 3:**
  - The morning half worked for real on Oct 11. The deliver job created the to-do with the link and then the fact, and the wearer's watch buzzed at the alarm time that was set.
  - A to-do with an alarm is also the only way we have to say "your app is late, here it is". The alarm time is ours to work out: two minutes ahead in the daytime, and the next morning if that would land in the night. An alarm that Bee itself held back during set quiet hours would let a client stop doing that sum.
  - Milestone 3 made our own notes more careful about the gap in F-031. When Bee gives no usable answer to `todos create`, we used to write "told in Bee". We now write that the to-do "may or may not exist; no second one is made", because that is all we know. The wearer can miss a note for good this way. A client-supplied key on `todos create`, or a way to ask "did the to-do I just sent arrive?", would close it.

## Kiro Crew (0.8.0)

This section doubles as our AWS Builder side-prize write-up.

**How Overnight uses Kiro Crew.** Kiro Crew is Overnight's first-choice builder. Each night, for every idea the wearer approved, Overnight writes a one-page brief and adds one Kiro Crew agent job for it. The job gets a one-sentence message: where the brief is, which folder to work in, and to follow our `overnight-build` skill, which is installed as a Kiro Crew skill and carries the whole contract for an Overnight app. The job runs unattended (`--approval-mode auto`, no saved session, a time limit), started by `kirocrew cron trigger`. Overnight watches Kiro Crew's own files to see when the run is over, decides from the files the agent left whether the build worked, and always removes the job. The Kiro Crew gateway itself runs as one of our background jobs, inside a macOS sandbox of our own, and a zero-credit Kiro Crew command job checks that sandbox before each night's builds. Its first real night was Oct 10 to 11: the nightly job started by itself, the sandbox check passed against a gateway that had sat idle for three hours, and Kiro Crew built the approved idea's app in 160 seconds for 4.59 credits. Since Milestone 3 Overnight also reads Kiro Crew's usage records after every run, to count what its builds cost against a monthly ceiling, and moves each finished build out of the reach of later jobs.

- **What we used it for:**
  - Seven real agent builds of small web apps from a one-page brief, each through the recipe above: five in experiments, one in the rehearsal and one on the first real night.
  - Scheduling experiments: one-shot jobs, daily jobs, jobs started on demand.
  - Zero-credit command jobs: as probes of what a job can reach, and as the nightly sandbox check.
  - Its history and usage files, to know when a run ended and what it cost.
- **What worked:**
  - It builds unattended. Seven of seven agent builds ended with an app that built, in about 2 to 4 minutes each. Where we checked further, the app's own browser test passed too.
  - Skills are a good fit. One skill file holds our rules and the app contract, so the job message stays one sentence, and a changed skill is picked up without restarting the gateway.
  - `kirocrew cron trigger <id>` starts a job within a second. One-shot jobs ran to the second.
  - Zero-credit command and script jobs are a thoughtful feature. They made our nightly sandbox check free.
  - Its state is plain files: a marker while a job runs, a history row when it ends, a usage row per job with credits. Our code reads those and never has to parse what a job printed.
  - The gateway has a health address and a cancel address on this Mac, and both work.
  - It ran inside our own, much tighter sandbox once one setting was switched on. Kiro still signed in there with the Keychain cut off.
  - A one-line install with no admin rights that brings its own Python, plus version pinning (`--version 0.8.0`).
  - It refuses jobs whose command mentions credential folders like `~/.ssh`.
- **What needs work:**
  - The sandbox. On macOS it does not keep the user's GitHub login, another app's login or the user's files away from a job, even at `strict` (F-022, F-033). It can't be told that an outer sandbox is in charge without switching itself off entirely (F-034). Its level does not apply to command jobs, and `doctor` does not show it (F-035). And when the gateway runs inside an outer sandbox, that one sandbox covers every job, so there is no fence between two jobs.
  - Running inside an outer sandbox takes detective work. It must be able to open every folder above its own, and it drops `PATH` folders it can't open without saying so (F-042). `kirocrew` stops with a Python error when it may not look at its working folder (F-043). It rewrites agent files in a folder it shares with Kiro CLI (F-044).
  - Unattended jobs. Under default approvals an agent job does nothing and is recorded as a success (F-021). A job's "success" only means the session ended, and there is no working-folder option (F-037).
  - Stopping. `kirocrew cron remove` does not end a job that is running, and we found no command that does (F-039).
  - Scripting. `kirocrew status` and `cron trigger` exit 0 when they fail (F-020, F-040), and `config get` writes to a log and prints Python-style values (F-041).
  - Cost. A build costs 2.6 to 4.6 credits (1.3 to 1.7 a minute), and even a one-line agent job costs 0.4 to 0.5. A simpler app through Kiro CLI cost 0.4 (F-036). Our one Kiro CLI build of a full brief was not costed on its own.
  - Daily jobs start at a random time up to 59 minutes late, and the CLI flag the docs give for turning that off doesn't exist in 0.8.0 (F-020). Its own description of a schedule was an hour off across a clock change (F-050).
  - `kirocrew doctor` fails a healthy install over an optional voice feature (F-019), and its output is very long.
  - Docs and released CLI disagree in several places.
- **Onboarding:** Install to first scheduled job in about ten minutes, all from the command line. Working out why the health check failed, and why an agent job silently did nothing, took reading its source. Getting from "it runs a job" to "it is safe to leave alone at night with a coding agent" took most of a day of experiments.
- **Would we build with it again:** Yes, as the thing that runs a coding agent on a schedule with a skill and keeps plain files about each run. We would not rely on its own sandbox on a personal Mac, and we keep Kiro CLI as a second builder that needs none of the workarounds. The wish list, in order: an "outer sandbox" mode that keeps Crew's own file protections, a sandbox that really withholds credentials, a `cron cancel` command, exit codes that mean something, and a per-job working folder.
- **What the first real night and Milestone 3 taught:**
  - **It worked unattended, for real.** A gateway that had been idle for three hours started an agent at 2 a.m. and built the app, once our own code had renewed Kiro's hourly sign-in outside the sandbox first (F-051).
  - **Its usage records made a budget possible.** One row per job with the credits it used is exactly what a monthly ceiling needs, and the first real night's 4.59 credits came straight from it.
  - **But a job can write those records** (F-054). The usage file is inside the folder every job must be able to write, so a build job can change what Kiro Crew says the build cost. We now believe a figure only when the agent's running time makes it possible. Not known yet: whether a run that was cancelled or ran out of time gets usage rows at all.
  - **One sandbox for every job has a second cost.** With the whole gateway inside our sandbox, a later job could change an app an earlier job had finished. Milestone 3 moves each finished build to a folder no job can reach and copies its files afresh. A per-job working folder that the gateway itself fences off would make that unnecessary.
  - **The list of running programs cannot be hidden from its jobs** (F-053). The rule that hides it also refuses a program its own process group, and Kiro Crew's code asks for process groups to look after its jobs.
  - **Its own socket files are in its own home folder**, which made it possible to refuse every other program's socket file to a build job without, as far as its code shows, getting in its way.
  - **Still to be shown:** all of Milestone 3's new sandbox rules against a real gateway and a real agent job, and whether Kiro Crew accepts our nightly check's longer command (3,562 characters; we found no limit written down). Those are the first proofs still to be run.
  - **Two more for the wish list:** usage records a job cannot write, and a documented list of what the gateway asks of the operating system, so that an outer sandbox can allow exactly that.

## Kiro CLI (2.29.0)

- **What we used it for:** Two headless jobs through `kiro-cli chat --no-interactive`. (1) The idea detector in `packages/detector`: a no-tools call that turns a transcript into one JSON verdict. It is part of the running listener. (2) Overnight's second builder: when Kiro Crew fails or can't start, Kiro CLI builds the app from the same skill text, inside a sandbox of our own (`--trust-tools read,write,shell`).
- **What worked:**
  - Headless mode is solid. A short request returns in about 4 seconds with clean text on standard output and tool activity on standard error.
  - As a detector with a no-tools custom agent: on our 66 synthetic transcripts it asked about all 24 ideas and none of the 42 non-ideas (earlier runs: precision 0.88 to 0.96, recall 1.00), in about 3 to 5 seconds and 0.016 credits per call. Four calls at a time sharing one settings folder worked without a hitch across hundreds of calls.
  - The prompt can be piped in on standard input instead of being put on the command line. A 13.8 KB prompt, several lines, accents and emoji all arrived whole. That took what was said out of the Mac's process list (spike 9).
  - As a builder: a working Vite + TypeScript app, built and self-checked, in 52 seconds for about 0.4 credits (spike 6). It followed every instruction, including writing honest build notes about what it had not verified.
  - As a builder inside our deny-by-default sandbox: a real app from an invented brief in 99 seconds, with `npm install`, the build and a Playwright test all run by the agent inside the sandbox. It signs in and works with the Keychain cut off.
  - `kiro-cli settings <key>` answers inside the sandbox, so the builder can check that content sharing is off before it sends a brief.
  - `/usage` works headless, so a script can read the plan and credits used. The saved chat file also records the prompt's length, how many tools ran and the credits per turn, which made "no tools ran" and "what did that cost" easy to check.
  - A missing agent name fails fast with exit code 4.
- **What needs work:**
  - A prompt given as an argument is readable by other programs, twice, and `chat --help` doesn't mention standard input (F-045).
  - The Mac install is a desktop app (364 MB download, about 650 MB installed) with a login item (F-015).
  - Sign-in and upgrade have several traps (F-016).
  - No `--no-tools` flag: the default agent can read files with no trust flags given (F-018).
  - No timeout flag, so every caller must build their own and kill the whole process group.
  - `KIRO_HOME` moves some of its files but not its settings file or its sign-in (F-046).
  - Docs describe options the latest release lacks (F-017).
  - No structured-output mode, so replies need our own checking and repair (F-029); every headless chat is saved to disk with no off switch (F-028); reading a never-changed setting is an error (F-027).
- **Onboarding:** Install and sign-in took about ten minutes including one wrong-account detour. After that, the first headless call worked first time.
- **Would we build with it again:** Yes. Fast, cheap, and scriptable. Using the same tool for classification and for building means one account and one bill. It was also the easier of the two builders to fence in: it needed no setting changed and no exception in the sandbox.
- **What the first real night and Milestone 3 taught:**
  - **The detector found the idea that became the first real night's app**, in a real conversation on Oct 10 (confidence 0.92, in 6.1 seconds).
  - **It stayed the easier builder to fence in.** Milestone 3 gave its build profile two rules the Kiro Crew gateway's profile cannot have (the lists of running programs and of running apps are hidden), plus the two new ones both share (other programs' socket files, and our dashboard's port). Under all of them together `kiro-cli --version` and one `kiro-cli settings` read still answered. **A real build under them is still to be run**, so this is a promise of the design, not yet a result.
  - **A headless chat does not say what it cost.** Kiro Crew writes a usage row per job; a `kiro-cli chat --no-interactive` run hands its caller no figure. For our monthly ceiling we estimate every Kiro CLI build at 2 credits for each minute it ran. The figure is in the saved chat file (spike 9), which we have not wired up. A last line with the credits used, or a flag for it, would be better than both.
  - **Two socket files of the desktop app's sit in the user's temporary folder** and nothing says what they are for (F-056). We now refuse them to a build, and do not yet know whether a headless chat misses them.
  - **The two content-sharing settings have to be set by hand on a new install** before our Kiro CLI builder will build at all: reading a setting that was never set is an error (F-027), and we treat "could not read" as "not off". Our README now makes those two commands a required step.
  - **The hourly sign-in (F-051) still shapes the night.** A build starts only with at least ten minutes of sign-in left, and nothing can renew it from inside the sandbox once the build is going. Builds take 2 to 4 minutes, so it has not bitten.

## GitHub Pages (via the GitHub CLI)

- **What we used it for:** Publishing each finished app as a public web page under `hturcotte1/overnight-apps`, one folder per app. Spike 7 created the repo, turned Pages on and published a test page, all from a script. The deliver step built in Milestone 2 publishes the same way. Its first real publishes were the rehearsal's app on Oct 10 (live 21 seconds after the push) and the first real night's on Oct 11 (26 seconds), both pushed by Overnight's own publisher under the name "Overnight", the second one by the morning's background job with nobody at the Mac. Since Milestone 3 one small request to GitHub's address, with no login in it, is also how a night run asks "is there real internet?" before it starts; it answered in under a fifth of a second when tried.
- **What worked:** `gh auth login --web` took about a minute: paste a code in the browser and the CLI is logged in, with the token in the macOS keychain. Our code never touches the token. One API call turns Pages on (`gh api -X POST repos/<owner>/<repo>/pages -f "source[branch]=main" -f "source[path]=/"`). The first publish was live 53 seconds after the push and the second after 21 seconds. `pages/builds/latest` reports build status and duration, which makes "is it live yet?" checkable. The default login scopes were enough for everything. A background job that is given only the home folder and a `PATH` can still publish: `gh` finds its stored login and `git` finds the helper that goes through `gh` (checked Oct 10), so no token ever has to be put in a variable.
- **What needs work:** By default Pages runs Jekyll, which silently drops files whose names start with `_`; our test file returned 404 until we added an empty `.nojekyll` file at the repo root. Nothing in the push or build output warns about it. Run without a terminal, `gh auth login` doesn't connect git to the login, so `gh auth setup-git` is a separate step you have to know about.
- **Onboarding:** Easy. No admin rights needed: the official zip unpacks into the home folder.
- **Would we build with it again:** Yes. Free, fast enough for a morning delivery, and fully scriptable.

## Playwright (1.64.0)

- **What we used it for:** The gate before anything is published, and the pictures.
  - Our own "contract" test loads the built app in the Chromium headless shell (the small browser with no window) at a phone size and a desktop size. It counts what went wrong (a page that did not load, nothing visible, console errors, failed requests, requests to anywhere but this Mac, a page too wide for a phone) and takes the two screenshots.
  - Then the app's own smoke test, which the build agent wrote, runs with our Playwright and our settings file.
  - The build agent also runs its smoke test while it builds, inside the build sandbox.
  - All of it runs inside a macOS sandbox, because an AI wrote the code under test. The version is pinned to 1.64.0 so that the agent's test and the browser on this Mac match.
- **What worked:**
  - The headless shell runs inside a very tight sandbox: no macOS system services except the one name Chromium's own processes use to find each other, no network but one local port, the home folder closed. Launching it needed no special options.
  - It is fast. A whole verification (install, build, our test, the app's test) takes about 5 seconds with a warm npm cache; our test is 2.4 seconds of that and the app's 0.7.
  - Watching a page's requests, console and errors, and taking screenshots at two sizes, is a few lines each.
  - Agent-written smoke tests worked. The agent-built apps we put through the full morning check each shipped a test that passed under our settings.
  - Environment variables for the results folder and the cache folder (`PWTEST_CACHE_DIR`) let each step have folders of its own.
  - The docs give a way to install just the small browser (`npx playwright install --only-shell`), which is all Overnight uses.
- **What needs work:**
  - The default launch switches Chromium's own sandbox off, and full Chromium misbehaves inside a macOS sandbox: once it reopened as a visible window (F-038).
  - A plain `testMatch` string matches in every subfolder, so an untrusted test with the same file name runs too (F-047).
  - The browser is still running after the test runner's process group is killed (F-048).
  - Compiled tests are kept in the shared temporary folder and used again (F-049).
- **Onboarding:** One install command and a ten-line settings file, and the first test ran. Getting it to run inside a tight sandbox, and working out which of the four points above mattered for running code we don't trust, took experiments and reading its source.
- **Would we build with it again:** Yes. It is the piece that lets Overnight say "this app loads, works on a phone and talks to nobody" before it puts a link on someone's wrist. For anyone testing code they did not write, we would add a short "running untrusted tests" page to its docs.
- **What the first real night and Milestone 3 taught:**
  - **The gate held on a real morning.** On Oct 11 the morning's checks passed inside the sandbox in 6.6 seconds on an app Kiro Crew had built overnight (3 files, nothing fetched from outside, no errors, fits a phone), and only then was it published.
  - **A second use, as a library.** Milestone 3's dashboard is tested in the same headless browser, driven straight from our unit-test runner with no separate test command. That is how we know its pages fit a phone, have no console errors, ask nothing of the outside world, keep their text contrast in light and dark, and show hostile invented titles as plain text.
  - **What worked well there:** answering a page's requests from memory (`context.route`, a "not changed" answer included), so a page script can be tested with no port open; a time zone and a light or dark scheme per browser context; `bypassCSP` when the point of a test is the page's own escaping; and reading every header of a request to see what the browser says about where it came from. The pictures in our README are its screenshots of invented data.
  - **What needs work:** `page.waitForFunction` with a condition written as text fails on a page whose policy forbids running text as code (F-055).
  - **Under tighter rules still.** With Milestone 3's new build-sandbox rules (every other program's socket file refused, the lists of programs and apps hidden for Kiro CLI), the headless browser still launched, opened a local page, clicked and took a screenshot, on a made-up home folder. A real agent running its own smoke test under those rules is still to be shown.
  - The dashboard's browser tests are skipped when the headless browser is not installed. Whether the whole test suite passes on a Mac without it is still to be tried, with the clean-clone trial.
