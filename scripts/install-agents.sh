#!/bin/bash
# Installs, removes, restarts or checks Overnight's background listener on this Mac.
#
#   scripts/install-agents.sh install     put the job in place and start it (safe to repeat)
#   scripts/install-agents.sh uninstall   stop the job and remove it (saved data is left alone)
#   scripts/install-agents.sh restart     stop and start it again, for example after a code change
#   scripts/install-agents.sh status      is it running, and the last lines of its logs
#
# The job is a macOS "LaunchAgent": a small settings file in ~/Library/LaunchAgents that tells
# macOS to keep `overnight listen` running whenever you are logged in.
#
# This script changes exactly two things, and nothing else on the Mac:
#   - the file  ~/Library/LaunchAgents/com.overnight.listen.plist
#   - the job   com.overnight.listen
# (`install` also makes two folders if they are missing: ~/Library/LaunchAgents, and Overnight's
# own logs folder, because macOS will not start a job whose log folder does not exist. It makes
# Overnight's data folder private to you, and on a first install, when there is no database yet,
# it puts Overnight in quiet mode before anything starts.)
#
# It works from any folder, and with spaces in any path.
set -euo pipefail
unset CDPATH
# Newer versions of bash give "&" a special meaning in ${text//find/replace}. We put XML such as
# "&amp;" there, so switch that off where the option exists. (macOS's own bash does not have it.)
shopt -u patsub_replacement 2>/dev/null || true

LABEL="com.overnight.listen"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null && pwd -P)"
REPO="$(cd -- "$SCRIPT_DIR/.." >/dev/null && pwd -P)"
TEMPLATE="$REPO/launchd/$LABEL.plist.template"
ENTRY="$REPO/packages/cli/src/main.ts"
# The settings file the app reads at start-up, if there is one.
ENV_FILE="$REPO/.env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"
# Node 22.18 is the first release that runs our .ts files directly.
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
START_FAILED="macOS would not start the job (launchctl bootstrap failed). You must be logged in at this Mac's screen, not only over a remote shell. \"scripts/install-agents.sh status\" shows where things stand."
NOT_RUNNING="The job is in place but is not running. The last exit code and the log lines above say why. macOS tries it again every 30 seconds, so it starts by itself once the cause is fixed; \"scripts/install-agents.sh uninstall\" takes it out again."

