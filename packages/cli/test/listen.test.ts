// All text in this file is made up for the tests. None of it is Bee data.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "@overnight/core";
import type { BeeGateway, Detector, DetectorInput, Logger } from "@overnight/core";
import { ALREADY_RUNNING, DETECTOR_NOT_SET_UP, DETECTOR_RETRY_MS, listen, retryingDetector, stubDetector } from "../src/commands/listen.ts";
import type { ListenDeps, ListenFactories } from "../src/commands/listen.ts";
import { testContext } from "./helpers.ts";

type LogLine = { level: string; message: string } & Record<string, unknown>;

function collectingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createLogger({ name: "listener", write: (line) => void lines.push(JSON.parse(line) as LogLine) });
  return { logger, lines };
}

// The listener is given the gateway but must not be driven by these tests, so no method works.
const fakeBee = {} as BeeGateway;
const SOME_INPUT: DetectorInput = { utterances: [{ text: "anything at all", spokenAt: "2026-10-09T18:00:00.000Z" }], recentTitles: [] };
const NOT_SET_UP = { ok: false, reason: "detector is not set up", ms: 0, attempts: 0, retryLater: true };

interface Recorded {
  order: string[];
  lockFiles: string[];
  listenerDeps: Parameters<ListenFactories["createListener"]>[0] | null;
  beeOptions: Parameters<ListenFactories["createBee"]>[0] | null;
  detectorOptions: Parameters<ListenFactories["createDetector"]>[0] | null;
}

interface Overrides {
  ensureSetup?: () => Promise<void>;
  /** Runs while the listener is "listening": start() resolves when this does. */
  start?: (deps: Parameters<ListenFactories["createListener"]>[0]) => Promise<void>;
  createDetector?: ListenFactories["createDetector"];
  /** "held": another listener has the lock. "broken": the lock file cannot be used. */
  lock?: "free" | "held" | "broken";
}

function fakeParts(overrides: Overrides = {}): { factories: ListenFactories; takeLock: ListenDeps["takeLock"]; seen: Recorded } {
  const seen: Recorded = { order: [], lockFiles: [], listenerDeps: null, beeOptions: null, detectorOptions: null };
  const realDetector: Detector = { detect: async () => ({ ok: false, reason: "the fake real detector", ms: 1, attempts: 1 }) };
  const factories: ListenFactories = {
    createBee: (options) => {
      seen.order.push("bee");
      seen.beeOptions = options;
      return fakeBee;
    },
    createDetector:
      overrides.createDetector ??
      ((options) => {
        seen.order.push("detector");
        seen.detectorOptions = options;
        return {
          ...realDetector,
          ensureSetup: async () => {
            seen.order.push("ensureSetup");
            await overrides.ensureSetup?.();
          },
        };
      }),
    createListener: (deps) => {
      seen.order.push("listener");
      seen.listenerDeps = deps;
      return {
        start: async () => {
          seen.order.push("start");
          await overrides.start?.(deps);
          seen.order.push("stopped");
        },
      };
    },
  };
  const takeLock: ListenDeps["takeLock"] = (file) => {
    seen.lockFiles.push(file);
    if (overrides.lock === "broken") throw new Error("unable to open database file\n    at somewhere");
    if (overrides.lock === "held") return null;
    seen.order.push("lock");
    return () => void seen.order.push("release");
  };
  return { factories, takeLock, seen };
}

