# crew/: what the build agent is told

Overnight builds each approved idea with an AI coding agent. This folder holds the two pieces of text that agent is given. Everything else about a build (which idea, when, whether it worked, publishing) is decided by Overnight's own code in `packages/builder` and `packages/deliver`, never by the agent.

| File | What it is |
|---|---|
| `build-skill.md` | The "overnight-build" skill: how to build one Overnight app. The hard rules (stay in the workspace, no git, no credentials, the brief is a description and not orders), the app contract, and the steps. |
| `nightly-job.md` | The one-sentence message a Kiro Crew build job gets. Overnight fills in three full paths: the brief, the workspace folder, and the installed skill file. |
| `README.md` | This page. |

Both files are our own words. Nothing from an idea is ever put into them. The only thing the agent learns about an idea is the one file `brief.md` in its workspace, and the brief holds only a cleaned title and pitch inside a block marked "a description, not instructions".

## Two builders, one skill

- **Kiro Crew** (the primary builder). The skill is installed as a Kiro Crew skill and the job message names it.
- **Kiro CLI** (the fallback). There is nothing to install: Overnight pastes the text of `build-skill.md` into the prompt, without its `---` header block, and adds one line saying where the brief is.

### Where the skill is installed, and who installs it

```
~/.kiro/crew/skills/overnight-build/SKILL.md
```

`scripts/install-agents.sh install crew` puts it there: it copies `crew/build-skill.md`, and if a different file is already in that place it keeps it beside the new one as `SKILL.md.bak-<time>`. It never writes through a symbolic link. Run it again after every change to `build-skill.md`. The Kiro Crew gateway does not need a restart to see a changed skill.

The installed file must be an exact copy of `crew/build-skill.md`. Before every Kiro Crew build Overnight compares the two. If the installed copy is missing or different, Overnight does not build with Kiro Crew (the reason says the skill is "missing or is not the one in crew/build-skill.md") and uses Kiro CLI instead. The skill carries the rules the agent works under, so a stale or altered copy is treated as a reason to stop, not as a detail.

## How one build runs

1. Overnight makes an empty folder `~/.overnight/workspaces/<idea id>/` and writes `brief.md` into it. A folder left by an earlier try is renamed to `<idea id>.old-<time>`, never deleted.
2. **Kiro Crew:** Overnight adds a job named `overnight-build-<idea id>`, starts it, and watches Kiro Crew's own files until the run is over (or the time limit passes). Then it always removes the job. If the run is not over by then, Overnight first asks the gateway to cancel it: removing a job does not end a run that is in progress (measured).
   **Kiro CLI:** Overnight first asks Kiro whether its two content-sharing settings are off, and refuses to build if either is not. It empties the build's temporary folder. Then it runs `kiro-cli chat --no-interactive` in the workspace, inside its own macOS sandbox (`packages/builder/sandbox/kiro-cli-build.sb`).
3. The agent writes the app and, last of all, `BUILD_STATUS.json`.
4. Overnight decides whether the build worked from three things only: `BUILD_STATUS.json` says `"built"`, that file was written after the build started, and `dist/index.html` exists. Kiro Crew's own "success" is ignored: it only means a session ended.
5. Overnight records the idea as built and then moves the whole workspace to `~/.overnight/built/<idea id>/`. No build job can reach that folder (see "Finished builds" below).
6. In the morning the deliver step rebuilds the app from a clean copy of that folder, runs its own browser test, and only then publishes.

The agent never runs the `overnight` command, never sees the database, and never publishes.

### If a build is stopped or cut off

When `overnight build` or `overnight build-now` is told to stop (Ctrl-C, a closed window, macOS stopping the background job), it does not just exit. Within 10 seconds it:

1. stops waiting,
2. ends the build: a Kiro Crew run is cancelled and its job removed; Kiro CLI and everything it started is killed,
3. records the idea as failed with the reason "the build was stopped",
4. starts no further build, and finishes.

A build whose process was killed outright (a crash, a restart, a power cut) is found by the next run, once its time limit plus 15 minutes has passed, and recorded as failed with the reason "the build was interrupted".

Neither is the idea's fault, so **the nightly run tries such a build once more**:

- An idea whose build was stopped or interrupted waits in the same line as the approved ideas, in the order they were approved. The second try counts toward the nightly limit like any other build.
- Each idea gets at most two starts this way. If the second one is also stopped, interrupted or fails, the idea stays failed.
- The wearer is told "couldn't finish" only then. Until the second start has ended badly, the morning step says nothing about the idea.
- A build that really failed (the agent could not make the app, or neither builder could start) is never tried again by the nightly run.
- An idea the wearer has already been told about is never tried again by the nightly run.
- `npx overnight build-now <idea id>` is not bound by any of this: it builds any approved or failed idea when a person asks.

