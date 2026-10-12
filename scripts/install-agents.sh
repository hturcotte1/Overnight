#!/bin/bash
# Installs, removes, restarts or checks Overnight's background jobs on this Mac.
#
#   scripts/install-agents.sh install   [job]   put the job in place and start it (safe to repeat)
#   scripts/install-agents.sh uninstall [job]   stop the job and remove it (saved data is left alone)
#   scripts/install-agents.sh restart   [job]   stop and start it again, for example after a code change
#   scripts/install-agents.sh status    [job]   is it running, and the last lines of its logs
#
# [job] is one of the four below, or "all" (the default). With no job named, install and restart
# act on every job, so a listener that is running is stopped and started again too: name the job
# to touch only that one.
#
#   listen    `overnight listen`, always on: hears, notices and asks.
#   crew      the Kiro Crew gateway, always on: the "kiro-crew" builder hands its build jobs to it.
#   build     `overnight build --if-due`: wakes every minute; builds at BUILD_TIME by Overnight's
#             own clock.
#   deliver   `overnight deliver --if-due`: wakes every minute; delivers 30 minutes before
#             DELIVER_TIME by Overnight's own clock.
#
# Each job is a macOS "LaunchAgent": a small settings file in ~/Library/LaunchAgents that tells
# macOS when to run a program whenever you are logged in. Naming one job touches that job only:
# the others are neither stopped nor rewritten.
#
# For each job named, this script changes exactly two things, and nothing else on the Mac:
#   - the file  ~/Library/LaunchAgents/com.overnight.<job>.plist
#   - the job   com.overnight.<job>
# (`install` also makes two folders if they are missing: ~/Library/LaunchAgents, and Overnight's
# own logs folder, because macOS will not start a job whose log folder does not exist. It makes
# Overnight's data folder private to you, and on a first install, when there is no database yet,
# it puts Overnight in quiet mode before anything starts.)
#
# `install build` and `install deliver` do three more things, in this order:
#   - They refuse while that job is in the middle of its work: installing would cut it off.
#   - They start the job's clock from now (`overnight build --from-now`), before anything is
#     stopped: today's time counts as handled, so nothing that was due before now is run, and the
#     first run is at the job's next time. This is the one thing written in Overnight's database.
#   - Once the job has started, they wait up to 30 seconds for its first look at the clock, and
#     say so plainly if it does not come.
# `restart build` and `restart deliver` refuse in the same way and wait in the same way. They
# leave the clock as it is: a run that is due is still due after a restart.
#
# `install crew` does four more things:
#   - It makes the folders the gateway must find in place, if they are missing: the build jobs'
#     own temporary folder, <data folder>/tmp/build (private to you; the job's TMPDIR), and, when
#     the gateway runs inside Overnight's sandbox, ~/workplace/kirocrew-workspace, ~/.kiro/sessions
#     and ~/.npm. Inside the sandbox the gateway may write in those three, but it may not create
#     them: the folders they sit in are not writable there.
#   - It installs the build skill: crew/build-skill.md is copied to
#     ~/.kiro/crew/skills/overnight-build/SKILL.md. A different file already there is kept beside
#     it as SKILL.md.bak-<time>. It never writes through a symbolic link.
#   - It starts the gateway the way the BUILD_SANDBOX setting says (read from
#     `overnight status --json`, as the background jobs see it). "overnight", the standard: inside
#     Overnight's own macOS sandbox, packages/builder/sandbox/crew-gateway.sb, with every path
#     written out with its links followed. "crew": bare, under Kiro Crew's own sandbox.
#   - It waits up to 60 seconds for the gateway to answer, and says so plainly if it does not.
#
# It never changes a Kiro Crew setting. `install crew` reads them, and if one is not what the
# BUILD_SANDBOX setting needs, it stops and prints the one command to run.
#
# It works from any folder, and with spaces in any path.
set -euo pipefail
unset CDPATH
# Newer versions of bash give "&" a special meaning in ${text//find/replace}. We put XML such as
# "&amp;" there, so switch that off where the option exists. (macOS's own bash does not have it.)
shopt -u patsub_replacement 2>/dev/null || true

# In the order they are installed, restarted and shown.
ALL_JOBS=(listen crew build deliver)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null && pwd -P)"
REPO="$(cd -- "$SCRIPT_DIR/.." >/dev/null && pwd -P)"
ENTRY="$REPO/packages/cli/src/main.ts"
# The settings file the app reads at start-up, if there is one.
ENV_FILE="$REPO/.env"
DOMAIN="gui/$(id -u)"
# Node 22.18 is the first release that runs our .ts files directly.
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
# How long before DELIVER_TIME the morning's testing and publishing starts (SPEC §7).
DELIVER_LEAD_MINUTES=30
# The profile the gateway is started inside when BUILD_SANDBOX is "overnight".
SANDBOX_EXEC="/usr/bin/sandbox-exec"
SANDBOX_PROFILE="$REPO/packages/builder/sandbox/crew-gateway.sb"
# How to build one Overnight app. Kiro Crew finds skills in its own folder, so it is copied there.
SKILL_SOURCE="$REPO/crew/build-skill.md"
# Where the gateway listens. This is Kiro Crew's own default; the job does not set KIROCREW_PORT.
CREW_PORT=5476
# How long `install crew` waits for the gateway to answer once its job has started.
GATEWAY_WAIT_SECONDS=60
# How long install and restart wait for a night job's first look at the clock once it has started.
FIRST_CHECK_WAIT_SECONDS=30
START_FAILED="macOS would not start the job (launchctl bootstrap failed). You must be logged in at this Mac's screen, not only over a remote shell. \"scripts/install-agents.sh status\" shows where things stand."

die() {
  printf 'install-agents: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: scripts/install-agents.sh <install | uninstall | restart | status> [listen | crew | build | deliver | all]

  install     Put the job in place and start it. Safe to repeat.
  uninstall   Stop the job and remove it. Saved data is left alone.
  restart     Stop and start the job again, for example after a code change.
  status      Show whether it is running and the last lines of its logs.

Jobs (the default is all of them; naming one leaves the others alone):
  With no job named, install and restart act on every job: a listener that is
  running is stopped and started again too. Name the job to touch only that one.
  listen      Overnight's listener, always on.
  crew        The Kiro Crew gateway, always on. The "kiro-crew" builder needs it.
  build       The nightly build. Wakes every minute; builds at BUILD_TIME by
              Overnight's own clock.
  deliver     The morning delivery. Wakes every minute; delivers 30 minutes
              before DELIVER_TIME by Overnight's own clock.
EOF
}

# ---------- the jobs ----------

is_job() {
  local job
  for job in "${ALL_JOBS[@]}"; do
    [[ "$job" == "$1" ]] && return 0
  done
  return 1
}

label_of() { printf 'com.overnight.%s' "$1"; }
template_of() { printf '%s/launchd/com.overnight.%s.plist.template' "$REPO" "$1"; }
plist_of() { printf '%s/Library/LaunchAgents/com.overnight.%s.plist' "$HOME" "$1"; }
target_of() { printf '%s/com.overnight.%s' "$DOMAIN" "$1"; }

# What each job is called when talking to a person.
title_of() {
  case "$1" in
    listen) printf 'Overnight listener' ;;
    crew) printf 'Kiro Crew gateway' ;;
    build) printf 'Overnight nightly build' ;;
    deliver) printf 'Overnight morning delivery' ;;
  esac
}

# The two always-on jobs must have a process at all times. The two night jobs have one for a
# moment every minute, while they look at the clock, and for as long as their work takes.
always_on() {
  [[ "$1" == listen || "$1" == crew ]]
}

# What a night job's work is called when talking to a person.
work_of() {
  case "$1" in
    build) printf 'nightly build' ;;
    deliver) printf 'morning delivery' ;;
  esac
}

# How long macOS gives the job to stop before ending it by force (ExitTimeOut in its template).
exit_timeout_of() {
  case "$1" in
    build | deliver) printf '60' ;;
    *) printf '30' ;;
  esac
}

# ---------- finding things ----------