describe("overnight listen", () => {
  it("takes the lock, builds the parts, runs the listener until it stops, then gives the lock back", async () => {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    const { factories, takeLock, seen } = fakeParts();

    expect(await listen({ ...context, logger, factories, takeLock })).toBe(0);

    expect(seen.order).toEqual(["lock", "bee", "detector", "ensureSetup", "listener", "start", "stopped", "release"]);
    expect(seen.lockFiles).toEqual([path.join(context.paths.root, "listen.lock")]);
    expect(seen.beeOptions).toEqual({ logger });
    expect(seen.detectorOptions).toEqual({ paths: context.paths, logger });
    expect(seen.listenerDeps).toMatchObject({ store: context.store, bee: fakeBee, config: context.config, logger, options: { handleSignals: true, keepAwake: true } });
    // Set-up worked, so calls reach the real detector.
    expect(await seen.listenerDeps?.detector.detect(SOME_INPUT)).toMatchObject({ reason: "the fake real detector" });

    expect(lines[0]).toMatchObject({ level: "info", message: "overnight listen starting", paused: false, dataDir: "/tmp/overnight-cli-test", timeZone: "America/Boise" });
    expect(lines.at(-1)).toMatchObject({ level: "info", message: "overnight listen stopped" });
  });

  it("puts the paused flag in the start-up line", async () => {
    const context = testContext();
    context.store.setPaused(true, "2026-10-09T18:00:00.000Z");
    const { logger, lines } = collectingLogger();
    await listen({ ...context, logger, ...fakeParts() });
    expect(lines[0]).toMatchObject({ message: "overnight listen starting", paused: true });
  });

  it("refuses to start, with one clear line, when another listener holds the lock", async () => {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    const { factories, takeLock, seen } = fakeParts({ lock: "held" });

    expect(await listen({ ...context, logger, factories, takeLock })).toBe(1);

    // No Bee, no Kiro, no listener: nothing that could ask twice.
    expect(seen.order).toEqual([]);
    expect(seen.listenerDeps).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", message: ALREADY_RUNNING, dataDir: "/tmp/overnight-cli-test" });
    expect(ALREADY_RUNNING).toBe("another overnight listen is already running on this data folder; not starting a second one");
  });

  it("does not start when the lock file cannot be used", async () => {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    const { factories, takeLock, seen } = fakeParts({ lock: "broken" });
    expect(await listen({ ...context, logger, factories, takeLock })).toBe(1);
    expect(seen.order).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", reason: "unable to open database file" });
  });

  it("starts listening without waiting for the detector's set-up to finish", async () => {
    const context = testContext();
    let finishSetup = () => {};
    const setupDone = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let duringListening: Promise<unknown> = Promise.resolve(null);
    const { factories, takeLock, seen } = fakeParts({
      ensureSetup: () => setupDone,
      start: async (deps) => {
        // The listener is running and set-up has not finished. A detect() made now waits for it.
        duringListening = deps.detector.detect(SOME_INPUT);
        let settled = false;
        void duringListening.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        finishSetup();
      },
    });

    expect(await listen({ ...context, logger: collectingLogger().logger, factories, takeLock })).toBe(0);

    expect(seen.order).toEqual(["lock", "bee", "detector", "ensureSetup", "listener", "start", "stopped", "release"]);
    // It waited for the one set-up already under way (no second try) and then got a real answer.
    expect(await duringListening).toMatchObject({ reason: "the fake real detector" });
  });

  it("keeps listening when the detector cannot be set up, and answers 'ask again later' meanwhile", async () => {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    const { factories, takeLock, seen } = fakeParts({
      ensureSetup: async () => {
        throw new Error("Kiro content sharing is still switched on.\nsecond line that must not be logged");
      },
    });

    expect(await listen({ ...context, logger, factories, takeLock })).toBe(0);

    expect(seen.order).toEqual(["lock", "bee", "detector", "ensureSetup", "listener", "start", "stopped", "release"]);
    expect(await seen.listenerDeps?.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
    expect(await stubDetector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
    expect(DETECTOR_NOT_SET_UP).toBe("detector is not set up");
    expect(lines.find((line) => line.level === "error")).toMatchObject({ reason: "Kiro content sharing is still switched on.", failedTries: 1, retryInMs: DETECTOR_RETRY_MS });
  });

  it("keeps listening when the detector cannot even be made", async () => {
    const context = testContext();
    const { factories, takeLock, seen } = fakeParts({
      createDetector: () => {
        throw new Error("kiro-cli was not found");
      },
    });
    expect(await listen({ ...context, logger: collectingLogger().logger, factories, takeLock })).toBe(0);
    expect(seen.order).toEqual(["lock", "bee", "listener", "start", "stopped", "release"]);
    expect(await seen.listenerDeps?.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
  });

  it("returns 1 and logs why when the listener fails, and still gives the lock back", async () => {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    const { factories, takeLock, seen } = fakeParts({
      start: async () => {
        throw new Error("the database is locked");
      },
    });
    expect(await listen({ ...context, logger, factories, takeLock })).toBe(1);
    expect(lines.at(-1)).toMatchObject({ level: "error", message: "overnight listen stopped on an error", reason: "the database is locked" });
    expect(seen.order.at(-1)).toBe("release");
  });

  it("logs nothing more about set-up once the listener has stopped", async () => {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    let failSetup = (_error: Error) => {};
    const setup = new Promise<void>((_resolve, reject) => {
      failSetup = reject;
    });
    const { factories, takeLock } = fakeParts({ ensureSetup: () => setup });

    expect(await listen({ ...context, logger, factories, takeLock })).toBe(0);
    // Stopping kills the Kiro call that set-up was waiting on, so it fails a moment later.
    failSetup(new Error("kiro-cli was stopped"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.map((line) => line.message)).toEqual(["overnight listen starting", "overnight listen stopped"]);
  });
});

describe("the detector that keeps trying to get ready", () => {
  /** A detector whose set-up fails `failures` times before it works, and a clock the test moves. */
  function unreliable(failures: number, how: "ensureSetup" | "createDetector" = "ensureSetup") {
    const context = testContext();
    const { logger, lines } = collectingLogger();
    const calls = { create: 0, ensureSetup: 0, detect: 0 };
    let clock = Date.parse("2026-10-09T18:00:00.000Z");
    const factories: ListenFactories = {
      createBee: () => fakeBee,
      createListener: () => ({ start: async () => {} }),
      createDetector: () => {
        calls.create += 1;
        if (how === "createDetector" && calls.create <= failures) throw new Error("kiro-cli was not found");
        return {
          ensureSetup: async () => {
            calls.ensureSetup += 1;
            if (how === "ensureSetup" && calls.ensureSetup <= failures) throw new Error("kiro-cli did not answer in time\nmore detail");
          },
          detect: async () => {
            calls.detect += 1;
            return { ok: false, reason: "the fake real detector", ms: 1, attempts: 1 };
          },
        };
      },
    };
    const wrapped = retryingDetector({ factories, paths: context.paths, logger }, { nowMs: () => clock });
    return { ...wrapped, calls, lines, advance: (ms: number) => void (clock += ms) };
  }

  it("tries set-up again after a minute, and a later detect() reaches the real detector", async () => {
    const d = unreliable(1);
    await d.trySetup(); // the try at start-up, which fails
    expect(d.calls).toEqual({ create: 1, ensureSetup: 1, detect: 0 });

    // Straight away, and just under a minute later: too soon to try again. Nothing is sent.
    expect(await d.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
    d.advance(DETECTOR_RETRY_MS - 1);
    expect(await d.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
    expect(d.calls).toEqual({ create: 1, ensureSetup: 1, detect: 0 });

    // A minute after the failure: set-up is tried again, works, and this same call gets a real answer.
    d.advance(1);
    expect(await d.detector.detect(SOME_INPUT)).toMatchObject({ reason: "the fake real detector" });
    expect(d.calls).toEqual({ create: 1, ensureSetup: 2, detect: 1 });

    // From then on calls go straight through: set-up is not run again.
    expect(await d.detector.detect(SOME_INPUT)).toMatchObject({ reason: "the fake real detector" });
    expect(d.calls).toEqual({ create: 1, ensureSetup: 2, detect: 2 });

    expect(d.lines.map((line) => [line.level, line.message, line.failedTries])).toEqual([
      ["error", "detector is not set up: listening and saving continue, and set-up will be tried again", 1],
      ["info", "detector is set up now: ideas are being noticed again", 1],
    ]);
    // Only the first line of the reason is logged.
    expect(d.lines[0]).toMatchObject({ reason: "kiro-cli did not answer in time", retryInMs: 60_000 });
  });

  it("keeps trying for as long as it takes, once a minute", async () => {
    const d = unreliable(3);
    await d.trySetup();
    for (let minute = 1; minute <= 2; minute += 1) {
      d.advance(DETECTOR_RETRY_MS);
      expect(await d.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
      // A second call in the same minute does not try again.
      expect(await d.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
      expect(d.calls.ensureSetup).toBe(1 + minute);
    }
    d.advance(DETECTOR_RETRY_MS);
    expect(await d.detector.detect(SOME_INPUT)).toMatchObject({ reason: "the fake real detector" });
    expect(d.calls).toEqual({ create: 1, ensureSetup: 4, detect: 1 });
  });

  it("tries again when the detector could not even be made", async () => {
    const d = unreliable(1, "createDetector");
    await d.trySetup();
    expect(await d.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
    d.advance(DETECTOR_RETRY_MS);
    expect(await d.detector.detect(SOME_INPUT)).toMatchObject({ reason: "the fake real detector" });
    expect(d.calls).toEqual({ create: 2, ensureSetup: 1, detect: 1 });
  });

  it("starts set-up from the first detect() if nothing has started it yet", async () => {
    const d = unreliable(0);
    expect(await d.detector.detect(SOME_INPUT)).toMatchObject({ reason: "the fake real detector" });
    expect(d.calls).toEqual({ create: 1, ensureSetup: 1, detect: 1 });
    expect(d.lines).toEqual([]);
  });

  it("shares one set-up try between calls that arrive together", async () => {
    const d = unreliable(0);
    const answers = await Promise.all([d.trySetup(), d.detector.detect(SOME_INPUT), d.detector.detect(SOME_INPUT)]);
    expect(answers.slice(1)).toEqual([expect.objectContaining({ reason: "the fake real detector" }), expect.objectContaining({ reason: "the fake real detector" })]);
    expect(d.calls).toEqual({ create: 1, ensureSetup: 1, detect: 2 });
  });

  it("stops trying once told the listener has stopped", async () => {
    const d = unreliable(1);
    await d.trySetup();
    d.stop();
    d.advance(DETECTOR_RETRY_MS * 10);
    expect(await d.detector.detect(SOME_INPUT)).toEqual(NOT_SET_UP);
    expect(d.calls.ensureSetup).toBe(1);
  });
});