die() {
  printf 'install-agents: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: scripts/install-agents.sh <install | uninstall | restart | status>

  install     Put Overnight's background listener in place and start it. Safe to repeat.
  uninstall   Stop the listener and remove it. Saved data is left alone.
  restart     Stop and start the listener again, for example after a code change.
  status      Show whether it is running and the last lines of its logs.
EOF
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

# The same question, answered the way the background job will answer it. The job is given only
# PATH and HOME (see the template), so an OVERNIGHT_DATA_DIR that exists only in the shell running
# this script never reaches it: the job reads .env, or falls back to ~/.overnight.
job_data_dir() {
  (
    unset OVERNIGHT_DATA_DIR
    resolve_data_dir "${1:-}"
  )
}

# The folder the job's logs are in. Read from the installed settings file when there is one, so
# a later change to .env, or a shell without OVERNIGHT_DATA_DIR, cannot point us at the wrong
# place. With nothing installed, it is where this shell's settings say.
logs_dir() {
  local launchd_log node dir
  if [[ -f "$PLIST" ]] && launchd_log="$(plutil -extract StandardOutPath raw -o - "$PLIST" 2>/dev/null)" && [[ "$launchd_log" == /* ]]; then
    dirname -- "$launchd_log"
    return 0
  fi
  node="$(find_node || true)"
  dir="$(resolve_data_dir "$node")" || return 1
  printf '%s\n' "$dir/logs"
}

# ---------- the command-line tool ----------

# Run the `overnight` tool the way the background job runs it: same node, and the same bare
# environment (only PATH and HOME, see the template), so it reads its settings from .env alone.
#   job_cli <node> <arguments...>
job_cli() {
  local node="$1"
  shift
  env -i HOME="$HOME" PATH="$(dirname -- "$node"):/usr/bin:/bin:/usr/sbin:/sbin" "$node" "$ENTRY" "$@"
}

# "paused" or "live", as the background job sees it. "unknown" if the tool would not say.
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

# ---------- the settings file ----------

# The plist is XML, so a path with "&" or "<" in it has to be written the XML way.
xml_escape() {
  local text="$1"
  text="${text//&/&amp;}"
  text="${text//</&lt;}"
  text="${text//>/&gt;}"
  printf '%s' "$text"
}

# Print the template with its placeholders filled in.
#   render_plist <node> <repo> <data dir> <home>
render_plist() {
  local node repo data_dir home node_dir content
  node="$(xml_escape "$1")"
  node_dir="$(xml_escape "$(dirname -- "$1")")"
  repo="$(xml_escape "$2")"
  data_dir="$(xml_escape "$3")"
  home="$(xml_escape "$4")"
  [[ -f "$TEMPLATE" ]] || die "The template is missing: $TEMPLATE"
  content="$(cat -- "$TEMPLATE")"
  content="${content//__NODE_DIR__/$node_dir}"
  content="${content//__NODE__/$node}"
  content="${content//__REPO__/$repo}"
  content="${content//__DATA_DIR__/$data_dir}"
  content="${content//__HOME__/$home}"
  printf '%s\n' "$content"
}

# ---------- the job ----------

job_loaded() {
  launchctl print "$TARGET" >/dev/null 2>&1
}

# Is the job's process there right now? A job that failed at once has no pid: macOS waits 30
# seconds before it tries again.
job_running() {
  local info
  info="$(launchctl print "$TARGET" 2>/dev/null)" || return 1
  grep -q $'^\tpid = ' <<<"$info"
}

# After a start: give the job a moment, then look. A second look, so that a slow start is not
# called a failure.
job_stayed_up() {
  sleep 2
  if job_running; then
    return 0
  fi
  sleep 3
  job_running
}

# Stop the job and take it out of macOS's list. Fine if it was not there.
# macOS asks the listener to stop (so it can finish what it is doing) and ends it by force
# after 30 seconds if it has not (ExitTimeOut in the template).
stop_job() {
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  # bootout can return before the old job is really gone, and starting a new copy while it is
  # still there fails with an unhelpful "Input/output error". Wait for it, up to 35 seconds.
  local tries=0
  while job_loaded; do
    tries=$((tries + 1))
    if (( tries > 140 )); then
      return 1
    fi
    sleep 0.25
  done
  return 0
}

# Hand the installed settings file to macOS, which starts the job straight away.
start_job() {
  # "enable" only undoes an earlier "launchctl disable" of this same job, which would otherwise
  # make the next step fail.
  launchctl enable "$TARGET" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    # Now and then macOS needs a moment after an old copy has gone. Try once more, out loud.
    sleep 2
    launchctl bootstrap "$DOMAIN" "$PLIST" || return 1
  fi
  return 0
}

cmd_status() {
  local info logs log

  echo "Overnight listener ($LABEL)"
  if info="$(launchctl print "$TARGET" 2>/dev/null)"; then
    # Top-level lines start with exactly one tab; deeper ones repeat names like "state".
    printf '%s\n' "$info" | awk -F' = ' '
      /^\tstate = /          && !("state" in seen) { seen["state"] = $2 }
      /^\tpid = /            && !("pid" in seen)   { seen["pid"] = $2 }
      /^\tlast exit code = / && !("exit" in seen)  { seen["exit"] = $2 }
      END {
        print "  state:           " (("state" in seen) ? seen["state"] : "unknown")
        print "  pid:             " (("pid" in seen) ? seen["pid"] : "none (not running right now)")
        print "  last exit code:  " (("exit" in seen) ? seen["exit"] : "unknown")
      }'
  elif [[ -f "$PLIST" ]]; then
    echo "  state:           not loaded (the settings file is there, but macOS is not running the job)"
    echo "                   Run: scripts/install-agents.sh install"
  else
    echo "  state:           not installed"
  fi

  # The listener keeps its own log. As a background job it prints nothing else, so the second
  # file only ever holds what went wrong outside that log: a crash, or a bad setting.
  logs="$(logs_dir)"
  log="$logs/listen.log"
  if [[ -s "$log" ]]; then
    echo "  last 5 lines of its log ($log):"
    tail -n 5 -- "$log" | sed 's/^/    /'
  else
    echo "  nothing in its log yet ($log)"
  fi
  log="$logs/listen.launchd.log"
  if [[ -s "$log" ]]; then
    echo "  last 5 lines printed outside that log, for example by a crash ($log):"
    tail -n 5 -- "$log" | sed 's/^/    /'
  else
    echo "  nothing printed outside that log ($log)"
  fi
}

cmd_install() {
  local node data_dir job_dir content first_install=no
  node="$(find_node)" || die "Could not find Node.js. Expected it at $HOME/.local/node/bin/node, or as \"node\" on the PATH."
  require_node_version "$node"
  [[ -f "$ENTRY" ]] || die "The command-line tool is missing: $ENTRY"
  data_dir="$(resolve_data_dir "$node")"
  # The log path below is written into the job's settings, but the job works out its data folder
  # by itself. If the two would differ, the job would log in one place and keep its database in
  # another. Refuse rather than install that.
  job_dir="$(job_data_dir "$node")"
  if [[ "$data_dir" != "$job_dir" ]]; then
    die "OVERNIGHT_DATA_DIR is set in this shell ($data_dir), but the background job will not see it and would use $job_dir. Put OVERNIGHT_DATA_DIR in $ENV_FILE, then run install again. Nothing was changed."
  fi

  # Try the tool once the way the job will run it: same node, same bare environment. Better
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
  # Now a command that reads the settings and opens the database, as the listener will. A bad
  # value in .env stops the install here, with the tool's own message.
  job_cli "$node" status --json >/dev/null \
    || die "\"overnight status\" failed, so the job would fail too. Its message is above. Nothing was installed or started."

  content="$(render_plist "$node" "$REPO" "$data_dir" "$HOME")"
  if grep -q '__[A-Z][A-Z_]*__' <<<"$content"; then
    die "The template has a placeholder this script does not fill in: $TEMPLATE"
  fi
  plutil -lint - <<<"$content" >/dev/null || die "The filled-in settings file is not valid. Nothing was changed."

  # macOS opens the job's log file before starting it and does not create folders for it.
  (umask 077 && mkdir -p -- "$data_dir/logs") || die "Could not create $data_dir/logs."
  # mkdir only sets the mode of folders it creates. An older folder may be open to other accounts.
  chmod 700 "$data_dir" "$data_dir/logs" || die "Could not make $data_dir private."
  mkdir -p -- "$(dirname -- "$PLIST")"

  stop_job || die "The old copy of the job would not stop. Nothing was changed. Try again in a minute."
  (umask 177 && printf '%s\n' "$content" >"$PLIST") || die "Could not write $PLIST."
  chmod 600 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "$PLIST did not come out valid."

  start_job || die "$START_FAILED"

  # macOS accepting the job says nothing about whether it stays up: a bad value in .env, a second
  # listener already running, or a missing module ends it within a second. Look before saying it worked.
  if ! job_stayed_up; then
    cmd_status
    die "$NOT_RUNNING"
  fi

  echo "Installed. Overnight now listens in the background and starts again at login."
  echo "  node:         $node"
  echo "  repo:         $REPO"
  echo "  data folder:  $data_dir"
  echo "  settings:     $PLIST"
  echo
  if [[ "$first_install" == yes ]]; then
    echo "This is a first install, so Overnight was put in quiet mode before it started."
  fi
  print_mode "$node"
  echo
  cmd_status
}

cmd_uninstall() {
  stop_job || die "The job would not stop. Nothing was removed. Try again in a minute."
  rm -f -- "$PLIST"
  echo "Removed. Overnight no longer listens in the background. Saved data was not touched."
}

cmd_restart() {
  [[ -f "$PLIST" ]] || die "The listener is not installed. Run: scripts/install-agents.sh install"
  stop_job || die "The job would not stop. Try again in a minute."
  start_job || die "$START_FAILED"
  if ! job_stayed_up; then
    cmd_status
    die "$NOT_RUNNING"
  fi
  echo "Restarted."
  cmd_status
}

main() {
  if (( $# != 1 )); then
    usage >&2
    exit 2
  fi
  case "$1" in
    install) cmd_install ;;
    uninstall) cmd_uninstall ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    -h | --help | help) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

# Run only when started as a script. Tests "source" this file to call render_plist on its own.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