# The full path of node. Background jobs have no shell profile, so the job needs the full path.
find_node() {
  local candidate="$HOME/.local/node/bin/node"
  if [[ -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  candidate="$(command -v node 2>/dev/null || true)"
  # A shell function or alias called "node" comes back as a bare name: no use to a background job.
  if [[ "$candidate" == /* && -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

# The full path of kirocrew, found the same way.
find_kirocrew() {
  local candidate="$HOME/.local/bin/kirocrew"
  if [[ -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  candidate="$(command -v kirocrew 2>/dev/null || true)"
  if [[ "$candidate" == /* && -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

require_node_version() {
  local node="$1" version major minor rest
  version="$("$node" -p 'process.versions.node' 2>/dev/null)" || die "Could not run Node.js at $node."
  IFS=. read -r major minor rest <<<"$version"
  if ! [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
    die "Could not read the Node.js version at $node (it said \"$version\")."
  fi
  if (( major < MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor < MIN_NODE_MINOR) )); then
    die "Node.js $version at $node is too old. Overnight needs $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer (we use Node 24)."
  fi
}

# Where Overnight keeps its data: OVERNIGHT_DATA_DIR, or ~/.overnight. The answer has to match
# what the app itself works out (packages/core/src/config.ts), which also reads the repo's .env
# file. So when there is a .env, node reads it the same way the app does; a value already in
# the environment wins there too. The .env file is only read, and only this one value is used.
resolve_data_dir() {
  local node="${1:-}" raw="${OVERNIGHT_DATA_DIR:-}"
  if [[ -n "$node" && -f "$ENV_FILE" ]]; then
    raw="$("$node" --env-file="$ENV_FILE" -p 'process.env.OVERNIGHT_DATA_DIR ?? ""' 2>/dev/null || printf '%s' "$raw")"
  fi
  # Blank means "use the default", as in config.ts.
  if [[ -z "${raw//[[:space:]]/}" ]]; then
    raw="$HOME/.overnight"
  fi
  case "$raw" in
    "~") raw="$HOME" ;;
    "~/"*) raw="$HOME/${raw:2}" ;;
  esac
  # A relative path would mean a different folder depending on where a command is run from, so
  # the app refuses it (config.ts). Say the same here.
  if [[ "$raw" != /* ]]; then
    die "OVERNIGHT_DATA_DIR must be a full path or start with ~/"
  fi
  if [[ "$raw" != "/" ]]; then
    raw="${raw%/}"
  fi
  printf '%s' "$raw"
}

# The same question, answered the way a background job will answer it. A job is given only
# PATH and HOME (see the templates), so an OVERNIGHT_DATA_DIR that exists only in the shell running
# this script never reaches it: the job reads .env, or falls back to ~/.overnight.
job_data_dir() {
  (
    unset OVERNIGHT_DATA_DIR
    resolve_data_dir "${1:-}"
  )
}

# The folder a job's logs are in. Read from its installed settings file when there is one, so
# a later change to .env, or a shell without OVERNIGHT_DATA_DIR, cannot point us at the wrong
# place. With nothing installed, it is where this shell's settings say.
#   logs_dir <job>
logs_dir() {
  local plist launchd_log node dir
  plist="$(plist_of "$1")"
  if [[ -f "$plist" ]] && launchd_log="$(plutil -extract StandardOutPath raw -o - "$plist" 2>/dev/null)" && [[ "$launchd_log" == /* ]]; then
    dirname -- "$launchd_log"
    return 0
  fi
  node="$(find_node || true)"
  dir="$(resolve_data_dir "$node")" || return 1
  printf '%s\n' "$dir/logs"
}

# A path with every symbolic link in it followed, even when its last parts do not exist yet.
# The macOS sandbox compares real paths: a rule written with a linked path silently matches
# nothing, and sandbox-exec cannot start a program through one (seen with ~/.local/node, which is
# a link, in the Milestone 2 experiments). Fails rather than hand back a path with a link in it.
#   real_path <full path>
real_path() {
  [[ "$1" == /* ]] || return 1
  /usr/bin/perl -MCwd=realpath -e '
    my ($path, $rest) = ($ARGV[0], "");
    $path =~ s{/+$}{} unless $path eq "/";
    # Walk up to the nearest part that exists. (A link to nowhere counts as missing here.)
    while ($path ne "/" && !-e $path) {
      $path =~ s{/([^/]+)$}{} or exit 1;
      $rest = "/$1$rest";
      $path = "/" if $path eq "";
    }
    exit 1 if "$rest/" =~ m{/\.\.?/};
    my $real = realpath($path);
    exit 1 unless defined $real && length $real;
    my $out = ($real eq "/" ? "" : $real) . $rest;
    $out = "/" if $out eq "";
    # Nothing in the answer may still be a link.
    my $seen = "";
    for my $part (grep { length } split m{/}, $out) {
      $seen .= "/$part";
      exit 1 if -l $seen;
    }
    print $out;
  ' -- "$1"
}

# ---------- the command-line tool ----------

# Run the `overnight` tool the way a background job runs it: same node, and the same bare
# environment (only PATH and HOME, see the templates), so it reads its settings from .env alone.
#   job_cli <node> <arguments...>
job_cli() {
  local node="$1"
  shift
  env -i HOME="$HOME" PATH="$(dirname -- "$node"):/usr/bin:/bin:/usr/sbin:/sbin" "$node" "$ENTRY" "$@"
}

# One value out of what `overnight status --json` printed. A name with dots in it is a way down
# into the report: "nightClock.build.checkedAt". Fails if it is not there as text.
#   report_value <node> <report> <name>
report_value() {
  "$1" -e '
    let value;
    try {
      value = JSON.parse(process.argv[1]);
      for (const part of process.argv[2].split(".")) {
        value = typeof value === "object" && value !== null && Object.hasOwn(value, part) ? value[part] : undefined;
      }
    } catch {}
    if (typeof value !== "string" || value === "") process.exit(1);
    process.stdout.write(value);
  ' "$2" "$3" 2>/dev/null
}

# The time now, written the way the app writes one (UTC, to the millisecond:
# 2026-10-11T07:00:00.000Z), so that two of them compare as text.
#   utc_now <node>
utc_now() {
  "$1" -p 'new Date().toISOString()' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%S.000Z
}

# "paused" or "live", as the background jobs see it. "unknown" if the tool would not say.
job_mode() {
  local node="$1" report
  report="$(job_cli "$node" status --json 2>/dev/null)" || report=""
  "$node" -e '
    let paused;
    try { paused = JSON.parse(process.argv[1]).paused; } catch {}
    console.log(paused === true ? "paused" : paused === false ? "live" : "unknown");
  ' "$report" 2>/dev/null || echo unknown
}

# Say which mode Overnight is in and the one command that changes it.
#   print_mode <node>
print_mode() {
  case "$(job_mode "$1")" in
    paused)
      echo "Mode: paused (quiet mode). Overnight is listening and saving, not asking or building."
      echo "  Turn asking on with:      npx overnight resume"
      ;;
    live)
      echo "Mode: LIVE. Overnight asks about new ideas on the watch and builds approved ones."
      echo "  Go back to quiet mode with:  npx overnight pause"
      ;;
    *)
      echo "Mode: could not tell. Check with: npx overnight status"
      echo "  Quiet mode: npx overnight pause    Asking on: npx overnight resume"
      ;;
  esac
}

# ---------- the clock ----------

# The time zone this Mac's clock is set to, for example "America/Boise". No job goes by it: it is
# only named to the person installing, when it is not Overnight's own (print_clock_note).
mac_time_zone() {
  local link
  link="$(readlink /etc/localtime 2>/dev/null)" || return 1
  [[ "$link" == */zoneinfo/* ]] || return 1
  printf '%s' "${link##*/zoneinfo/}"
}

# Do two time zones show the same time of day, now and through the coming year? Two names for
# one clock (say America/Boise and America/Denver) are no disagreement.
#   same_clock <node> <zone> <zone>
same_clock() {
  "$1" -e '
    const [a, b] = process.argv.slice(1);
    const offset = (zone, at) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName").value;
    const day = 86_400_000;
    const same = [0, 91, 182, 273].every((days) => { const at = new Date(Date.now() + days * day); return offset(a, at) === offset(b, at); });
    process.exit(same ? 0 : 1);
  ' "$2" "$3" 2>/dev/null
}

# Say so when this Mac's clock and Overnight's TZ setting are two different clocks. Nothing
# depends on it: the night jobs go by Overnight's own clock, not by macOS's calendar. But a
# person who reads "01:00" should know which 01:00 is meant. Prints nothing when the two agree,
# or when the Mac's time zone cannot be read.
#   print_clock_note <node> <the TZ setting>
print_clock_note() {
  local node="$1" setting="$2" mac
  mac="$(mac_time_zone)" || return 0
  if [[ "$mac" == "$setting" ]] || same_clock "$node" "$mac" "$setting"; then
    return 0
  fi
  echo "  Note: this Mac's clock is set to $mac. Overnight goes by its own TZ setting, $setting: 01:00 means 01:00 there."
}

# A time of day, some minutes earlier, as "<hour> <minute>" without leading zeros. It wraps
# around midnight: 00:10 less 30 minutes is 23:40.
#   clock_minus <HH:MM> <minutes>
clock_minus() {
  local total
  [[ "$1" =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]] || return 1
  # 10# : "08" and "09" are not octal numbers.
  total=$(( (10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]} - $2 + 1440) % 1440 ))
  printf '%d %d' $(( total / 60 )) $(( total % 60 ))
}

# "6 30" as "06:30".
clock_text() {
  printf '%02d:%02d' "$1" "$2"
}

# ---------- Kiro Crew ----------

# One Kiro Crew setting, as `kirocrew config get` prints it, in lower case. Only ever reads.
# The time limit is perl's: macOS has no `timeout` command.
#   crew_setting <kirocrew> <key>
crew_setting() {
  local value
  value="$(env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" NO_COLOR=1 /usr/bin/perl -e 'alarm shift; exec @ARGV' 30 "$1" config get "$2" 2>/dev/null)" || return 1
  printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]"'
}

