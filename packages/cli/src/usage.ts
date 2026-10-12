// The help text. Keep it in step with the commands in cli.ts and with CLAUDE.md.

export const USAGE = `Overnight: say it at lunch, use it at breakfast.

Usage: overnight <command> [options]

  listen                      Listen to Bee, save what is heard, spot ideas and ask about them.
                              Runs until stopped. The background job runs this.
                              Only one runs per data folder: a second one refuses to start.
  status [--json] [--check]   What has been saved, decided, built and delivered so far, whether the
                              listener is running, and whether tonight's build is set to happen: the
                              background jobs and their clock, the Kiro Crew gateway, the build
                              sandbox, this month's build credits, the ideas waiting, and the last
                              and next build and deliver times. It only reads. With --check it also
                              asks Bee whether it is logged in.
  preflight                   Thirteen checks of what tonight's run needs, one line each with a tick
                              or a cross and the fix: not paused, Bee, Kiro, the Kiro Crew gateway and
                              its settings, the build skill, the build sandbox, GitHub, the apps repo,
                              the browser for testing, the background jobs and whether they keep
                              their own time. Changes nothing. Exit code 0 only if every check passes.
  ideas [--json] [--all]      Today's ideas (--all: every idea), with the link once one is published
                              and the reason if a build or a publish failed.
  queue --approved --json     Approved ideas for the next build: at most MAX_BUILDS_PER_NIGHT of them,
                              the longest-approved first. Empty while paused.
  build [--if-due]            Tonight's builds, now: each approved idea, longest-approved first, up to
                              MAX_BUILDS_PER_NIGHT a day, one at a time, and no more once the month's
                              MAX_BUILD_CREDITS_PER_MONTH is used up. The builder named by
                              BUILD_BACKEND goes first; the other one is tried if it fails. A build
                              that was cut off (not one that failed) gets one more try on a later
                              night. Builds nothing while paused. Log: logs/build.log
                              With --if-due it first asks Overnight's own clock whether it is time,
                              and does nothing otherwise. The background job runs it that way every
                              minute: the build starts at BUILD_TIME, or once the Mac is awake and
                              online again, at most once a day.
  deliver [--if-due]          The morning, now: test each build inside the sandbox, publish the ones
                              that pass, and put the link on the wrist at DELIVER_TIME (two minutes
                              from now when that has passed, never between 11 pm and 7 am).
                              Log: logs/deliver.log
                              With --if-due, as for build: the background job runs it every minute,
                              and the morning starts 30 minutes before DELIVER_TIME, or once the Mac
                              is awake and online again.
  build --from-now, deliver --from-now
                              Start that job's clock from now: nothing missed before now is run. The
                              installer uses it.
  build-now <ideaId>          Build one approved idea and deliver it, right away. For testing and filming.
                              Refuses while paused.
  rehearse new "<title>" "<pitch>"
                              Add one invented idea, already approved and dated yesterday, and print its
                              id. Use made-up words only: the app may be published.
  rehearse run <ideaId> [--no-publish]
                              Build that idea for real, check it inside the sandbox, publish it for real
                              (with --no-publish: a stand-in instead) and record it as delivered. Bee is
                              always a stand-in here: nothing reaches the wrist, and what would have been
                              sent is written to rehearsal-bee.log in the data folder.
                              Both refuse unless OVERNIGHT_DATA_DIR names a scratch folder on the command
                              itself, and never run on the real data folder: a test idea left there
                              would be picked up by the real nightly jobs. listen, build, deliver and
                              build-now in turn refuse a data folder that holds a rehearsal idea.
                              The night's commands (build, deliver, build-now, rehearse run)
                              stop cleanly on Ctrl-C or a stop signal: they end what they started
                              first. A second one ends them at once. They stop the same way when the
                              Mac slept through part of a run: a build stopped on its first start gets
                              one more try on a later night, and a delivery waits for the next run.
  pause                       Keep listening and saving, but stop asking and building.
  resume                      Ask and build again.
  help                        Show this text.`;
