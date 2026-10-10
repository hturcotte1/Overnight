// The help text. Keep it in step with the commands in cli.ts and with CLAUDE.md.

export const USAGE = `Overnight: say it at lunch, use it at breakfast.

Usage: overnight <command> [options]

  listen                      Listen to Bee, save what is heard, spot ideas and ask about them.
                              Runs until stopped. The background job runs this.
                              Only one runs per data folder: a second one refuses to start.
  status [--json] [--check]   What has been saved and decided so far, and whether the listener is
                              running. Makes no Bee or Kiro calls, unless --check is given: then it
                              also asks Bee whether it is logged in.
  ideas [--json] [--all]      Today's ideas (--all: every idea).
  queue --approved --json     Approved ideas for the next build: at most MAX_BUILDS_PER_NIGHT of them,
                              the longest-approved first. Empty while paused. Read by the nightly builder.
  pause                       Keep listening and saving, but stop asking and building.
  resume                      Ask and build again.
  help                        Show this text.`;