# Is something already listening where the gateway will listen?
gateway_port_busy() {
  /usr/sbin/lsof -nP -iTCP:"$CREW_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

# The build jobs' own temporary folder: the gateway job's TMPDIR (see its template), and
# `buildTmp` in packages/core/src/paths.ts.
#   build_tmp_of <data dir>
build_tmp_of() { printf '%s/tmp/build' "$1"; }

# The folders the gateway must find in place when it starts. Safe to repeat: a folder that is
# there is left as it is, apart from the temporary folder, which is made private again.
#   make_gateway_folders <mode> <data dir>
make_gateway_folders() {
  local mode="$1" data_dir="$2" tmp dir
  tmp="$(build_tmp_of "$data_dir")"
  # The job is handed this folder as TMPDIR in both modes, so it has to be there in both.
  (umask 077 && mkdir -p -- "$tmp") || die "Could not create $tmp, the build jobs' temporary folder. The Kiro Crew gateway job was left as it was."
  [[ -d "$tmp" && ! -L "$tmp" && ! -L "$data_dir/tmp" ]] || die "$tmp is not a plain folder (a symbolic link?), so it cannot be the build jobs' temporary folder. The Kiro Crew gateway job was left as it was."
  chmod 700 "$data_dir/tmp" "$tmp" || die "Could not make $tmp private. The Kiro Crew gateway job was left as it was."
  [[ "$mode" == overnight ]] || return 0
  # Inside Overnight's sandbox the gateway may write IN these, but the folders they sit in (the
  # home folder, ~/workplace, ~/.kiro, ~/.npm) are not writable there, so it could not create
  # them: Kiro Crew's own work folder, Kiro's agent files, saved sessions, settings and sign-in
  # staging folder, and npm's cache and logs.
  for dir in "$HOME/workplace/kirocrew-workspace" "$HOME/.kiro/agents" "$HOME/.kiro/sessions" "$HOME/.kiro/settings" "$HOME/.kiro/crew-auth-staging" "$HOME/.npm/_cacache" "$HOME/.npm/_logs"; do
    [[ -d "$dir" ]] || mkdir -p -- "$dir" || die "Could not create $dir, which the Kiro Crew gateway needs. The Kiro Crew gateway job was left as it was."
  done
}

# Where the gateway job's own copy of the sandbox profile is kept: <data>/sandbox/crew-gateway.sb.
installed_profile_of() { printf '%s/sandbox/crew-gateway.sb' "$1"; }

# Give the gateway job its own copy of the sandbox profile, and print where it is.
# macOS's privacy rules do not let a background job whose program is sandbox-exec read a file
# under ~/Documents, which is where this repo may live: the job then dies at once with
# "sandbox-exec: ...crew-gateway.sb: Operation not permitted" (seen on Oct 10). The data folder
# is not covered by those rules, and a sandboxed job can neither read nor write it. The copy is
# made again by every `install crew`, so it never stays behind the repo's file for long;
# `overnight preflight` says when the two differ.
#   place_gateway_profile <data dir>
place_gateway_profile() {
  local data_dir="$1" dir file tmp
  file="$(installed_profile_of "$data_dir")"
  dir="$(dirname -- "$file")"
  (umask 077 && mkdir -p -- "$dir") || die "Could not create $dir, where the gateway job's copy of the sandbox profile is kept. The Kiro Crew gateway job was left as it was."
  [[ -d "$dir" && ! -L "$dir" ]] || die "$dir is not a plain folder (a symbolic link?), so the sandbox profile cannot be kept there. The Kiro Crew gateway job was left as it was."
  [[ ! -L "$file" ]] || die "$file is a symbolic link, so the sandbox profile cannot be kept there. Remove it, then run install again. The Kiro Crew gateway job was left as it was."
  chmod 700 "$dir" || die "Could not make $dir private. The Kiro Crew gateway job was left as it was."
  tmp="$(mktemp "$dir/.crew-gateway.sb.XXXXXX")" || die "Could not write in $dir. The Kiro Crew gateway job was left as it was."
  if ! { cat -- "$SANDBOX_PROFILE" >"$tmp" && chmod 600 "$tmp" && mv -f -- "$tmp" "$file"; }; then
    rm -f -- "$tmp"
    die "Could not copy the sandbox profile to $file. The Kiro Crew gateway job was left as it was."
  fi
  printf '%s\n' "$file"
}

# The names a sandbox profile wants values for: every (param "NAME") in it, once each, in the
# order they first appear. Comments (from ";" to the end of a line) are not looked at.
#   profile_params <profile file>
profile_params() {
  sed -e 's/;.*$//' -- "$1" | { grep -o '(param "[^"]*")' || true; } | sed -e 's/^(param "//' -e 's/")$//' | awk '!seen[$0]++'
}

# The value for one of the profile's names, as a real path. Exit code 2 for a name this script
# does not know how to fill, 1 when a real path could not be worked out.
#   profile_value <name> <home> <data dir> <node>
profile_value() {
  local name="$1" home="$2" data_dir="$3" node="${4:-}" real_node
  case "$name" in
    HOME) real_path "$home" ;;
    DATA_DIR) real_path "$data_dir" ;;
    REPO) real_path "$REPO" ;;
    # The Node.js install: the folder that holds bin/node (as in packages/deliver/sandbox/deliver.sb).
    NODE_DIR)
      real_node="$(real_path "$node")" || return 1
      dirname -- "$(dirname -- "$real_node")"
      ;;
    NPM_CACHE) real_path "$home/.npm" ;;
    # Kiro's folder, and Kiro Crew's own folder inside it.
    KIRO_HOME) real_path "$home/.kiro" ;;
    CREW_HOME) real_path "$home/.kiro/crew" ;;
    # The temporary folder the gateway job is handed as TMPDIR (see its template): the build
    # jobs' own, inside the data folder. Not the one this account shares with every other program.
    TMPDIR) real_path "$(build_tmp_of "$data_dir")" ;;
    *) return 2 ;;
  esac
}