The rule itself lives in `packages/core/src/build-retry.ts`. The log has one line, "trying a build again", each time a second try starts.

### Finished builds

A workspace is where an agent works, so build jobs can read and write there. With Kiro Crew that means every idea's workspace: one sandbox covers every job the gateway starts. A finished app left in `workspaces/` could be changed by a later job before the morning publishes it.

So a finished build does not stay there:

- As soon as an idea is recorded as built, its workspace is renamed to `~/.overnight/built/<idea id>/` (`packages/builder/src/seal.ts`). Whichever builder made it.
- Both sandbox profiles close all of the data folder except `workspaces/`, `tmp/build/` and `tmp/build-probe/`, so nothing in `built/` can be read, listed, written, run or moved by a build job. The sandbox check tries it every night (below).
- The order is "record, then move". If Overnight is killed between the two, the app is still in `workspaces/` and the morning uses it from there.
- Before an idea is built again, an older finished build of it is renamed to `built/<idea id>.old-<time>`, never deleted. If that cannot be done, the build is not started.
- If the move itself fails, the idea stays built, the log has an error ("a finished build could not be moved out of the builders' reach"), and the morning uses the app where it is.

What this does not cover: a workspace while it is being built, and the `<idea id>.old-<time>` folders that failed tries leave in `workspaces/`. A Kiro Crew job can still reach those.

### What builds cost

Overnight counts what its builds use, and stops building for the month at a ceiling: `MAX_BUILD_CREDITS_PER_MONTH` in `.env` (400 unless set; 0 means never build). The month is the calendar month in `TZ`.

- **One row per try that started an agent.** A build that needed both builders has two rows. A try that could not start has none.
- **Kiro Crew's own figure when there is one.** After the run is over (cancelled, if it had to be) Overnight reads Kiro Crew's usage file for that job. This goes for a build that failed, ran past its time limit or was stopped as much as for one that worked.
- **An estimate when there is none:** 2 credits for each minute the agent ran, at least 0.1. Kiro CLI gives no figure, so its builds are always estimated. The agent's time is never taken to be longer than the build's time limit: if the Mac slept in the middle of a build, the hours asleep are not the agent's.
- A figure no build could have used (negative, or above 100,000) is not believed; the estimate is counted in its place. Kiro Crew's usage file is one a build job can write.
- **Asked before each idea, never during one.** One build can take the month over the line; the next one waits. `overnight build` then says "this month's build credits are used up (… of … counted)", and `build-now` refuses with the same words. Nothing buzzes.
- **It fails open.** If the count cannot be read or written, that is logged as an error and the build goes ahead. A fault in the ceiling must not cost a night.

It is a count of what Overnight saw, not Kiro's bill: the detector's credits are not in it, and neither is a build whose process was killed before it could write its row.

## The sandbox

A build agent runs as the Mac user. Left alone it could read everything in the home folder, reach the GitHub login (in the Keychain), the Bee login and the transcript database, and change files that other programs run later. What stops it is a sandbox: a set of rules macOS enforces on a program and on everything that program starts.

For the Kiro Crew gateway there are two choices. It is one setting, `BUILD_SANDBOX`, read by Overnight's config. **The default is `overnight`** (the owner's decision of Oct 10).

| | `BUILD_SANDBOX=overnight` (the default) | `BUILD_SANDBOX=crew` |
|---|---|---|
| How the gateway is started | By `scripts/install-agents.sh install crew`, inside Overnight's own sandbox profile (`sandbox-exec -f packages/builder/sandbox/crew-gateway.sb -D ... kirocrew gateway ...`) | By the same installer, without a profile |
| Kiro Crew's own sandbox | Off: `agent.sandbox_allow_unsandboxed_exec = true`. Kiro Crew refuses to run any job inside a sandbox it did not make unless this is set. | On, at its `strict` level |
| What a job can reach (measured, Oct 10) | None of: the Keychain entry with the GitHub login, Bee, the transcript database, the folders in the home folder, other programs' command lines. It cannot write where programs are installed or started from. | The Keychain entry, Bee and the transcript database, and it can write anywhere in the home folder. (What else it can read there was not measured.) |
| Check before building | Overnight reads the setting above, then runs the **sandbox check** below | Overnight reads Kiro Crew's settings and refuses to build unless the sandbox is on and `strict` |
| Overnight's own `kirocrew` commands | Run inside the same sandbox as the gateway | Run normally |

