// SYNTHETIC data: everything this file sets up is made up. None of it is Bee data.
//
// The demo's stage: a throwaway folder of its own, filled with the invented scene (./seed.ts), a
// pretend clock that reads 1:02 AM when the demo starts and runs on from there, the locks held so
// the page says "Listening" (./pretend-running.ts), and, when asked, an invented night that plays
// through by itself (./night-script.ts).
//
// The night is played the way a real one goes, so the page never contradicts itself:
//   - Tonight's build run builds both ideas, one after the other, and then ends.
//   - The pretend clock then skips to the morning: to the time the checks start (half an hour
//     before DELIVER_TIME), and, before the wearer is first "told", to DELIVER_TIME itself, when
//     the quiet hours are over. Nothing is "sent to the wrist" at 1:02 AM.
//   - One morning run checks, publishes and delivers both apps, the one built last first, so the
//     story the Today page leads with is followed through to its end before the other one's.
//
// `npm run dashboard:demo` is the only thing that opens a stage. The folder is made new each time
// (mkdtemp), nothing is ever written outside it, and it is removed again when the demo stops. It
// is only removed if it still carries the seed's own note, so a folder the demo did not fill is
// never deleted.
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dataPaths, nextLocalTime, parseConfig } from "@overnight/core";
import type { Config, DataPaths } from "@overnight/core";
import { DELIVER_LEAD_MINUTES } from "../log-messages.ts";
import { minusMinutes } from "../render/format.ts";
import { DemoFolderError, realFolderProblem, seededDemoFolder } from "./folder.ts";
import { demoNightSteps } from "./night-script.ts";
import type { DemoNightPlace, DemoNightStepName } from "./night-script.ts";
import { pretendRunning } from "./pretend-running.ts";
import type { DemoProgram } from "./pretend-running.ts";
import { DEMO_CLOCK, seedDemoData } from "./seed.ts";
import type { DemoIdeaKey } from "./seed.ts";

/** The start of every demo folder's name, under the system's temporary folder. */
export const DEMO_FOLDER_PREFIX = "overnight-dashboard-demo-";

/** How long after `play()` the invented night begins, and how long it waits between two steps. */
export const PLAY_STARTS_AFTER_MS = 3000;
export const PLAY_STEP_EVERY_MS = 2500;

/** The ideas tonight's build run builds, in order: the build that is under way when the scene opens is finished first, then the idea that was approved and next in line. */
export const PLAY_ORDER: readonly DemoIdeaKey[] = ["choreWheel", "lunchTurns"];

/** The order the morning's run takes the built apps in: the one built last first. It is the one the Today page is leading with when the morning starts. */
export const MORNING_ORDER: readonly DemoIdeaKey[] = ["lunchTurns", "choreWheel"];

/** The whole invented night, part by part: which idea's steps are played, and which program they belong to. */
export const PLAY_PLAN: ReadonlyArray<{ idea: DemoIdeaKey; program: "build" | "deliver" }> = [
  ...PLAY_ORDER.map((idea) => ({ idea, program: "build" as const })),
  ...MORNING_ORDER.map((idea) => ({ idea, program: "deliver" as const })),
];

export interface DemoStage {
  /** The demo's own settings: the defaults, with the throwaway folder as the data folder. Never read from `.env`. */
  config: Config;
  paths: DataPaths;
  /**
   * The pretend clock: 1:02 AM (in the settings' time zone) when the stage opened, running on at
   * the usual speed. The invented night moves it on twice: to the morning's checks, and to DELIVER_TIME.
   */
  now: () => Date;
  /** The scene's ideas by name. */
  ideaIds: Readonly<Record<DemoIdeaKey, string>>;
  /**
   * The invented night's steps, in order (PLAY_PLAN). Each call runs the next one and gives its
   * name, or null when the night is over. While a step is the latest one, the lock of the program
   * it belongs to (the build, or the morning's run) is held, so the page says that program is running.
   */
  nextStep(): DemoNightStepName | null;
  /** Which idea the step that ran last was about. Null before the first step. */
  lastStepIdea(): DemoIdeaKey | null;
  /** Run the steps by themselves, a few seconds apart, once. `onProblem` is told the kind of error if a step fails; the night then stops. */
  play(o?: { startsAfterMs?: number; everyMs?: number; onProblem?: (kind: string) => void; onDone?: () => void }): void;
  /** Stop the night, let go of the locks and remove the folder. Safe to call twice. */
  close(): void;
}

/**
 * Which program a step belongs to. The stage holds that program's lock while the step is the
 * latest one, so the page says it is running. The build's lock is held from the first step until
 * both ideas are built, and the morning's from then until the last app is delivered: the page
 * looks every two seconds while a program runs, and so keeps up with a night that moves every two
 * and a half.
 */
function programOf(step: DemoNightStepName): "build" | "deliver" {
  return step === "deliver-starting" || step === "verified" || step === "pushed" || step === "live-and-published" || step === "told-and-delivered" || step === "fact" ? "deliver" : "build";
}

/** The step at which the wearer is "told". Before the first of them the pretend clock is moved to DELIVER_TIME. */
const TOLD_STEP: DemoNightStepName = "told-and-delivered";

/** Where each idea stands in the night that is played: one build run and one morning run for all of them. */
function placeOf(key: DemoIdeaKey): DemoNightPlace {
  return {
    // The seed opened tonight's run when it started the first build.
    opensBuildRun: false,
    closesBuildRun: key === PLAY_ORDER.at(-1) ? PLAY_ORDER.length : undefined,
    opensMorningRun: key === MORNING_ORDER[0],
    closesMorningRun: key === MORNING_ORDER.at(-1) ? MORNING_ORDER.length : null,
  };
}