# The command the gateway job runs, one word per line, for the given sandbox mode.
# In "overnight" mode the profile itself says which values it wants (profile_params); every path
# on the line, the profile's and the program's included, is a real one.
#   crew_command <mode> <kirocrew> <home> <data dir> <node>
crew_command() {
  local mode="$1" kirocrew="$2" home="$3" data_dir="$4" node="${5:-}" name value code profile program
  local -a pairs=() unknown=()
  if [[ "$mode" != overnight ]]; then
    printf '%s\n' "$kirocrew" gateway --no-open --no-tunnel
    return 0
  fi
  # The file the job is pointed at: its own copy when install has made one (GATEWAY_PROFILE),
  # otherwise the repo's. The names are always read from the repo's file; the copy is the same text.
  profile="$(real_path "${GATEWAY_PROFILE:-$SANDBOX_PROFILE}")" || die "Could not work out the real path of the sandbox profile (${GATEWAY_PROFILE:-$SANDBOX_PROFILE}). Nothing was changed."
  program="$(real_path "$kirocrew")" || die "Could not work out the real path of Kiro Crew's program ($kirocrew). Nothing was changed."
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    code=0
    value="$(profile_value "$name" "$home" "$data_dir" "$node")" || code=$?
    if (( code == 2 )); then
      unknown+=("$name")
    elif (( code != 0 )) || [[ "$value" != /* ]]; then
      die "Could not work out a real path (one with no symbolic link in it) for $name, which the sandbox profile needs. Nothing was changed."
    else
      pairs+=(-D "$name=$value")
    fi
  done < <(profile_params "$SANDBOX_PROFILE")
  if (( ${#unknown[@]} > 0 )); then
    die "The sandbox profile asks for values this script does not know how to fill: ${unknown[*]} (see $SANDBOX_PROFILE). Add them to profile_value in scripts/install-agents.sh, then run install again. Nothing was changed."
  fi
  if (( ${#pairs[@]} == 0 )); then
    die "The sandbox profile names nothing to protect (there is no (param \"...\") in $SANDBOX_PROFILE), so it cannot be the right file. Nothing was changed."
  fi
  printf '%s\n' "$SANDBOX_EXEC" -f "$profile" "${pairs[@]}" "$program" gateway --no-open --no-tunnel
}

# Does macOS take the gateway's sandbox command as written? Starts nothing of ours: the same
# sandbox-exec words, with /usr/bin/true in place of the gateway. A profile that does not load,
# or a value it wants and was not given, would otherwise only show later, as a job that dies
# every 30 seconds.
#   sandbox_command_loads <the gateway's command, one word per argument>
sandbox_command_loads() {
  # The last four words are the program and its three arguments. The rest is the sandbox's:
  # sandbox-exec, -f, the profile, and at least one -D pair.
  (( $# >= 9 )) || return 1
  local -a fence=("${@:1:$#-4}")
  env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" /usr/bin/perl -e 'alarm shift; exec @ARGV' 20 "${fence[@]}" /usr/bin/true >/dev/null 2>&1
}

# Does `kirocrew status` say the gateway is running? It exits 0 whatever it finds, so its words
# decide (checked against kirocrew 0.8.0): "Kiro Crew gateway is not running." when nothing
# answers; otherwise a line with "gateway is running", or its figures under "Kiro Crew v...".
#   gateway_says_running <kirocrew>
gateway_says_running() {
  local said
  said="$(env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" NO_COLOR=1 /usr/bin/perl -e 'alarm shift; exec @ARGV' 15 "$1" status 2>/dev/null)" || return 1
  [[ "$said" != *"is not running"* ]] || return 1
  [[ "$said" == *"gateway is running"* || "$said" == "Kiro Crew v"* ]]
}

# After the gateway job has started: wait for the gateway itself to answer, a look every two
# seconds, for at most GATEWAY_WAIT_SECONDS.
#   wait_for_gateway <kirocrew>
wait_for_gateway() {
  local kirocrew="$1" looks=0 deadline=$(( SECONDS + GATEWAY_WAIT_SECONDS ))
  while true; do
    if gateway_says_running "$kirocrew"; then
      return 0
    fi
    looks=$(( looks + 1 ))
    if (( SECONDS >= deadline || looks >= GATEWAY_WAIT_SECONDS / 2 )); then
      return 1
    fi
    sleep 2
  done
}

# ---------- the build skill ----------

# Where Kiro Crew looks for the skill: <home>/.kiro/crew/skills/overnight-build/SKILL.md.
skill_dir() { printf '%s/.kiro/crew/skills/overnight-build' "$HOME"; }

# Stop if anything on the way to the installed skill is a symbolic link, or is not what it
# should be. Kiro Crew's folder is one a build job may write in. A link planted there could
# make this script, run by you outside every sandbox, overwrite the file the link points at,
# or copy that file to where a job can read it. Changes nothing.
#   require_safe_skill_place <what to say last: what was, or was not, changed>
require_safe_skill_place() {
  local last="$1" dir="$HOME" part file
  local why="this script does not write through one (a build job may write in Kiro Crew's folder, so a link there could point this script at some other file). Look at where it points, remove it, then run install again."
  for part in .kiro crew skills overnight-build; do
    dir="$dir/$part"
    if [[ -L "$dir" ]]; then
      die "The build skill cannot be installed: $dir is a symbolic link, and $why $last"
    fi
    if [[ -e "$dir" && ! -d "$dir" ]]; then
      die "The build skill cannot be installed: $dir is not a folder. $last"
    fi
  done
  file="$dir/SKILL.md"
  if [[ -L "$file" ]]; then
    die "The build skill cannot be installed: $file is a symbolic link, and $why $last"
  fi
  if [[ -e "$file" && ! -f "$file" ]]; then
    die "The build skill cannot be installed: $file is not a plain file. Remove it, then run install again. $last"
  fi
}

# What install_skill did, for the line install prints.
SKILL_NOTE=""

# Copy crew/build-skill.md to where Kiro Crew looks for it. An exact copy already there is left
# alone. A different file is kept beside the new one as SKILL.md.bak-<time>: it is moved, not
# copied, so nothing is ever read from it. The new file is written under another name in the same
# folder and then moved into place, so no link is ever written through.
install_skill() {
  local dir file part fresh backup
  # Looked at once already, before anything was changed. Again now, right before writing.
  require_safe_skill_place "The Kiro Crew gateway job was left as it was."
  dir="$HOME"
  for part in .kiro crew skills overnight-build; do
    dir="$dir/$part"
    # One folder at a time, never "mkdir -p": that would follow a link planted on the way.
    if [[ ! -d "$dir" ]]; then
      mkdir -- "$dir" || die "Could not create $dir."
    fi
  done
  [[ "$(cd -- "$dir" && pwd -P)" == "$(real_path "$HOME")/.kiro/crew/skills/overnight-build" ]] \
    || die "The build skill was not installed: $dir is not where it should be (a symbolic link on the way?)."
  file="$dir/SKILL.md"
  if [[ -f "$file" && ! -L "$file" ]] && /usr/bin/perl -e 'alarm shift; exec @ARGV' 10 /usr/bin/cmp -s -- "$SKILL_SOURCE" "$file"; then
    SKILL_NOTE="the build skill there is already this repo's"
    return 0
  fi
  fresh="$(mktemp "$dir/.SKILL.md.new.XXXXXX")" || die "Could not write in $dir."
  if ! cat -- "$SKILL_SOURCE" >"$fresh" || ! chmod 644 "$fresh"; then
    rm -f -- "$fresh"
    die "Could not copy the build skill into $dir."
  fi
  SKILL_NOTE="the build skill was installed"
  if [[ -e "$file" || -L "$file" ]]; then
    backup="$dir/SKILL.md.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    while [[ -e "$backup" || -L "$backup" ]]; do
      backup="$backup.again"
    done
    # -h: if the name has become a link to a folder meanwhile, move the link, not into the folder.
    if ! mv -f -h -- "$file" "$backup"; then
      rm -f -- "$fresh"
      die "Could not keep the old build skill as $backup. Nothing was installed."
    fi
    SKILL_NOTE="the build skill was replaced, and the one that was there is kept as $backup"
  fi
  if ! mv -f -h -- "$fresh" "$file"; then
    rm -f -- "$fresh"
    die "Could not put the build skill in place at $file."
  fi
}

# Stop unless Kiro Crew is set the way this sandbox mode needs. Nothing is changed here, ever:
# switching a sandbox setting is the owner's decision, so the one command is printed instead.
#   require_crew_settings <mode> <kirocrew>
require_crew_settings() {
  local mode="$1" kirocrew="$2" value
  if [[ "$mode" == overnight ]]; then
    value="$(crew_setting "$kirocrew" agent.sandbox_allow_unsandboxed_exec)" \
      || die "Could not read Kiro Crew's settings (\"$kirocrew config get agent.sandbox_allow_unsandboxed_exec\" failed). Nothing was changed."
    if [[ "$value" != true ]]; then
      die "BUILD_SANDBOX is \"overnight\", and Kiro Crew is not set for it yet: Kiro Crew refuses to run any job inside a sandbox it did not create unless its setting agent.sandbox_allow_unsandboxed_exec is true (it is \"$value\" now), which switches Kiro Crew's OWN sandbox off so that Overnight's can take its place. This script never changes a Kiro Crew setting. Run this one command, then run install again:
    \"$kirocrew\" config set agent.sandbox_allow_unsandboxed_exec true
Nothing was changed."
    fi
    return 0
  fi
  value="$(crew_setting "$kirocrew" agent.sandbox)" \
    || die "Could not read Kiro Crew's settings (\"$kirocrew config get agent.sandbox\" failed). Nothing was changed."
  if [[ "$value" != strict ]]; then
    die "BUILD_SANDBOX is \"crew\": Kiro Crew's own sandbox does the fencing, and Overnight needs it at its strict level (agent.sandbox is \"$value\" now). This script will not change a Kiro Crew setting for you. Run this one command, then run install again:
    \"$kirocrew\" config set agent.sandbox strict
Nothing was changed."
  fi
  # Left over from a time in "overnight" mode, this setting lets Kiro Crew run jobs with no
  # sandbox at all whenever its own cannot start. The builder refuses to build like that
  # (packages/builder: crewSettingsProblem), so refuse here too rather than install a gateway
  # whose every build would be turned away.
  value="$(crew_setting "$kirocrew" agent.sandbox_allow_unsandboxed_exec)" \
    || die "Could not read Kiro Crew's settings (\"$kirocrew config get agent.sandbox_allow_unsandboxed_exec\" failed). Nothing was changed."
  if [[ "$value" == true ]]; then
    die "BUILD_SANDBOX is \"crew\": Kiro Crew's own sandbox does the fencing, but its setting agent.sandbox_allow_unsandboxed_exec is true, which lets it run jobs with no sandbox at all. Only BUILD_SANDBOX=overnight needs that. This script will not change a Kiro Crew setting for you. Run this one command, then run install again:
    \"$kirocrew\" config set agent.sandbox_allow_unsandboxed_exec false
Nothing was changed."
  fi
}

# ---------- the settings files ----------

# The plist is XML, so a path with "&" or "<" in it has to be written the XML way.
xml_escape() {
  local text="$1"
  text="${text//&/&amp;}"
  text="${text//</&lt;}"
  text="${text//>/&gt;}"
  printf '%s' "$text"
}

# Print a job's template with its placeholders filled in. The build and deliver jobs take no
# time of day: macOS wakes them every minute, and Overnight's own clock decides.
#   render_plist listen | build | deliver <node> <repo> <data dir> <home>
#   render_plist crew                     <node> <repo> <data dir> <home> <the gateway's command, one word per argument>
render_plist() {
  local job="$1" template node repo data_dir home node_dir content word words=""
  template="$(template_of "$job")"
  node="$(xml_escape "$2")"
  node_dir="$(xml_escape "$(dirname -- "$2")")"
  repo="$(xml_escape "$3")"
  data_dir="$(xml_escape "$4")"
  home="$(xml_escape "$5")"
  shift 5
  [[ -f "$template" ]] || die "The template is missing: $template"
  content="$(cat -- "$template")"
  content="${content//__NODE_DIR__/$node_dir}"
  content="${content//__NODE__/$node}"
  content="${content//__REPO__/$repo}"
  content="${content//__DATA_DIR__/$data_dir}"
  content="${content//__HOME__/$home}"
  case "$job" in
    crew)
      (( $# > 0 )) || die "The crew job needs the gateway's command."
      for word in "$@"; do
        words+="    <string>$(xml_escape "$word")</string>"$'\n'
      done
      # Last, so that nothing above can rewrite a path inside the command.
      content="${content//__CREW_ARGUMENTS__/${words%$'\n'}}"
      ;;
  esac
  printf '%s\n' "$content"
}

# ---------- macOS's side of a job ----------

#   job_loaded <job>
job_loaded() {
  launchctl print "$(target_of "$1")" >/dev/null 2>&1
}

# Is the job's process there right now? A job that failed at once has no pid: macOS waits 30
# seconds before it tries again.
#   job_running <job>
job_running() {
  local info
  info="$(launchctl print "$(target_of "$1")" 2>/dev/null)" || return 1
  grep -q $'^\tpid = ' <<<"$info"
}

# Does the job's installed settings file have macOS wake it on a timer (StartInterval)? That is
# how the build and deliver jobs are installed now. No for one still on macOS's calendar, the old
# way, and when there is no file.
#   on_timer <job>
on_timer() {
  local plist
  plist="$(plist_of "$1")"
  [[ -f "$plist" ]] && plutil -extract StartInterval raw -o - "$plist" >/dev/null 2>&1
}

# Is a night job (build or deliver) in the middle of its work? Such a job has a process for a
# moment every minute, while it looks at the clock, so one sighting says nothing. Two sightings,
# two seconds apart, do.
#   night_job_busy <job>
night_job_busy() {
  job_running "$1" || return 1
  sleep 2
  job_running "$1"
}

# The jobs this command has already dealt with, in order. A refusal made when a later job's turn
# comes must not say that nothing was changed.
DONE_JOBS=()

# The last sentence of a refusal made when a job's turn comes.
#   untouched_words <job>
untouched_words() {
  if (( ${#DONE_JOBS[@]} == 0 )); then
    printf 'Nothing was changed.'
  else
    printf 'The %s job was left as it was (already done: %s).' "$1" "${DONE_JOBS[*]}"
  fi
}

# Stop if a night job is in the middle of its work: stopping the job would cut that off.
#   require_not_busy <job> <installing | restarting>
require_not_busy() {
  if night_job_busy "$1"; then
    die "The $(work_of "$1") is running right now, and $2 would cut it off. Run this again when it has finished. $(untouched_words "$1")"
  fi
}

# After a start: give the job a moment, then look. A second look, so that a slow start is not
# called a failure.
#   job_stayed_up <job>
job_stayed_up() {
  sleep 2
  if job_running "$1"; then
    return 0
  fi
  sleep 3
  job_running "$1"
}

# Stop the job and take it out of macOS's list. Fine if it was not there.
# macOS asks the program to stop (so it can finish what it is doing) and ends it by force
# after the job's ExitTimeOut if it has not.
#   stop_job <job>
stop_job() {
  local job="$1" tries=0 limit
  launchctl bootout "$(target_of "$job")" >/dev/null 2>&1 || true
  # bootout can return before the old job is really gone, and starting a new copy while it is
  # still there fails with an unhelpful "Input/output error". Wait for it: the job's own time to
  # stop, and five seconds on top (four looks a second).
  limit=$(( ($(exit_timeout_of "$job") + 5) * 4 ))
  while job_loaded "$job"; do
    tries=$((tries + 1))
    if (( tries > limit )); then
      return 1
    fi
    sleep 0.25
  done
  return 0
}

# Hand the installed settings file to macOS. Every job starts straight away: an always-on job
# to stay, a night job for its first look at the clock.
#   start_job <job>
start_job() {
  local job="$1" plist
  plist="$(plist_of "$job")"
  # "enable" only undoes an earlier "launchctl disable" of this same job, which would otherwise
  # make the next step fail.
  launchctl enable "$(target_of "$job")" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null; then
    # Now and then macOS needs a moment after an old copy has gone. Try once more, out loud.
    sleep 2
    launchctl bootstrap "$DOMAIN" "$plist" || return 1
  fi
  return 0
}

# After a night job has started: wait for it to look at the clock once. macOS starts the job when
# it is loaded, and the job writes every look down: `overnight status --json` gives the time of
# the latest one as nightClock.<job>.checkedAt. A look of ours every two seconds, for at most
# FIRST_CHECK_WAIT_SECONDS, until that time is later than <since>. Both are UTC times written the
# same way, so they are compared as text.
#   wait_for_first_check <node> <job> <since: the time just before the job was started (utc_now)>
wait_for_first_check() {
  local node="$1" job="$2" since="$3" looks=0 deadline=$(( SECONDS + FIRST_CHECK_WAIT_SECONDS )) report checked
  # Text order must be plain character order, whatever language this shell is set to.
  local LC_ALL=C
  while true; do
    report="$(job_cli "$node" status --json 2>/dev/null)" || report=""
    if checked="$(report_value "$node" "$report" "nightClock.$job.checkedAt")" \
      && [[ "$checked" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ && "$checked" > "$since" ]]; then
      return 0
    fi
    looks=$(( looks + 1 ))
    if (( SECONDS >= deadline || looks >= FIRST_CHECK_WAIT_SECONDS / 2 )); then
      return 1
    fi
    sleep 2
  done
}

# After a start, is the job as it should be? An always-on job must have a process that stays. A
# night job must be on macOS's list and, if it is one that wakes every minute, must have looked
# at the clock since it was started. (One still on macOS's calendar only has to be listed.)
# Exit code 1: no process, or not listed. 2: listed, but no look at the clock in time.
#   job_in_place <job> [<node> <since: the time just before the job was started (utc_now)>]
job_in_place() {
  local job="$1"
  if always_on "$job"; then
    if job_stayed_up "$job"; then return 0; else return 1; fi
  fi
  job_loaded "$job" || return 1
  if on_timer "$job"; then
    wait_for_first_check "${2:-}" "$job" "${3:-}" || return 2
  fi
  return 0
}

# After the gateway job has started: stop, saying where to look, unless the gateway itself
# answers in time. A gateway process that is there is not yet a gateway that answers: it can sit
# behind a profile that keeps it from its own files, or still be starting. The builds need it to
# answer.
#   require_gateway_answer <kirocrew>
require_gateway_answer() {
  if wait_for_gateway "$1"; then
    return 0
  fi
  status_of crew
  die "The Kiro Crew gateway job is in place and has a process, but the gateway did not answer within $GATEWAY_WAIT_SECONDS seconds (\"$1\" status does not say it is running). What it printed while starting is in $(logs_dir crew)/crew.launchd.log, and its own log is shown by: \"$1\" logs. macOS keeps the job going, so look again in a minute with \"scripts/install-agents.sh status crew\"; \"scripts/install-agents.sh uninstall crew\" takes the job out again."
}

# What to say when it is not.
#   not_in_place <job> <job_in_place's exit code>
not_in_place() {
  if always_on "$1"; then
    printf '%s' "The job is in place but is not running. The last exit code and the log lines above say why. macOS tries it again every 30 seconds, so it starts by itself once the cause is fixed; \"scripts/install-agents.sh uninstall $1\" takes it out again."
  elif [[ "${2:-1}" == 2 ]]; then
    printf '%s' "The job is in place, but it has not checked the time yet, so it may not be running. See: scripts/install-agents.sh status $1"
  else
    printf '%s' "The settings file is in place, but macOS does not list the job, so it will not run at its time. Try \"scripts/install-agents.sh install $1\" again."
  fi
}

# ---------- status ----------

#   show_log <file> <words when it has lines> <words when it has none>
show_log() {
  if [[ -s "$1" ]]; then
    echo "  $2 ($1):"
    tail -n 5 -- "$1" | sed 's/^/    /'
  else
    echo "  $3 ($1)"
  fi
}

#   status_of <job>
status_of() {
  local job="$1" plist info logs hour minute first every between
  plist="$(plist_of "$job")"
  # What having no process means for this job, as it is installed now.
  if always_on "$job"; then
    between="none (not running right now)"
  elif on_timer "$job"; then
    between="none (it wakes for a moment every minute)"
  else
    between="none (it runs at its time, not in between)"
  fi

  echo "$(title_of "$job") ($(label_of "$job"))"
  if info="$(launchctl print "$(target_of "$job")" 2>/dev/null)"; then
    # Top-level lines start with exactly one tab; deeper ones repeat names like "state".
    printf '%s\n' "$info" | awk -F' = ' -v between="$between" '
      /^\tstate = /          && !("state" in seen) { seen["state"] = $2 }
      /^\tpid = /            && !("pid" in seen)   { seen["pid"] = $2 }
      /^\tlast exit code = / && !("exit" in seen)  { seen["exit"] = $2 }
      END {
        print "  state:           " (("state" in seen) ? seen["state"] : "unknown")
        print "  pid:             " (("pid" in seen) ? seen["pid"] : between)
        print "  last exit code:  " (("exit" in seen) ? seen["exit"] : "unknown")
      }'
  elif [[ -f "$plist" ]]; then
    echo "  state:           not loaded (the settings file is there, but macOS is not running the job)"
    # Always with the job's name: a bare "install" means every job, and would restart the others.
    echo "                   Run: scripts/install-agents.sh install $job"
  else
    echo "  state:           not installed"
  fi

  # What the installed settings file says about when and how the job runs.
  if [[ -f "$plist" ]]; then
    case "$job" in
      build | deliver)
        if every="$(plutil -extract StartInterval raw -o - "$plist" 2>/dev/null)"; then
          echo "  wakes every:     $every seconds, and at login. Overnight's own clock decides when it is time"
        elif hour="$(plutil -extract StartCalendarInterval.Hour raw -o - "$plist" 2>/dev/null)" && minute="$(plutil -extract StartCalendarInterval.Minute raw -o - "$plist" 2>/dev/null)"; then
          echo "  runs at:         $(clock_text "$hour" "$minute") every day, on macOS's calendar (the old way, which ran an hour late on Oct 11). Move it with: scripts/install-agents.sh install $job"
        fi
        ;;
      crew)
        if first="$(plutil -extract ProgramArguments.0 raw -o - "$plist" 2>/dev/null)"; then
          if [[ "$first" == "$SANDBOX_EXEC" ]]; then
            echo "  sandbox:         overnight (the gateway runs inside Overnight's own sandbox)"
          else
            echo "  sandbox:         crew (Kiro Crew's own sandbox)"
          fi
        fi
        ;;
    esac
  fi

  logs="$(logs_dir "$job")"
  if [[ "$job" == crew ]]; then
    # The gateway keeps its own log in Kiro Crew's folder. Ours holds what it prints.
    show_log "$logs/crew.launchd.log" "last 5 lines it printed" "nothing printed yet"
    echo "  its own log:     kirocrew logs"
    return 0
  fi
  # Each of our own programs keeps its own log. As a background job it prints little else, so the
  # second file holds what went wrong outside that log: a crash, or a bad setting.
  show_log "$logs/$job.log" "last 5 lines of its log" "nothing in its log yet"
  show_log "$logs/$job.launchd.log" "last 5 lines printed outside that log, for example by a crash" "nothing printed outside that log"
}

#   cmd_status [job...]   (no job: all of them)
cmd_status() {
  local job first=yes
  (( $# > 0 )) || set -- "${ALL_JOBS[@]}"
  for job in "$@"; do
    [[ "$first" == yes ]] || echo
    first=no
    status_of "$job"
  done
}

# ---------- install ----------

# The filled-in settings file of each job named, worked out before anything is changed.
RENDERED_listen=""
RENDERED_crew=""
RENDERED_build=""
RENDERED_deliver=""
# What install says about each job once it is in place.
BUILD_AT=""
DELIVER_AT=""
BUZZ_AT=""
# The time zone those three are in: Overnight's TZ setting.
CLOCK_ZONE=""
CREW_MODE=""
# Kiro Crew's program, as found. Asked whether the gateway answers once its job has started.
CREW_PROGRAM=""

# Work out one job's settings file and check everything it depends on. Changes nothing.
#   prepare_job <job> <node> <data dir> <what `overnight status --json` printed>
prepare_job() {
  local job="$1" node="$2" data_dir="$3" report="$4" content zone time at sandbox kirocrew hour minute word words
  local -a command=()
  case "$job" in
    listen)
      content="$(render_plist listen "$node" "$REPO" "$data_dir" "$HOME")"
      ;;
    build | deliver)
      # The times are only read to tell the person installing: the job itself is not given them.
      # It asks Overnight's own clock every minute.
      zone="$(report_value "$node" "$report" timeZone)" || die "\"overnight status --json\" did not say which time zone Overnight uses, so the $job job cannot be set up. Nothing was changed."
      CLOCK_ZONE="$zone"
      if [[ "$job" == build ]]; then
        time="$(report_value "$node" "$report" buildTime)" || die "\"overnight status --json\" did not say when BUILD_TIME is. Nothing was changed."
        at="$(clock_minus "$time" 0)" || die "BUILD_TIME is not a time like 01:00 (it is \"$time\"). Nothing was changed."
        read -r hour minute <<<"$at"
        BUILD_AT="$(clock_text "$hour" "$minute")"
      else
        time="$(report_value "$node" "$report" deliverTime)" || die "\"overnight status --json\" did not say when DELIVER_TIME is. Nothing was changed."
        at="$(clock_minus "$time" "$DELIVER_LEAD_MINUTES")" || die "DELIVER_TIME is not a time like 07:00 (it is \"$time\"). Nothing was changed."
        read -r hour minute <<<"$at"
        DELIVER_AT="$(clock_text "$hour" "$minute")"
        BUZZ_AT="$time"
      fi
      # Refused here, before anything is changed for any job named, and looked at once more when
      # this job's turn comes.
      require_not_busy "$job" installing
      content="$(render_plist "$job" "$node" "$REPO" "$data_dir" "$HOME")"
      ;;
    crew)
      # The one place the mode comes from: Overnight's own settings, as the background jobs read
      # them (`overnight status --json` was run the way a job runs: from .env, and "overnight"
      # when .env does not say). This script never looks at a BUILD_SANDBOX variable itself, so
      # one set only in the shell running it changes nothing; the line install prints says which
      # mode the gateway was started in.
      sandbox="$(report_value "$node" "$report" buildSandbox)" || die "\"overnight status --json\" did not say which build sandbox is in use (buildSandbox), so the Kiro Crew gateway cannot be set up. Nothing was changed."
      if [[ "$sandbox" != overnight && "$sandbox" != crew ]]; then
        die "\"overnight status --json\" named a build sandbox this script does not know (\"$sandbox\"). Nothing was changed."
      fi
      kirocrew="$(find_kirocrew)" || die "Could not find Kiro Crew. Expected it at $HOME/.local/bin/kirocrew, or as \"kirocrew\" on the PATH. Nothing was changed."
      [[ -f "$SKILL_SOURCE" ]] || die "The build skill is missing: $SKILL_SOURCE. Nothing was changed."
      require_safe_skill_place "Nothing was changed."
      if [[ "$sandbox" == overnight ]]; then
        [[ -x "$SANDBOX_EXEC" ]] || die "macOS's sandbox-exec is missing: $SANDBOX_EXEC. Nothing was changed."
        [[ -f "$SANDBOX_PROFILE" ]] || die "The sandbox profile is missing: $SANDBOX_PROFILE. Nothing was changed."
      fi
      require_crew_settings "$sandbox" "$kirocrew"
      # Our own copy of the job holds the port while it runs. Anything else on it is a second
      # gateway (started by hand, or by `kirocrew service install`), and only one can run.
      if gateway_port_busy && ! job_loaded crew; then
        die "Something is already listening on port $CREW_PORT, where the Kiro Crew gateway listens: a gateway started by hand, or by \"kirocrew service install\". Only one can run. Stop it first (\"$kirocrew\" stop; if it is Kiro Crew's own service, \"$kirocrew\" service uninstall), then run install again. Nothing was changed."
      fi
      # The job's own copy of the profile, outside ~/Documents (see place_gateway_profile). It is
      # ours, in our own data folder, and harmless if the install stops further down.
      GATEWAY_PROFILE=""
      if [[ "$sandbox" == overnight ]]; then
        GATEWAY_PROFILE="$(place_gateway_profile "$data_dir")" || exit 1
      fi
      # A refusal inside crew_command ends this script too: its message is already printed.
      words="$(crew_command "$sandbox" "$kirocrew" "$HOME" "$data_dir" "$node")" || exit 1
      while IFS= read -r word; do
        command+=("$word")
      done <<<"$words"
      if [[ "$sandbox" == overnight ]] && ! sandbox_command_loads "${command[@]}"; then
        die "macOS would not start a program inside the sandbox profile as this script would run it ($SANDBOX_EXEC -f ${GATEWAY_PROFILE:-$SANDBOX_PROFILE} ...): the profile does not load, or wants a value it was not given. The gateway job would fail every 30 seconds, so it was not installed. Nothing was changed."
      fi
      content="$(render_plist crew "$node" "$REPO" "$data_dir" "$HOME" "${command[@]}")"
      CREW_MODE="$sandbox"
      CREW_PROGRAM="$kirocrew"
      ;;
  esac
  if grep -q '__[A-Z][A-Z_]*__' <<<"$content"; then
    die "The template has a placeholder this script does not fill in: $(template_of "$job")"
  fi
  plutil -lint - <<<"$content" >/dev/null || die "The filled-in settings file for the $job job is not valid. Nothing was changed."
  printf -v "RENDERED_$job" '%s' "$content"
}

# Put one prepared job in place and start it.
#   apply_job <job> <data dir> <node>
apply_job() {
  local job="$1" data_dir="$2" node="$3" plist rendered="RENDERED_$1" since code=0
  plist="$(plist_of "$job")"
  case "$job" in
    crew)
      # Before the gateway is loaded: the folders it must find in place, its TMPDIR among them.
      make_gateway_folders "$CREW_MODE" "$data_dir"
      # Kiro Crew looks for skills in its own folder. Ours is copied there, never linked, so that
      # nothing the gateway does can reach back into the repo.
      install_skill
      ;;
    build | deliver)
      # The stop below would cut off a run that is going.
      require_not_busy "$job" installing
      # Start the job's clock from now, BEFORE anything is stopped: today's time counts as
      # handled, so the first run is at the job's next time, and whatever started this job until
      # now (macOS's calendar, or an earlier install) cannot be followed by a second run today.
      # The tool refuses while a run holds the job's lock, also one started by hand; if it
      # refuses or fails, the job that is installed now goes on exactly as it was.
      job_cli "$node" "$job" --from-now >/dev/null \
        || die "Could not start the $job job's clock (\"overnight $job --from-now\" failed; its message is above). $(untouched_words "$job")"
      ;;
  esac
  stop_job "$job" || die "The old copy of the $job job would not stop. Its settings file was not changed. Try again in a minute."
  (umask 177 && printf '%s\n' "${!rendered}" >"$plist") || die "Could not write $plist."
  chmod 600 "$plist"
  plutil -lint "$plist" >/dev/null || die "$plist did not come out valid."

  # Taken before the start: a night job's first look at the clock has to come after this.
  since="$(utc_now "$node")"
  start_job "$job" || die "$START_FAILED"

  # macOS accepting the job says nothing about whether it stays up: a bad value in .env, a second
  # listener already running, or a missing module ends it within a second. Look before saying it worked.
  job_in_place "$job" "$node" "$since" || code=$?
  if (( code != 0 )); then
    status_of "$job"
    die "$(not_in_place "$job" "$code")"
  fi
  if [[ "$job" == crew ]]; then
    require_gateway_answer "$CREW_PROGRAM"
  fi
}

#   installed_line <job> <data dir>
installed_line() {
  case "$1" in
    listen) echo "Installed. Overnight now listens in the background and starts again at login." ;;
    crew)
      echo "Installed. The Kiro Crew gateway now runs in the background and starts again at login (build sandbox: $CREW_MODE, from Overnight's settings). It answers."
      echo "  build skill:  $(skill_dir)/SKILL.md ($SKILL_NOTE)"
      echo "  build temp:   $(build_tmp_of "$2") (the build jobs' own temporary folder)"
      ;;
    build) echo "Installed. Overnight now checks the time every minute and builds approved ideas at $BUILD_AT ($CLOCK_ZONE). If the Mac is asleep or off then, it builds once it is awake again. It has checked the time once already." ;;
    deliver) echo "Installed. Overnight now checks the time every minute, and tests, publishes and delivers at $DELIVER_AT ($CLOCK_ZONE), for a buzz on the wrist at $BUZZ_AT. If the Mac is asleep then, it delivers when the Mac is next awake and online, and the wrist buzzes two minutes after the link is ready." ;;
  esac
}

#   cmd_install [job...]   (no job: all of them)
cmd_install() {
  local node data_dir job_dir report job first_install=no
  (( $# > 0 )) || set -- "${ALL_JOBS[@]}"
  node="$(find_node)" || die "Could not find Node.js. Expected it at $HOME/.local/node/bin/node, or as \"node\" on the PATH."
  require_node_version "$node"
  [[ -f "$ENTRY" ]] || die "The command-line tool is missing: $ENTRY"
  data_dir="$(resolve_data_dir "$node")"
  # The log paths below are written into each job's settings, but a job works out its data folder
  # by itself. If the two would differ, the job would log in one place and keep its database in
  # another. Refuse rather than install that.
  job_dir="$(job_data_dir "$node")"
  if [[ "$data_dir" != "$job_dir" ]]; then
    die "OVERNIGHT_DATA_DIR is set in this shell ($data_dir), but the background job will not see it and would use $job_dir. Put OVERNIGHT_DATA_DIR in $ENV_FILE, then run install again. Nothing was changed."
  fi

  # Try the tool once the way a job will run it: same node, same bare environment. Better
  # to stop here than to install a job that fails every 30 seconds. (--help opens nothing.)
  job_cli "$node" --help >/dev/null 2>&1 \
    || die "\"$node $ENTRY --help\" failed, so the job would fail too. Has \"npm install\" been run in $REPO?"

  # A first start must be quiet. The app already starts paused when nothing says otherwise; on a
  # first install (no database yet) store that choice as well, so the listener cannot come up
  # asking on the watch whatever .env says. A later install leaves the mode as you last set it.
  if [[ ! -f "$data_dir/overnight.db" ]]; then
    first_install=yes
    job_cli "$node" pause >/dev/null \
      || die "Could not put Overnight in quiet mode (\"overnight pause\" failed; its message is above). Nothing was installed or started."
  fi
  # Now a command that reads the settings and opens the database, as every job will. A bad
  # value in .env stops the install here, with the tool's own message. What it prints is also
  # where the schedule and the sandbox mode are read from, exactly as the jobs will see them.
  report="$(job_cli "$node" status --json)" \
    || die "\"overnight status\" failed, so the job would fail too. Its message is above. Nothing was installed or started."

  # Everything that can refuse, for every job named, before anything is changed.
  for job in "$@"; do
    prepare_job "$job" "$node" "$data_dir" "$report"
  done

  # macOS opens a job's log file before starting it and does not create folders for it.
  (umask 077 && mkdir -p -- "$data_dir/logs") || die "Could not create $data_dir/logs."
  # mkdir only sets the mode of folders it creates. An older folder may be open to other accounts.
  chmod 700 "$data_dir" "$data_dir/logs" || die "Could not make $data_dir private."
  mkdir -p -- "$HOME/Library/LaunchAgents"

  for job in "$@"; do
    apply_job "$job" "$data_dir" "$node"
    installed_line "$job" "$data_dir"
    DONE_JOBS+=("$job")
  done
  echo "  node:         $node"
  echo "  repo:         $REPO"
  echo "  data folder:  $data_dir"
  for job in "$@"; do
    echo "  settings:     $(plist_of "$job")"
  done
  # The nightly build with the kiro-crew builder hands its work to the gateway job.
  for job in "$@"; do
    if [[ "$job" == build && ! -f "$(plist_of crew)" ]]; then
      echo "  Note: the \"kiro-crew\" builder needs the Kiro Crew gateway job too: scripts/install-agents.sh install crew"
    fi
  done
  # Once, when a night job was named: the times above are Overnight's, whatever the Mac's clock says.
  if [[ -n "$CLOCK_ZONE" ]]; then
    print_clock_note "$node" "$CLOCK_ZONE"
  fi
  echo
  if [[ "$first_install" == yes ]]; then
    echo "This is a first install, so Overnight was put in quiet mode before it started."
  fi
  print_mode "$node"
  echo
  cmd_status "$@"
}

# ---------- uninstall and restart ----------

#   cmd_uninstall [job...]   (no job: all of them)
cmd_uninstall() {
  local job
  (( $# > 0 )) || set -- "${ALL_JOBS[@]}"
  for job in "$@"; do
    stop_job "$job" || die "The $job job would not stop. It was not removed. Try again in a minute."
    rm -f -- "$(plist_of "$job")"
    case "$job" in
      listen) echo "Removed. Overnight no longer listens in the background. Saved data was not touched." ;;
      crew) echo "Removed. The Kiro Crew gateway no longer runs in the background. Kiro Crew's own files and settings were not touched." ;;
      build) echo "Removed. Overnight no longer builds at night. Saved data was not touched." ;;
      deliver) echo "Removed. Overnight no longer delivers in the morning. Saved data was not touched." ;;
    esac
  done
}

#   cmd_restart [job...]   (no job: every job that is installed)
cmd_restart() {
  local job named=yes kirocrew node="" since code
  local -a jobs=()
  if (( $# == 0 )); then
    named=no
    set -- "${ALL_JOBS[@]}"
  fi
  for job in "$@"; do
    if [[ -f "$(plist_of "$job")" ]]; then
      jobs+=("$job")
    elif [[ "$named" == yes ]]; then
      die "The $job job is not installed. Run: scripts/install-agents.sh install $job"
    fi
  done
  (( ${#jobs[@]} > 0 )) || die "No Overnight job is installed. Install the one you want with: scripts/install-agents.sh install <listen | crew | build | deliver>"
  # Everything that can refuse, for every job, before any of them is stopped.
  for job in "${jobs[@]}"; do
    [[ "$job" == build || "$job" == deliver ]] || continue
    require_not_busy "$job" restarting
    # A job that wakes every minute is asked, through the tool, whether it has looked at the clock.
    if on_timer "$job" && [[ -z "$node" ]]; then
      node="$(find_node)" || die "Could not find Node.js, which is needed to see whether the $job job looks at the clock once it has started again. Expected it at $HOME/.local/node/bin/node, or as \"node\" on the PATH. Nothing was changed."
    fi
  done
  for job in "${jobs[@]}"; do
    if [[ "$job" == build || "$job" == deliver ]]; then
      # Once more, now that its turn has come: the jobs before it may have taken a while.
      require_not_busy "$job" restarting
    fi
    stop_job "$job" || die "The $job job would not stop. Try again in a minute."
    since=""
    if [[ -n "$node" ]]; then
      since="$(utc_now "$node")"
    fi
    start_job "$job" || die "$START_FAILED"
    code=0
    job_in_place "$job" "$node" "$since" || code=$?
    if (( code != 0 )); then
      status_of "$job"
      die "$(not_in_place "$job" "$code")"
    fi
    if [[ "$job" == crew ]]; then
      kirocrew="$(find_kirocrew)" || die "The Kiro Crew gateway job was started again, but Kiro Crew's program could not be found to ask whether the gateway answers. Expected it at $HOME/.local/bin/kirocrew."
      require_gateway_answer "$kirocrew"
    fi
    echo "Restarted: $(title_of "$job")."
    DONE_JOBS+=("$job")
  done
  cmd_status "${jobs[@]}"
}

main() {
  # ${2-all}: only a job that was not given at all means "all". An empty one is a mistake.
  local action="${1:-}" which="${2-all}"
  if (( $# < 1 || $# > 2 )); then
    usage >&2
    exit 2
  fi
  case "$action" in
    -h | --help | help)
      usage
      return 0
      ;;
    install | uninstall | restart | status) ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  if [[ "$which" != all ]] && ! is_job "$which"; then
    usage >&2
    exit 2
  fi
  # "all" is every job; for restart, every job that is installed.
  if [[ "$which" == all ]]; then
    "cmd_$action"
  else
    "cmd_$action" "$which"
  fi
}

# Run only when started as a script. Tests "source" this file to call its functions on their own.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