Overnight only ever *reads* Kiro Crew's settings. The installer does not change one either: when the setting is not what `BUILD_SANDBOX` needs, `install crew` stops and prints the one command to run.

The profile says itself which values it must be started with (`HOME`, `DATA_DIR`, `REPO`, `NODE_DIR`, `NPM_CACHE`, `KIRO_HOME`, `CREW_HOME`). The installer and the builder both read those names out of the profile and fill them with real paths (no symbolic links), so the gateway and Overnight's own commands always run behind the same fence.

### What a build can and cannot do (`overnight` mode, and the Kiro CLI builder)

Both profiles in `packages/builder/sandbox/` follow the same two rules:

- **Nothing in the home folder, the data folder, this repo, the Node.js folder, other disks, `/Users/Shared` or the shared temporary folders can be read or run, except a short list.**
- **Nothing in those places, or where programs are installed, can be written, except a shorter list.**

A real gateway start, sandbox check and agent build ran with exactly these lists (Oct 10), and so did a real Kiro CLI build. The rules about socket files, the dashboard's port and (Kiro CLI only) the lists of running programs and apps were added on Oct 11. They are tried against a throwaway gateway by `spikes/11-hardening-proof.ts` (see "Proving a change to a profile" below).

A build **can read and run**:

- its workspace. With Kiro Crew: every folder under `~/.overnight/workspaces/` (one sandbox covers every job the gateway starts, so it cannot tell one idea's workspace from another's). With Kiro CLI: its own workspace only.
- the build jobs' own temporary folder, `~/.overnight/tmp/build/`. It is the only temporary folder there is for a build: `/tmp`, `/var/tmp` and the account's usual temporary folder are closed. (A Kiro Crew *agent* is handed a folder of its own by Kiro Crew, under `~/.kiro/crew/scratch/`. The gateway itself, command jobs and Kiro CLI builds use `~/.overnight/tmp/build/`. The Kiro CLI builder empties it before each build.)
- `node`, `npm` and `npx`, and nothing else in the Node.js folder (the Bee program is installed there too)
- npm's package store, `~/.npm/_cacache/`
- the browser for the app's smoke test, `~/Library/Caches/ms-playwright/`
- Kiro CLI's own files: `~/.kiro/settings/`, `~/.kiro/sessions/`, `~/.kiro/agents/`, `~/Library/Application Support/kiro-cli/`
- Kiro Crew only: Kiro Crew's own folder and program (`~/.kiro/`), in `~/.local/bin/` the links to Kiro's own programs and nothing else (`kirocrew`, `kiro-cli`, `kiro-cli-chat`, `kiro-cli-term`, `python3.12`), `~/workplace/kirocrew-workspace/`, and `~/.overnight/tmp/build-probe/` (the sandbox check's results)

A build **can write**:

- its workspace (as above) and the temporary folder
- npm's package store and npm's logs (`~/.npm/_logs/`; a log can be written, never listed or read back)
- Kiro CLI's own: `~/.kiro/sessions/` and `~/Library/Application Support/kiro-cli/`
- Kiro Crew only: `~/.kiro/crew/`, `~/.kiro/crew-auth-staging/`, `~/workplace/kirocrew-workspace/`, the probe's results, and in `~/.kiro/agents/` only Kiro Crew's own files (names that begin with `kirocrew` or `.kirocrew`, and the `tmp….tmp` file each one is written through)

A build **cannot**:

- read, list or run anything else in the home folder: `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library` (browser profiles, other programs' data), `~/.claude` and `/private/tmp/claude-<number>` (Claude Code's session records and scratch folders), `~/.ssh`, `~/.config`, this repo
- read Overnight's data folder (apart from the folders named above) or the repo's `.env`
- read, list, write, run or move anything among the finished builds in `~/.overnight/built/`
- run `gh`, or the Bee program that is installed on this Mac
- write where programs are run from or settings are read from: `~/.local`, the Node.js folder, `~/.kiro/crew-venv`, `~/.kiro/crew-python`, `/Applications`, this repo, `~/.zshenv` and the other shell start-up files, `~/.gitconfig`, `~/.config`, `~/Library/LaunchAgents`, `~/Library/Preferences`, `~/.kiro/settings`, Kiro's steering, skills and prompts folders, `~/.npm/_npx`
- use the Keychain, the clipboard or the ssh agent, start other apps, run `launchctl`
- connect to another program's socket file (the way a terminal that keeps sessions, a container tool, an editor or a password manager's helper is reached). Every socket file is refused, except the system's name service (without it no host name can be looked up) and those inside folders a build may write anyway: the temporary folder, its workspace and Kiro CLI's own folder, and with Kiro Crew also Kiro Crew's own folders, the other workspaces and the sandbox check's results folder
- connect to Overnight's dashboard (port 4321 on this Mac), or take that port for itself
- Kiro CLI only: list the running programs, or the running apps
- send a signal to, look at, or read the command line of any program it did not start itself. (This mattered most while the detector handed Kiro what was just said as a command-line argument. Since Oct 10 it sends that text on standard input instead; a listener started before the change keeps the old way until it is restarted.)