/** Remove the demo's folder. Only one that carries the seed's note is emptied; an empty one is removed as it is; anything else is left alone. */
function removeDemoFolder(dir: string): void {
  try {
    rmSync(seededDemoFolder(dir), { recursive: true, force: true });
    return;
  } catch {
    // Not a folder the seed filled (the seed was refused, or failed before it wrote its note).
  }
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or already gone. It is under the temporary folder and is left to the system.
  }
}

/**
 * Open a stage. `under` is where the throwaway folder is made (the system's temporary folder
 * unless a test says otherwise); `realNow` is the real clock the pretend one runs beside.
 * Throws what the seed throws; in that case nothing is left behind.
 */
export function openDemoStage(o: { under?: string; realNow?: () => number; hostile?: boolean; sentinels?: boolean } = {}): DemoStage {
  const realNow = o.realNow ?? (() => Date.now());
  const under = o.under ?? tmpdir();
  // Asked before anything is made, of a folder such as the one about to be made: not even an
  // empty folder is put into the real data folder. The question is put to the disk as well as to
  // the name (./folder.ts), so `under` is known for the folder it is, however it is spelled.
  const refused = realFolderProblem(path.join(under, `${DEMO_FOLDER_PREFIX}new`));
  if (refused !== null) throw new DemoFolderError(refused);
  const dir = mkdtempSync(path.join(under, DEMO_FOLDER_PREFIX));
  let listening: (() => void) | null = null;
  let working: { program: DemoProgram; letGo: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const setWorking = (program: DemoProgram | null): void => {
    if (working !== null && working.program === program) return;
    working?.letGo();
    working = null;
    if (program !== null) working = { program, letGo: pretendRunning(dir, [program]) };
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      working?.letGo();
      listening?.();
    } finally {
      working = null;
      listening = null;
      removeDemoFolder(dir);
    }
  };

  try {
    // The demo's settings never come from `.env`: they are the defaults, pointed at the new folder.
    const config = parseConfig({ OVERNIGHT_DATA_DIR: dir, PAUSED: "false" });
    const start = nextLocalTime(new Date(realNow()), DEMO_CLOCK, config.timeZone);
    let ahead = start.getTime() - realNow();
    const now = (): Date => new Date(realNow() + ahead);
    /** Move the pretend clock on to the next time the clocks read `hhmm`. It runs on from there. */
    const skipTo = (hhmm: string): void => {
      const from = now();
      ahead += nextLocalTime(from, hhmm, config.timeZone).getTime() - from.getTime();
    };
    const { ideaIds } = seedDemoData(dir, { now: start, config, hostile: o.hostile, sentinels: o.sentinels });

    // As the scene has it at 1:02 AM: the listener is running, and so is tonight's build.
    listening = pretendRunning(dir, ["listener"]);
    setWorking("build");

    // An idea's steps are made when its build is first needed, because the list depends on the
    // state the idea is in at that moment. The same list is carried on with in the morning.
    const lists = new Map<DemoIdeaKey, { steps: Array<{ name: string; run(): void }>; at: number }>();
    const listOf = (key: DemoIdeaKey): { steps: Array<{ name: string; run(): void }>; at: number } => {
      let list = lists.get(key);
      if (list === undefined) {
        list = { steps: demoNightSteps(dir, ideaIds[key], config, now, placeOf(key)), at: 0 };
        lists.set(key, list);
      }
      return list;
    };
    let partAt = 0;
    let lastIdea: DemoIdeaKey | null = null;
    let morningBegun = false;
    let anyoneTold = false;
    const nextStep = (): DemoNightStepName | null => {
      if (closed) return null;
      for (;;) {
        const part = PLAY_PLAN[partAt];
        if (part === undefined) return null;
        const list = listOf(part.idea);
        const step = list.steps[list.at];
        const name = step?.name as DemoNightStepName | undefined;
        // This part is played out: the idea has no step left, or its next one belongs to the other program.
        if (step === undefined || name === undefined || programOf(name) !== part.program) {
          partAt += 1;
          continue;
        }
        if (part.program === "deliver" && !morningBegun) {
          // The night is over: the clock skips to when the morning's checks start.
          morningBegun = true;
          skipTo(minusMinutes(config.deliverTime, DELIVER_LEAD_MINUTES));
        }
        if (name === TOLD_STEP && !anyoneTold) {
          // Nobody is told anything in the quiet hours: they end at DELIVER_TIME.
          anyoneTold = true;
          skipTo(config.deliverTime);
        }
        setWorking(part.program);
        step.run();
        list.at += 1;
        lastIdea = part.idea;
        // After the very last step nothing is running any more.
        const over = partAt === PLAY_PLAN.length - 1 && list.at >= list.steps.length;
        if (over) setWorking(null);
        return name;
      }
    };

    const play: DemoStage["play"] = (options = {}) => {
      if (closed || timer !== null) return;
      const everyMs = options.everyMs ?? PLAY_STEP_EVERY_MS;
      const tick = (): void => {
        timer = null;
        if (closed) return;
        let name: DemoNightStepName | null;
        try {
          name = nextStep();
        } catch (error) {
          // The kind of error only: a message can hold a path.
          options.onProblem?.(error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : "Error");
          return;
        }
        if (name === null) {
          options.onDone?.();
          return;
        }
        timer = setTimeout(tick, everyMs);
      };
      timer = setTimeout(tick, options.startsAfterMs ?? PLAY_STARTS_AFTER_MS);
    };

    return { config, paths: dataPaths(config.dataDir), now, ideaIds, nextStep, lastStepIdea: () => lastIdea, play, close };
  } catch (error) {
    close();
    throw error;
  }
}
