# Spikes (Milestone 0)

One small script per outside piece, run for real before we build on it. This file records what each one proved. No Bee data appears here: only field names, timings and yes/no answers.

Last updated: 2026-10-09

## Status

| # | Question | Script | Status |
|---|---|---|---|
| 1 | Is `bee status` OK, and does the live stream deliver Apple Watch utterances? How late? | `spikes/01-bee-stream.ts` | Script ready. Waiting for the Bee login (needs the phone) |
| 2 | Does a recording under ~50 words show up? Does it vanish later? | `spikes/01-bee-stream.ts`, then `spikes/02-bee-short-recording.ts` | Script ready. Waiting for the Bee login |
| 3 | Does a to-do alarm buzz the watch? Does ticking it send `todo-updated` with `completed: true`? | `spikes/03-bee-todo-alarm.ts` | Script ready. Waiting for the Bee login |
| 4 | Do `bee facts list` and `bee facts create` work? | `spikes/04-bee-facts.ts` | Script ready. Waiting for the Bee login |
| 5 | Is Kiro Crew installed and healthy, and does a scheduled job run a shell command on time? | not written yet | Waiting on Kiro research and sign-up |
| 6 | Does `kiro-cli chat --no-interactive` build a hello-world Vite app? | not written yet | Waiting on Kiro research and sign-up |
| 7 | Does publishing a `dist/` folder to `overnight-apps` give a working GitHub Pages link? | `spikes/07-pages-publish.ts` | In progress |
| 8 | Does `kiro-cli chat --no-interactive` (no tools) return valid detector JSON? | not written yet | Waiting on Kiro research and sign-up |

## This Mac's setup

Everything is installed per user, with no admin password and no Homebrew.

| Tool | Version | Where | How |
|---|---|---|---|
| Node.js | 24.21.0 (LTS) | `~/.local/node` | Official `node-v24.21.0-darwin-arm64.tar.gz` from nodejs.org, checksum verified |
| npm | 11.19.0 | ships with Node | |
| GitHub CLI (`gh`) | 2.102.0 | `~/.local/bin/gh` | Official `gh_2.102.0_macOS_arm64.zip` from github.com/cli/cli, checksum verified |
| Bee CLI (`bee`) | 0.7.3 | `~/.local/node/bin/bee` and this repo's `node_modules/.bin/bee` | `npm i -g @beeai/cli@0.7.3` and `npm install` |

`~/.zshenv` adds `~/.local/bin` and `~/.local/node/bin` to `PATH`. Background jobs (launchd) don't read that file, so they must use full paths.

GitHub: `gh` is logged in as `hturcotte1` (token in the macOS keychain, scopes `repo`, `read:org`, `gist`). This folder's `origin` is `https://github.com/hturcotte1/Overnight.git`.

## What we know before any Bee login

Checked on 2026-10-09 against the installed `@beeai/cli` 0.7.3 (its `--help` output and the library source in `dist/lib/`).

**The CLI commands in SPEC §4 exist exactly as written:**

```
bee stream [--types a,b] [--json]
bee changed [--cursor <cursor>] [--json]
bee conversations transcript <id> [--since <epochMs>] [--json]
bee todos create --text <text> [--alarm-at <iso>] [--json]
bee todos update <id> [--text <text>] [--completed <true|false>] [--alarm-at <iso> | --clear-alarm] [--json]
bee todos complete <id> [--json]
bee todos delete <id> [--json]
bee facts list [--limit N] [--cursor <cursor>] [--unconfirmed] [--json]
bee facts search --query <text> [--limit N] [--json]
bee facts create --text <text> [--json]
bee login [--qr] [--no-wait] [--token <token>] [--token-stdin]
```

**The library (`@beeai/cli/lib`) is a thin wrapper that runs the `bee` program:**

- `createBeeClient(options?)` returns `{ auth, api, sse, run, runJson }`.
- Every call spawns `bee <args> --json` and parses what it prints. There is no direct HTTP client in the library.
- `sse.streamJson({ types, signal })` spawns `bee stream --json --types a,b` and returns `{ events, close, process }`. `events` is an async iterable of `{ data, raw }`.
- Reading the source, `close()` kills the child process and the iterator should then throw `Bee CLI stream exited with code 1`, so callers must treat that as a normal stop. To be confirmed in spike 1.
- `api.todos.create({ text, alarmAt })`, `api.todos.update(id, { completed })`, `api.facts.list()`, `api.facts.create(text)`, `api.changed({ cursor })` all exist.
- Missing from the library: `conversations.transcript` and `facts.search`. Use `client.runJson([...])` for those.
- Everything is typed `unknown`. We write our own zod schemas once the spikes show the real shapes.
- The default command is the literal `bee` looked up on `PATH`. We pass `command: node_modules/.bin/bee` so background jobs work.

**Login state:**

- `bee status` prints `Not logged in.` and still exits 0. Use `bee me --json` (exit 1 when logged out) or `auth.isAuthenticated()`.
- `bee ping` answers `pong` without a login, so network reachability and auth can be checked separately.

## Results

Filled in as each spike runs.
