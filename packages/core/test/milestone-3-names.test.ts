// The names and shapes that the other packages were built against in Milestone 3. Most of this
// file is checked by the typecheck, not by running it: if a name here is renamed or a signature
// changes, the mistake shows up in core, not three packages away.
import { describe, expect, it } from "vitest";
import * as core from "../src/index.ts";
import type {
  BuildBudget,
  BuildCreditsTotal,
  ClockedJob,
  Config,
  DataPaths,
  KeepAwake,
  KeepAwakeChild,
  KeepAwakeMode,
  Logger,
  NewBuildCost,
  NightClockConfig,
  NightDecision,
  NightFacts,
  NightRun,
  NightSlot,
  NightView,
  NightWait,
  SpawnKeepAwake,
  Store,
} from "../src/index.ts";

/** Compiles only when `Given` and `Wanted` can each stand in for the other. */
type Same<Given, Wanted> = [Given] extends [Wanted] ? ([Wanted] extends [Given] ? true : never) : never;
const same = <Given, Wanted>(_ok: Same<Given, Wanted>): void => {};

describe("what Milestone 3 added to core", () => {
  it("has every name, with the signature the plan gave it", () => {
    // time.ts
    same<typeof core.previousLocalTime, (at: Date, hhmm: string, timeZone: string) => { at: Date; day: string }>(true);
    same<typeof core.localMonthBounds, (at: Date, timeZone: string) => { start: Date; end: Date }>(true);

    // night-clock.ts
    same<ClockedJob, "build" | "deliver">(true);
    same<typeof core.CLOCKED_JOBS, readonly ClockedJob[]>(true);
    same<NightClockConfig, Pick<Config, "timeZone" | "buildTime" | "deliverTime">>(true);
    same<NightSlot, { day: string; at: Date }>(true);
    // No "on-battery": the owner's decision of Oct 11 is that the Mac is kept awake on battery too.
    // "lid-closed" was added on Oct 12: on battery with the lid closed the Mac sleeps whatever is
    // asked, so a run started in a moment's wake could only be cut short.
    same<NightWait, "build-running" | "build-not-started" | "lid-closed" | "offline">(true);
    same<NightRun, { day: string; slotAt: string; noticedAt: string; startedAt: string | null; closedAt: string | null; closedAs: "done" | "cut-short" | "first-check" | null; waiting: NightWait | null }>(true);
    // `previousCheckAt` was added in the fix round after the plan: the deliver job's 20 minutes
    // for a late build must not run out while the Mac is asleep, and only the caller knows when
    // the job's check before this one was.
    same<keyof NightFacts, "job" | "now" | "config" | "record" | "build" | "lidClosedOnBattery" | "online" | "previousCheckAt">(true);
    same<NightFacts["previousCheckAt"], string | null | undefined>(true);
    // Added with "lid-closed". One yes or no, already worked out by the caller from two readings:
    // the clock itself is told nothing about the power source or the lid.
    same<NightFacts["lidClosedOnBattery"], boolean | undefined>(true);
    same<NonNullable<NightFacts["build"]>, { open: boolean; running: boolean | null; jobAlive: boolean }>(true);
    same<
      NightDecision,
      | { action: "nothing" }
      | { action: "adopt"; slot: NightSlot }
      | { action: "close"; run: NightRun }
      | { action: "wait"; reason: NightWait; run: NightRun; changed: boolean }
      | { action: "run"; run: NightRun; lateMs: number; firstNotice: boolean }
    >(true);
    same<
      NightView,
      {
        slotAt: string;
        slotDay: string;
        state: "no-record" | "done" | "due" | "running";
        waiting: NightWait | null;
        nextSlotAt: string;
        checkedAt: string | null;
        lastRun: { day: string; startedAt: string; closedAt: string | null; closedAs: NightRun["closedAs"]; lateMinutes: number } | null;
        // Added in the fix round after the plan: a record dated ahead of the clock stops the job,
        // and `status` could not see it.
        recordAhead: string | null;
      }
    >(true);
    same<typeof core.clockMinus, (hhmm: string, minutes: number) => string>(true);
    same<typeof core.slotTime, (job: ClockedJob, config: Pick<Config, "buildTime" | "deliverTime">) => string>(true);
    same<typeof core.currentSlot, (job: ClockedJob, now: Date, config: NightClockConfig) => NightSlot>(true);
    same<typeof core.nextSlotAt, (job: ClockedJob, now: Date, config: NightClockConfig) => Date>(true);
    same<typeof core.readNightRun, (store: Pick<Store, "getValue">, job: ClockedJob) => NightRun | null>(true);
    same<typeof core.writeNightRun, (store: Pick<Store, "setValue">, job: ClockedJob, run: NightRun, now: Date) => void>(true);
    same<typeof core.readLastNightRun, (store: Pick<Store, "getValue">, job: ClockedJob) => NightRun | null>(true);
    same<typeof core.readCheckedAt, (store: Pick<Store, "getValue">, job: ClockedJob) => string | null>(true);
    same<typeof core.noteChecked, (store: Pick<Store, "setValue">, job: ClockedJob, now: Date) => void>(true);
    same<typeof core.noticedRun, (slot: NightSlot, now: Date) => NightRun>(true);
    same<typeof core.waitingRun, (run: NightRun, reason: NightWait | null) => NightRun>(true);
    same<typeof core.startedRun, (run: NightRun, now: Date) => NightRun>(true);
    same<typeof core.closedRun, (run: NightRun, how: "done" | "cut-short" | "first-check", now: Date) => NightRun>(true);
    same<typeof core.slotIsOpen, (job: ClockedJob, now: Date, config: NightClockConfig, record: NightRun | null) => boolean>(true);
    same<typeof core.decideNight, (facts: NightFacts) => NightDecision>(true);
    same<
      typeof core.describeNight,
      (input: { job: ClockedJob; now: Date; config: NightClockConfig; record: NightRun | null; last: NightRun | null; checkedAt: string | null; running: boolean | null }) => NightView
    >(true);
    const parsed: NightRun = core.nightRunSchema.parse(core.noticedRun({ day: "2026-10-12", at: new Date("2026-10-12T07:00:00.000Z") }, new Date("2026-10-12T07:00:00.000Z")));
    expect(parsed.day).toBe("2026-10-12");

    // keep-awake.ts
    same<KeepAwakeMode, "mains" | "always">(true);
    same<typeof core.startKeepAwake, (logger: Logger, pid?: number, spawnChild?: SpawnKeepAwake, mode?: KeepAwakeMode) => KeepAwake>(true);
    same<SpawnKeepAwake, (command: string, args: string[]) => KeepAwakeChild>(true);

    // paths.ts
    same<DataPaths["built"], string>(true);
    same<typeof core.finishedBuildDir, (paths: Pick<DataPaths, "built" | "workspaces">, ideaId: string) => string>(true);

    // config.ts
    same<Config["maxBuildCreditsPerMonth"], number>(true);
    same<typeof core.DASHBOARD_PORT, 4321>(true);
    // Added in the fix round after the plan: the ledger refuses one build above this.
    same<typeof core.HIGHEST_BUILD_CREDIT_LIMIT, 100000>(true);

    // store.ts
    same<NewBuildCost, { ideaId: string; at: string; backend: string; credits: number; measured: boolean }>(true);
    same<BuildCreditsTotal, { credits: number; estimated: number; tries: number }>(true);
    same<Store["recordBuildCost"], (cost: NewBuildCost) => void>(true);
    same<Store["buildCreditsBetween"], (start: string, end: string) => BuildCreditsTotal>(true);

    // build-budget.ts
    same<BuildBudget, { monthStart: string; monthEnd: string; counted: number; estimated: number; tries: number; limit: number; reached: boolean }>(true);
    same<typeof core.estimatedBuildCredits, (agentMs: number) => number>(true);
    same<typeof core.buildBudget, (store: Pick<Store, "buildCreditsBetween">, config: Pick<Config, "maxBuildCreditsPerMonth" | "timeZone">, now: Date) => BuildBudget>(true);
    same<typeof core.budgetReachedText, (budget: BuildBudget, timeZone: string) => string>(true);
  });

  it("has the constants at the values the plan gave them", () => {
    expect({
      DELIVER_LEAD_MINUTES: core.DELIVER_LEAD_MINUTES,
      NIGHT_TICK_SECONDS: core.NIGHT_TICK_SECONDS,
      NIGHT_CHECK_FRESH_MS: core.NIGHT_CHECK_FRESH_MS,
      WOKE_GAP_MS: core.WOKE_GAP_MS,
      SETTLE_MS: core.SETTLE_MS,
      DELIVER_WAITS_FOR_BUILD_MS: core.DELIVER_WAITS_FOR_BUILD_MS,
      LATE_AFTER_MS: core.LATE_AFTER_MS,
      ESTIMATED_CREDITS_PER_MINUTE: core.ESTIMATED_CREDITS_PER_MINUTE,
      DASHBOARD_PORT: core.DASHBOARD_PORT,
      HIGHEST_BUILD_CREDIT_LIMIT: core.HIGHEST_BUILD_CREDIT_LIMIT,
    }).toEqual({
      DELIVER_LEAD_MINUTES: 30,
      NIGHT_TICK_SECONDS: 60,
      NIGHT_CHECK_FRESH_MS: 180_000,
      WOKE_GAP_MS: 150_000,
      SETTLE_MS: 60_000,
      DELIVER_WAITS_FOR_BUILD_MS: 1_200_000,
      LATE_AFTER_MS: 120_000,
      ESTIMATED_CREDITS_PER_MINUTE: 2,
      DASHBOARD_PORT: 4321,
      HIGHEST_BUILD_CREDIT_LIMIT: 100_000,
    });
  });

  it("still has everything Milestones 0 to 2 are built on", () => {
    for (const name of ["Store", "parseConfig", "loadConfig", "ConfigError", "dataPaths", "ensureDataDirs", "createLogger", "silentLogger", "errorSummary", "nowIso", "localDateKey", "zonedTimeToUtc", "parseHhMm", "nextLocalTime", "localDayBounds", "formatLocal", "isBuildAwaitingRetry", "BUILD_STOPPED_REASON", "BUILD_INTERRUPTED_REASON", "MAX_BUILD_STARTS", "assertTransition", "InvalidTransitionError", "IDEA_STATES"]) {
      expect(core, name).toHaveProperty(name);
    }
  });
});