It **can still**:

- use the network;
- connect to any port on this Mac except the dashboard's. The gateway's own port has to stay open and a build serves its own preview on one, so anything else that listens on this Mac without a password is in reach;
- read macOS's own files outside the home folder (`/Applications`, `/Library`, `/System`, `/usr`, `/private/etc`);
- **Kiro Crew only: list the running programs and apps** (names and process numbers, never command lines). The rule that hides the list of programs also refuses a job's own process group (measured Oct 11), and Kiro Crew asks for exactly that to look after its jobs;
- **Kiro Crew only: list the names directly inside the home folder, `/Users`, `~/.kiro`, `~/workplace`, `~/.local` and the Node.js folder.** Kiro Crew 0.8.0 will not start an agent unless it can open every folder above its own folder and above the folder it runs the agent in, and it drops from the agent's `PATH` every folder it cannot open that way (tried: without this an agent job fails at once, or runs without `node`). Opening a folder lets its names be listed; the sandbox cannot tell the two apart. Nothing behind the names can be looked at, opened or run. A Kiro CLI build cannot list any of them.

That is why the brief is kept to our own words: what the agent is fed is the first protection, and the sandbox is the second.

Most folders on the "can write" list must already exist: the sandbox lets a build fill them, not create, move or replace them. They all exist once Kiro CLI and Kiro Crew have each been run once on this Mac.

### The sandbox check (`overnight` mode only)

Once per `overnight build` run, before the first Kiro Crew build, Overnight adds one Kiro Crew "command" job (these cost no Kiro credits) that tries, from where a build agent would run:

1. reading the Keychain entry that holds the GitHub login,
2. calling Bee as the logged-in user, with a copy of the Bee program that a job is able to run (the copy sits in the check's results folder while the check runs and is removed afterwards),
3. reading the transcript database,
4. listing `~/Documents`, `~/Library` and `~/.claude`,
5. finding, with `pgrep -f`, a harmless stand-in process that Overnight starts outside the sandbox for as long as the check runs (this is what reading another program's command line looks like),
6. making a new file in each of: the home folder, this repo, the folder node is in, the folder Kiro Crew's program is in, and `~/Library/LaunchAgents`. (The file is removed at once if making it worked.)
7. listing the finished builds in `~/.overnight/built/`. Overnight keeps one small file of its own there, `.overnight-probe-marker`, so that the folder is never empty: "nothing listed" can then only mean "refused".
8. making a new file among the finished builds.

The job writes only byte counts, line counts and 0/1 marks to `~/.overnight/tmp/build-probe/`. All of them must come back as 0 (or empty). If anything is reachable or writable, or the check cannot finish within 3 minutes, nothing is built with Kiro Crew that night; the reason starts with "the build sandbox check failed" and the Kiro CLI builder is used instead.

For the six writes the job's own marks are not the last word. When the job is over, Overnight itself looks from outside the sandbox for the six files the job tried to make. One that is there counts as written, whatever the job reported, and is removed. (Measured Oct 11: where a job may write but not look, `touch` makes the file and still ends with an error, and `rm` then cannot remove it. Going by the marks alone, a fence opened for writing only would have passed.)

`npx overnight preflight` runs the same check on its own, through the same code (`runStandaloneSandboxProbe` in `packages/builder`): Kiro Crew's setting first, then whether the gateway answers, then the job.

**What the check proves:** that the gateway that is running right now was started inside a fence that refuses those fourteen things (three reads, four lists, one look at another program, six writes). A gateway started with no profile, or with one in which any of them has been opened again, fails it. (Tried on Oct 10 with the first twelve: against a gateway started inside a deliberately loosened copy, the check failed and named each opened thing. Each of the fourteen also fails, in the tests, on a copy of the profile loosened in exactly that way.)

**What it does not prove:**

- that every other rule of the profile holds. It tries fourteen things, not everything: for the rest there are tests that run the profile for real around harmless commands (`packages/builder/test/sandbox-profiles.test.ts`).
- anything about the home folder's own list of names, which a Kiro Crew job can read (see above), or about the network, which is open.
- anything about a build that runs later the same night, beyond "the gateway has not been restarted since". The check runs once per `overnight build` run.
- anything about the Kiro CLI builder. It needs no check of this kind and no Kiro Crew setting: Overnight starts it inside its own sandbox, with the profile's values, every time.

Before the first build of a night Overnight also removes jobs of its own that a killed run left on Kiro Crew's list. If the list holds a job that Overnight did not add, it logs an error and removes nothing: a job inside the gateway is able to add jobs, so a person should look (`kirocrew cron list`).

### Proving a change to a profile

The tests run both profiles for real, but only around harmless commands on a made-up home folder. They cannot say what Kiro Crew and Kiro CLI themselves need while they work. `spikes/11-hardening-proof.ts` finds that out on a throwaway gateway, before a changed profile reaches the gateway that builds every night:

```
OVERNIGHT_DATA_DIR=~/.overnight-hardening node spikes/11-hardening-proof.ts check
OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts p1
OVERNIGHT_DATA_DIR=~/.overnight-hardening KIRO_HOME=~/.kiro-hardening KIROCREW_PORT=5478 node spikes/11-hardening-proof.ts p2 --spend-credits
```

- `check` starts no gateway and no Kiro program, and costs nothing. It checks the script's own tools.
- `p1` costs no Kiro credits. It starts a throwaway gateway inside the profile and runs the sandbox check (which must pass, and must fail by name against a loosened copy), one command job that is added, started, cancelled and removed by the builder's own code, and one `kiro-cli settings` question inside the Kiro CLI profile.
- `p2` costs about half a Kiro credit: a one-line Kiro CLI chat and a one-line Kiro Crew agent job, each of which writes one file.

The gateway runs inside a copy of the shipped profile with a few lines added that only report: each use of a socket file, a local port or the list of programs then shows in macOS's log, and the script prints it as counts by program, kind and the shape of the target, never as raw lines. It stops at the first failure.

It refuses `~/.overnight`, `~/.kiro` and port 5476 under any spelling, and it will not run near the night's build or delivery. It installs no background job: the gateway is the script's own child and ends with it.

## Running one build by hand

The normal way, which uses everything above:

```
npx overnight build-now <idea id>
```

It works for an idea that is approved, or whose build failed. It ignores the nightly limit but not the pause switch.

To watch Kiro Crew do one build without Overnight (for finding out why builds fail), with the gateway running and a folder that holds a `brief.md`:

```
kirocrew cron add "overnight-build-test" "Read the brief at /FULL/PATH/brief.md and build the app it describes in the folder /FULL/PATH, following the overnight-build skill. Work only inside /FULL/PATH." \
    --cron "0 3 1 1 *" --timezone America/Boise --approval-mode auto --no-persistent-session --timeout-secs 2700
kirocrew cron trigger <id from "Added job: <id>">     # must answer "Triggered job: ..."
ls ~/.kiro/crew/cron-running/                          # a file named <id>.<run>.json while it runs
cat /FULL/PATH/BUILD_STATUS.json                        # "built" or "failed" when it is done
kirocrew cron remove <id>                               # always
```

In `overnight` mode the folder must be one under `~/.overnight/workspaces/`: the gateway's sandbox lets a job work nowhere else.

Things that will trip you up, all seen in the experiments:

- `kirocrew cron trigger` exits 0 even when it fails. Read what it prints.
- A job whose own schedule is due answers the trigger with `Error: HTTP 409`. The schedule above (3 a.m. on January 1st) is there so that never happens; our jobs are always started by hand.
- Do not add `--minimal-context` to a build job. With it the agent did not see the skill.
- `--approval-mode auto` is needed, on this job only. Without it the agent may look but not write, and Kiro Crew still records a "success".
- `kirocrew cron remove` takes a job off the list but does not end a run that is in progress, and kirocrew has no command that does. Overnight ends one by asking the gateway to cancel it before it removes the job (`packages/builder/src/crew-client.ts`). By hand: let the run finish, or stop the gateway.
- `kirocrew` stops with a Python error when it may not look at the folder it was started in. Inside the sandbox this repo is closed, so Overnight starts its own `kirocrew` commands in `~/.overnight/tmp/build/`.
- When an agent job fails at once with "cannot verify that macOS agent workspace ... a filesystem check failed on '..'", a folder above Kiro Crew's own is closed to it. See "It can still" above.
- A Kiro Crew build costs about 2.6 to 4.6 Kiro credits. A build through Kiro CLI costs less; we have not measured it on its own. Even a one-line agent job costs about 0.4 to 0.5.
- Kiro Crew leaves a folder per run in `~/workplace/kirocrew-workspace/`. They are small and safe to delete.
