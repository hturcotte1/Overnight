// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
// start() and stop() with real timers, kept tiny. The clock the listener reads is still the test's.
import { BeeError } from "@overnight/core";
import type { DetectorInput } from "@overnight/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createListener, CURSOR_KEY } from "../src/index.ts";
import type { ListenerOptions, SpawnKeepAwake } from "../src/index.ts";
import { FakeStream, hearAndDetect, ideaVerdict, IDEA_LINES, makeRig, MINUTE, SECOND, T0 } from "./helpers.ts";
import type { Rig } from "./helpers.ts";

/** Fast timers. The connect wait is long on purpose: these tests send Bee's connect message themselves. */
const FAST: Partial<ListenerOptions> = { pollMs: 5, reconnectDelaysMs: [5], connectGraceMs: 60_000, loginRecheckMs: 5, wakeCheckMs: 5 };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorsIn = (rig: Rig) => rig.logs().filter((line) => line.level === "error");
const messagesIn = (rig: Rig, message: string) => rig.logs().filter((line) => line.message === message);

/** A detector call that stays "with the model" until the test lets it go. */
function slowDetector(rig: Rig): { finish: () => void } {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  rig.detector.detect = async (input: DetectorInput) => {
    rig.detector.inputs.push(input);
    await released;
    return { ok: true, verdict: ideaVerdict(), ms: 40, attempts: 1 };
  };
  return { finish: () => release() };
}

/** Every listener a test starts is stopped afterwards, pass or fail, so no timer outlives its test. */
const started: Rig[] = [];
function startedRig(setup: Parameters<typeof makeRig>[0] = {}): { rig: Rig; running: Promise<void>; isDone: () => boolean } {
  const rig = makeRig({ ...setup, options: { ...FAST, ...setup.options } });
  started.push(rig);
  let done = false;
  const running = rig.listener.start().then(() => {
    done = true;
  });
  return { rig, running, isDone: () => done };
}
afterEach(async () => {
  for (const rig of started.splice(0)) await rig.listener.stop();
});

describe("start and stop", () => {
  it("opens a stream, backfills once connected, opens a new stream when one ends, and stops cleanly", async () => {
    const { rig, running, isDone } = startedRig();
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    expect(rig.bee.changedCalls).toEqual([]); // not before Bee's connect message

    rig.bee.lastStream.push({ type: "connected" });
    await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(1));

    rig.bee.lastStream.end({ reason: "ended" });
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
    rig.bee.lastStream.push({ type: "connected" });
    await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(2));

    rig.bee.lastStream.end({ reason: "error", message: "the connection was reset" });
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(3));
    expect(isDone()).toBe(false);

    await rig.listener.stop();
    await running;
    expect(isDone()).toBe(true);
    expect(rig.bee.lastStream.closed).toBe(true);
    expect(errorsIn(rig)).toEqual([]);

    // Stopped means stopped: no new stream, no more passes.
    const calls = rig.bee.changedCalls.length;
    await pause(30);
    expect(rig.bee.streams).toHaveLength(3);
    expect(rig.bee.changedCalls).toHaveLength(calls);
  });

  it("backfills after a short wait when Bee's connect message never comes", async () => {
    const { rig } = startedRig({ options: { connectGraceMs: 10 } });
    await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(1));
    expect(rig.bee.streams).toHaveLength(1);
  });

  it("does not backfill for a stream that ended before it connected", async () => {
    const { rig } = startedRig();
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    rig.bee.lastStream.end({ reason: "error" });
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
    await pause(20);
    expect(rig.bee.changedCalls).toEqual([]);
  });

  describe("when the backfill after a connect fails", () => {
    const failure = () => new BeeError("timeout", "bee changed took longer than 30 s");

    it("tries it again while the stream stays up", async () => {
      const { rig } = startedRig({ options: { retryDelayMs: 5 } });
      rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
      rig.bee.changedReplies.push(failure(), { nextCursor: "cursor-2", conversationIds: [] });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      rig.bee.lastStream.push({ type: "connected" });

      await vi.waitFor(() => expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2"));
      // Caught up: no third call.
      await pause(30);
      expect(rig.bee.changedCalls).toEqual(["cursor-1", "cursor-1"]);
    });

    it("gives up after three tries, until the next connect", async () => {
      const { rig } = startedRig({ options: { retryDelayMs: 5 } });
      rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
      rig.bee.changedReplies.push(failure(), failure(), failure());
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      rig.bee.lastStream.push({ type: "connected" });
      await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(3));
      await pause(30);
      expect(rig.bee.changedCalls).toHaveLength(3);

      rig.bee.lastStream.end();
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      rig.bee.lastStream.push({ type: "connected" });
      await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(4));
    });

    it("leaves the retry to the next stream if this one ends first", async () => {
      // The retry is due 200 ms after the failure. The stream ends well before that.
      const { rig } = startedRig({ options: { retryDelayMs: 200 } });
      rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
      rig.bee.changedReplies.push(failure());
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      rig.bee.lastStream.push({ type: "connected" });
      await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(1), { interval: 5 });

      rig.bee.lastStream.end();
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      await pause(300);
      expect(rig.bee.changedCalls).toHaveLength(1);
    });
  });

  it("tries again when the stream cannot even be opened", async () => {
    const rig = makeRig({ options: FAST });
    started.push(rig);
    rig.bee.streamOpenError = new BeeError("failed", "the bee program is missing");
    void rig.listener.start();
    // The first try throws; the second, a reconnect delay later, works.
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    expect(errorsIn(rig).map((line) => [line.message, line.kind])).toEqual([["could not open the Bee stream", "failed"]]);
  });

  it("saves what the stream sends and runs both passes on its timer", async () => {
    const { rig } = startedRig();
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    const stream = rig.bee.lastStream;
    stream.push({ type: "connected" });
    stream.push({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
    IDEA_LINES.forEach((text, index) => stream.push({ type: "utterance", beeUtteranceId: 7000 + index, conversationUuid: "conv-a", text, spokenAt: rig.clock.iso() }));
    expect(rig.store.countUtterances()).toBe(2);

    // Not quiet yet: several polls go by and the detector is left alone.
    await pause(30);
    expect(rig.detector.inputs).toHaveLength(0);

    rig.detector.script.push(ideaVerdict());
    rig.clock.advance(rig.options.quietMs);
    await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]));
    expect(rig.bee.createCalls.map((call) => call.text)).toEqual(["💡 Build tonight? Whose turn to pay"]);

    rig.bee.todos.set(9001, "completed");
    await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["approved"]));
  });

  it("logs a pass that throws and carries on", async () => {
    const rig = makeRig({ options: FAST });
    started.push(rig);
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    vi.spyOn(rig.store, "conversationsAwaitingDetection").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    void rig.listener.start();

    await vi.waitFor(() => expect(rig.detector.inputs).toHaveLength(1));
    expect(errorsIn(rig).map((line) => line.message)).toEqual(["detection pass failed"]);
  });

  it("uses the gap, not a line that arrived after it, to decide how far back to fetch", async () => {
    const rig = makeRig({ options: FAST });
    started.push(rig);
    rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
    void rig.listener.start();
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    const first = rig.bee.lastStream;
    first.push({ type: "connected" });
    await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(1));
    first.push({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
    rig.clock.advance(SECOND);
    first.push({ type: "utterance", beeUtteranceId: 7000, conversationUuid: "conv-a", text: "before the gap we talked about the fence", spokenAt: rig.clock.iso() });

    // The stream drops ten seconds in. It is back three minutes later, mid-conversation.
    rig.clock.advance(9 * SECOND);
    first.end({ reason: "ended" });
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
    rig.clock.advance(3 * MINUTE);
    const second = rig.bee.lastStream;
    second.push({ type: "utterance", beeUtteranceId: 7001, conversationUuid: "conv-a", text: "after the gap we are on to dinner plans", spokenAt: rig.clock.iso() });
    rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
    rig.bee.transcripts.set(4100, [{ beeUtteranceId: 902, text: "someone should build a fence cost calculator", spokenAt: new Date(Date.parse(T0) + MINUTE).toISOString() }]);
    second.push({ type: "connected" });

    await vi.waitFor(() => expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2"));
    // A minute before the last line received while the first stream was alive.
    expect(rig.bee.transcriptCalls).toEqual([{ id: 4100, sinceMs: Date.parse(T0) + SECOND - MINUTE }]);
    expect(rig.store.countUtterances()).toBe(3);
  });

  describe("when the Mac slept", () => {
    /** The listener reads this clock only to spot a jump. A test "sleeps" by making it jump. */
    function sleepyClock() {
      let sleptMs = 0;
      return { wallClock: () => Date.now() + sleptMs, sleepFor: (ms: number) => void (sleptMs += ms) };
    }
    const WOKE = "the Mac seems to have been asleep; reopening the Bee stream to catch up";

    it("reopens the stream, and backfills from when the sleep began", async () => {
      const { wallClock, sleepFor } = sleepyClock();
      const { rig } = startedRig({ wallClock });
      rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      const first = rig.bee.lastStream;
      first.push({ type: "connected" });
      await vi.waitFor(() => expect(rig.bee.changedCalls).toHaveLength(1));
      first.push({ type: "conversation", kind: "new", beeId: 4100, uuid: "conv-a", state: "CAPTURING", startTime: T0, endTime: null });
      rig.clock.advance(SECOND);
      first.push({ type: "utterance", beeUtteranceId: 7000, conversationUuid: "conv-a", text: "before the sleep we talked about the fence", spokenAt: rig.clock.iso() });
      await pause(30);
      expect(messagesIn(rig, WOKE)).toEqual([]);

      // The lid closes ten seconds in and opens ten minutes later. The old stream still looks
      // open, and hands over one more line a couple of seconds before the sleep is noticed.
      rig.clock.advance(9 * SECOND + 10 * MINUTE);
      first.push({ type: "utterance", beeUtteranceId: 7001, conversationUuid: "conv-a", text: "after the sleep we are on to dinner plans", spokenAt: rig.clock.iso() });
      rig.clock.advance(2 * SECOND);
      rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100] });
      rig.bee.transcripts.set(4100, [{ beeUtteranceId: 902, text: "someone should build a fence cost calculator", spokenAt: new Date(Date.parse(T0) + 5 * MINUTE).toISOString() }]);
      sleepFor(10 * MINUTE);

      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      expect(first.closed).toBe(true);
      const woke = messagesIn(rig, WOKE);
      expect(woke).toHaveLength(1);
      expect(woke[0]?.level).toBe("warn");
      expect(woke[0]?.lateMs).toBeGreaterThan(10 * MINUTE - SECOND);

      rig.bee.lastStream.push({ type: "connected" });
      await vi.waitFor(() => expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-2"));
      // The gap began when the sleep did. So the fetch starts a minute before the last line that
      // arrived before the sleep, not before the line that arrived after it.
      expect(rig.bee.transcriptCalls).toEqual([{ id: 4100, sinceMs: Date.parse(T0) + SECOND - MINUTE }]);
      expect(rig.store.countUtterances()).toBe(3);
    });

    it("is noticed even when it began while a pass was waiting on the detector", async () => {
      const { wallClock, sleepFor } = sleepyClock();
      const { rig } = startedRig({ wallClock });
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      const detector = slowDetector(rig);
      await vi.waitFor(() => expect(rig.detector.inputs).toHaveLength(1));
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));

      // The pass is still out. The check for a sleep must not be waiting behind it.
      sleepFor(10 * MINUTE);
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      expect(rig.bee.streams[0]?.closed).toBe(true);
      expect(messagesIn(rig, WOKE)).toHaveLength(1);
      detector.finish();
    });

    it("does not mistake a clock that was set back for a sleep", async () => {
      const { wallClock, sleepFor } = sleepyClock();
      const { rig } = startedRig({ wallClock });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      sleepFor(-10 * MINUTE);
      await pause(40);
      expect(rig.bee.streams).toHaveLength(1);
      expect(messagesIn(rig, WOKE)).toEqual([]);
    });
  });

  describe("when a stream goes silent", () => {
    const IDLE = "nothing from Bee for a while; opening a fresh stream in case this one has died";

    it("opens a fresh one after a while, backfills on it, and says so in one info line", async () => {
      const { rig, running } = startedRig({ options: { streamIdleReopenMs: 200 } });
      rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      const first = rig.bee.lastStream;
      first.push({ type: "connected" });

      // Events of any kind keep the stream: half a second of them, well past the idle time.
      for (let n = 0; n < 10; n += 1) {
        await pause(50);
        first.push(n % 2 === 0 ? { type: "todo-deleted", todoId: 31337 } : { type: "utterance", beeUtteranceId: 7000 + n, conversationUuid: "conv-a", text: "still talking about the fence", spokenAt: rig.clock.iso() });
      }
      expect(rig.bee.streams).toHaveLength(1);
      expect(messagesIn(rig, IDLE)).toEqual([]);

      // Then nothing at all.
      await vi.waitFor(() => expect(rig.bee.streams.length).toBeGreaterThanOrEqual(2), { interval: 10 });
      expect(first.closed).toBe(true);
      const calls = rig.bee.changedCalls.length;
      rig.bee.lastStream.push({ type: "connected" });
      await vi.waitFor(() => expect(rig.bee.changedCalls.length).toBeGreaterThan(calls));

      await rig.listener.stop();
      await running;
      // One info line per reopening, and no warning: nothing went wrong.
      const reopened = messagesIn(rig, IDLE);
      expect(reopened).toHaveLength(rig.bee.streams.length - 1);
      expect(reopened[0]?.level).toBe("info");
      expect(reopened[0]?.idleMs).toBeGreaterThanOrEqual(190);
      expect(rig.logs().filter((line) => line.level === "warn" || line.level === "error")).toEqual([]);
    });

    it("can be switched off", async () => {
      const { rig } = startedRig({ options: { streamIdleReopenMs: 0 } });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      await pause(60);
      expect(rig.bee.streams).toHaveLength(1);
      expect(rig.bee.lastStream.closed).toBe(false);
    });
  });

  it("waits longer between restarts while streams keep dying, and starts over after one that lasted", async () => {
    const rig = makeRig({ options: { ...FAST, reconnectDelaysMs: [20, 80, 160], streamHealthyMs: 100 } });
    started.push(rig);
    // The first four streams die the moment they are opened.
    const open = rig.bee.stream.bind(rig.bee);
    let dieAtOnce = 4;
    const openedAt: number[] = [];
    rig.bee.stream = (onEvent) => {
      const stream = open(onEvent) as FakeStream;
      openedAt.push(performance.now());
      if (dieAtOnce > 0) {
        dieAtOnce -= 1;
        stream.end({ reason: "error" });
      }
      return stream;
    };
    const waits = () => messagesIn(rig, "Bee stream ended; opening a new one").map((line) => line.retryInMs);
    void rig.listener.start();

    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(5), { interval: 10 });
    expect(waits()).toEqual([20, 80, 160, 160]);
    // The waits were really made, not just logged.
    const gaps = openedAt.slice(1).map((at, index) => at - (openedAt[index] ?? 0));
    for (const [index, least] of [19, 79, 159, 159].entries()) expect(gaps[index]).toBeGreaterThanOrEqual(least);

    // The fifth stream lives longer than a healthy stream needs to. When it ends, the waits start over.
    await pause(200);
    rig.bee.lastStream.end({ reason: "ended" });
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(6), { interval: 10 });
    expect(waits()).toEqual([20, 80, 160, 160, 20]);
  });

  describe("when Bee is logged out", () => {
    it("says how to log in, keeps checking, and starts listening once logged in", async () => {
      const rig = makeRig({ options: FAST });
      started.push(rig);
      rig.bee.loginStates.push("logged-out", "logged-out", "logged-in");
      // A conversation left over from before, already quiet. It must wait for the login too.
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(ideaVerdict());
      void rig.listener.start();

      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      expect(rig.bee.loginCalls).toBe(3);
      const errors = errorsIn(rig);
      expect(errors).toHaveLength(2);
      expect(errors[0]?.message).toContain("Bee is logged out");
      expect(errors[0]?.message).toContain("node spikes/00-bee-login.ts");
      // Once logged in, the waiting conversation is handled and asked about on the first try.
      await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]));
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("runs no pass and opens no stream while it stays logged out, and still stops at once", async () => {
      const rig = makeRig({ options: FAST });
      started.push(rig);
      rig.bee.loginStates.push(...Array.from({ length: 1000 }, () => "logged-out" as const));
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      let done = false;
      const running = rig.listener.start().then(() => {
        done = true;
      });

      await vi.waitFor(() => expect(rig.bee.loginCalls).toBeGreaterThanOrEqual(3));
      expect(rig.bee.streams).toHaveLength(0);
      expect(rig.detector.inputs).toHaveLength(0);
      expect(done).toBe(false); // it does not exit: launchd would only start it again

      await rig.listener.stop();
      await running;
      expect(done).toBe(true);
    });

    it("carries on when the login state cannot be read", async () => {
      const rig = makeRig({ options: FAST });
      started.push(rig);
      rig.bee.loginStates.push("unknown", new BeeError("timeout", "bee me took longer than 15 s"));
      void rig.listener.start();
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      rig.bee.lastStream.end();
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      expect(errorsIn(rig)).toEqual([]);
    });

    it("goes back to waiting for a login when Bee refuses a to-do as logged out, and asks once logged in", async () => {
      const { rig } = startedRig({ options: { loginRecheckMs: 30 } });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      const first = rig.bee.lastStream;
      // From here Bee is logged out: the to-do is refused, and the next two login checks agree.
      rig.bee.createErrors.push(new BeeError("logged-out", "Bee is not logged in"));
      rig.bee.loginStates.push("logged-out", "logged-out", "logged-in");
      IDEA_LINES.forEach((text, index) => first.push({ type: "utterance", beeUtteranceId: 7000 + index, conversationUuid: "conv-a", text, spokenAt: rig.clock.iso() }));
      rig.detector.script.push(ideaVerdict());
      rig.clock.advance(rig.options.quietMs);

      // The pass that was told hands over to the stream loop: the stream is dropped, and the
      // instruction to log in is repeated at each login check, not on every pass.
      await vi.waitFor(() => expect(first.closed).toBe(true));
      expect(rig.store.listIdeas()[0]).toMatchObject({ state: "heard", note: "Bee is logged out; will ask once it is logged in again" });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      expect(rig.bee.loginCalls).toBe(4);
      expect(errorsIn(rig).map((line) => line.message.slice(0, 17))).toEqual(["Bee is logged out", "Bee is logged out"]);
      // No pass ran while logged out, so the to-do was not tried again.
      expect(rig.bee.createCalls).toHaveLength(1);

      // Logged in again, and the next try is due: asked, with all three tries still unused.
      rig.clock.advance(rig.options.loginRecheckMs);
      await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]));
      expect(rig.bee.createCalls).toHaveLength(2);
    });

    it("goes back to waiting for a login when an answer cannot be read because Bee is logged out", async () => {
      // A long wait before the stream is reopened, to see what happens in between.
      const rig = makeRig({ options: { ...FAST, loginRecheckMs: 30, reconnectDelaysMs: [300] } });
      started.push(rig);
      await hearAndDetect(rig, ideaVerdict());
      const todoId = rig.store.listIdeas()[0]!.todoId!;
      // The to-do was ticked, but the first time we look Bee says we are logged out.
      rig.bee.todos.set(todoId, "completed");
      vi.spyOn(rig.bee, "todoStatus").mockRejectedValueOnce(new BeeError("logged-out", "Bee is not logged in"));
      rig.bee.loginStates.push("logged-in", "logged-out", "logged-in");
      void rig.listener.start();

      // The pass that was told drops the stream, and from that moment no pass runs: a second
      // look would find the tick, and it does not happen until the login has been checked.
      await vi.waitFor(() => expect(rig.bee.streams[0]?.closed).toBe(true), { interval: 5 });
      await pause(60);
      expect(rig.store.listIdeas()[0]?.state).toBe("asked");
      expect(rig.bee.loginCalls).toBe(1);

      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      // Said once by the pass, then once by the login check. Not once per pass.
      expect(errorsIn(rig).map((line) => line.message.slice(0, 43))).toEqual(["Bee is logged out, so answers cannot be rea", "Bee is logged out, so nothing can be heard "]);
      await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["approved"]));
    });

    it("checks the login again before reopening a stream that died", async () => {
      const { rig } = startedRig();
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      rig.bee.loginStates.push("logged-out", "logged-in");
      rig.bee.lastStream.end({ reason: "error" });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
      expect(rig.bee.loginCalls).toBe(3);
      expect(errorsIn(rig)).toHaveLength(1);
    });
  });

  it("gives the same run to a second start(), and can be started again after a stop", async () => {
    const rig = makeRig({ options: FAST });
    started.push(rig);
    const one = rig.listener.start();
    const two = rig.listener.start();
    expect(two).toBe(one);
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    await Promise.all([rig.listener.stop(), rig.listener.stop()]);
    await one;

    void rig.listener.start();
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(2));
  });

  it("shuts everything down and rejects if the run loop itself breaks", async () => {
    const rig = makeRig({ options: FAST });
    // The one thing the loops cannot guard against in a test: the clock they were given.
    let clockBroken = false;
    const listener = createListener({
      store: rig.store,
      bee: rig.bee,
      detector: rig.detector,
      config: rig.config,
      logger: rig.ctx.logger,
      options: FAST,
      now: () => {
        if (clockBroken) throw new Error("the clock fell off the wall");
        return rig.clock.now();
      },
    });
    const outcome = listener.start().then(
      () => "resolved",
      (error: unknown) => `rejected: ${String(error)}`,
    );
    await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
    clockBroken = true;
    // The stream loop reads the clock when a stream ends, to note since when lines are missing.
    rig.bee.lastStream.end({ reason: "ended" });

    expect(await outcome).toBe("rejected: Error: the clock fell off the wall");
    // With no clock, more than one thing complains. What matters is that the break was reported.
    expect(errorsIn(rig).map((line) => line.message)).toContain("the stream loop broke; shutting down");
    expect(rig.logs().at(-1)).toMatchObject({ message: "listener stopped", clean: false });
    await expect(listener.stop()).resolves.toBeUndefined();

    // The other loop went down with it: no new stream, and no pass picks up a quiet conversation.
    clockBroken = false;
    for (const line of IDEA_LINES) rig.hear(line);
    rig.clock.advance(rig.options.quietMs);
    await pause(40);
    expect(rig.bee.streams).toHaveLength(1);
    expect(rig.detector.inputs).toHaveLength(0);
  });

  it("is safe to stop before it was ever started", async () => {
    const rig = makeRig({ options: FAST });
    await expect(rig.listener.stop()).resolves.toBeUndefined();
  });

  describe("stopping while a pass is in progress", () => {
    it("waits for the pass before start() resolves", async () => {
      const { rig, running, isDone } = startedRig();
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      const detector = slowDetector(rig);
      await vi.waitFor(() => expect(rig.detector.inputs).toHaveLength(1));

      const stopped = rig.listener.stop();
      await pause(20);
      expect(isDone()).toBe(false);
      detector.finish();
      await stopped;
      await running;
      // The pass was allowed to finish its work.
      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]);
      expect(rig.logs().at(-1)).toMatchObject({ message: "listener stopped", clean: true, waitedForWork: true });
    });

    it("but only for the grace time: then it stops anyway, and the lines stay pending", async () => {
      const { rig, running, isDone } = startedRig({ options: { stopGraceMs: 60 } });
      for (const line of IDEA_LINES) rig.hear(line);
      rig.clock.advance(rig.options.quietMs);
      const detector = slowDetector(rig);
      await vi.waitFor(() => expect(rig.detector.inputs).toHaveLength(1));

      const began = performance.now();
      await rig.listener.stop();
      const took = performance.now() - began;
      expect(took).toBeGreaterThanOrEqual(55);
      expect(took).toBeLessThan(1000);
      await running;
      expect(isDone()).toBe(true);
      expect(rig.bee.lastStream.closed).toBe(true);
      expect(rig.logs().slice(-2)).toMatchObject([
        { level: "warn", message: "stopping although a pass was still running; what it was working on stays pending for the next start", waitedMs: 60 },
        { level: "info", message: "listener stopped", clean: true, waitedForWork: false },
      ]);

      // The detector answers after all. Too late: whoever ran us may have closed the store by
      // now, so it is not touched, nothing is recorded and nobody is asked.
      const writes = [vi.spyOn(rig.store, "recordDetectorRun"), vi.spyOn(rig.store, "createIdea"), vi.spyOn(rig.store, "pendingUtterances")];
      detector.finish();
      await pause(30);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      for (const write of writes) write.mockRestore();
      expect(rig.store.countDetectorRuns()).toBe(0);
      expect(rig.store.listIdeas()).toEqual([]);
      expect(rig.bee.createCalls).toEqual([]);
      expect(rig.store.conversationsAwaitingDetection()).toHaveLength(1);
      expect(errorsIn(rig)).toEqual([]);

      // Nothing was lost, and no try was used up: the next start reads the same lines.
      Reflect.deleteProperty(rig.detector, "detect");
      rig.detector.script.push(ideaVerdict());
      void rig.listener.start();
      await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked"]));
      expect(rig.detector.textsOf(1)).toEqual(IDEA_LINES);
    });

    it("drops an answer that Bee gives only after the grace time, and reads it at the next start", async () => {
      const rig = makeRig({ options: { ...FAST, stopGraceMs: 60 } });
      started.push(rig);
      await hearAndDetect(rig, ideaVerdict());
      const todoId = rig.store.listIdeas()[0]!.todoId!;
      rig.bee.todos.set(todoId, "completed");
      // Bee is slow to say what became of the to-do.
      const status = rig.bee.todoStatus.bind(rig.bee);
      let calls = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      rig.bee.todoStatus = async (id) => {
        calls += 1;
        await held;
        return status(id);
      };
      const running = rig.listener.start();
      await vi.waitFor(() => expect(calls).toBe(1));

      await rig.listener.stop();
      await running;
      expect(rig.logs().at(-1)).toMatchObject({ message: "listener stopped", waitedForWork: false });
      // The answer arrives now. The store may be closed by this time, so it is not touched.
      const reads = vi.spyOn(rig.store, "getIdea");
      release();
      await pause(30);
      expect(reads).not.toHaveBeenCalled();
      expect(rig.store.listIdeas()[0]?.state).toBe("asked");
      expect(errorsIn(rig)).toEqual([]);

      rig.bee.todoStatus = status;
      void rig.listener.start();
      await vi.waitFor(() => expect(rig.store.listIdeas()[0]?.state).toBe("approved"));
    });

    it("ends the approval pass between two asks", async () => {
      const rig = makeRig({ options: FAST });
      started.push(rig);
      await hearAndDetect(rig, ideaVerdict({ title: "Chore wheel" }), "conv-a");
      await hearAndDetect(rig, ideaVerdict({ title: "Parking spot swap board" }), "conv-b");
      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked", "asked"]);
      // Bee is slow to say what became of the first to-do.
      const status = rig.bee.todoStatus.bind(rig.bee);
      let calls = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      rig.bee.todoStatus = async (id) => {
        calls += 1;
        await held;
        return status(id);
      };
      const running = rig.listener.start();
      await vi.waitFor(() => expect(calls).toBe(1));

      const stopped = rig.listener.stop();
      await pause(20);
      release();
      await stopped;
      await running;
      // The check that was under way finished. The second ask was left for the next start.
      expect(calls).toBe(1);
      expect(rig.bee.statusCalls).toHaveLength(1);
    });

    it("starts no further to-do once it has been asked to stop", async () => {
      const rig = makeRig({ options: FAST, start: "2026-10-10T05:30:00.000Z" }); // 11:30 pm in Boise
      started.push(rig);
      // Two ideas heard in the night, both waiting for the morning.
      await hearAndDetect(rig, ideaVerdict({ title: "Chore wheel" }), "conv-a");
      await hearAndDetect(rig, ideaVerdict({ title: "Parking spot swap board" }), "conv-b");
      rig.clock.set("2026-10-10T13:00:00.000Z"); // 7 am
      // Bee takes its time over the first to-do of the morning.
      const create = rig.bee.createTodo.bind(rig.bee);
      let calls = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      rig.bee.createTodo = async (text, alarmAt) => {
        calls += 1;
        await held;
        return create(text, alarmAt);
      };
      const running = rig.listener.start();
      await vi.waitFor(() => expect(calls).toBe(1));

      const stopped = rig.listener.stop();
      await pause(20);
      release();
      await stopped;
      await running;

      // The to-do that was under way is finished and saved. The second idea was not begun: it
      // keeps its place in the queue for the next start.
      expect(calls).toBe(1);
      expect(rig.store.listIdeas().map((idea) => [idea.title, idea.state, idea.todoId, idea.note])).toEqual([
        ["Chore wheel", "asked", 9001, null],
        ["Parking spot swap board", "heard", null, "heard during quiet hours; will ask after 07:00"],
      ]);

      void rig.listener.start();
      await vi.waitFor(() => expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked", "asked"]));
    });

    it("ends a backfill between two conversations", async () => {
      const { rig, running } = startedRig();
      rig.store.setValue(CURSOR_KEY, "cursor-1", T0);
      rig.bee.changedReplies.push({ nextCursor: "cursor-2", conversationIds: [4100, 4700] });
      // Bee is slow with the first transcript.
      const fetch = rig.bee.transcriptSince.bind(rig.bee);
      let calls = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      rig.bee.transcriptSince = async (id, sinceMs) => {
        calls += 1;
        await held;
        return fetch(id, sinceMs);
      };
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      rig.bee.lastStream.push({ type: "connected" });
      await vi.waitFor(() => expect(calls).toBe(1));

      const stopped = rig.listener.stop();
      await pause(20);
      release();
      await stopped;
      await running;
      // The second conversation was not fetched, and the cursor stays, so the next start does it all.
      expect(calls).toBe(1);
      expect(rig.store.getValue(CURSOR_KEY)).toBe("cursor-1");
    });

    it("does not wait for ever for work that an event started either", async () => {
      const rig = makeRig({ options: { stopGraceMs: 40 } });
      await hearAndDetect(rig, ideaVerdict());
      const todoId = rig.store.listIdeas()[0]!.todoId!;
      // Bee never answers the question the event raises.
      rig.bee.todoStatus = () => new Promise(() => {});
      rig.listener.handleEvent({ type: "todo-deleted", todoId });

      const began = performance.now();
      await rig.listener.stop();
      expect(performance.now() - began).toBeGreaterThanOrEqual(35);
      expect(messagesIn(rig, "stopping although work started by a Bee event was still running")).toHaveLength(1);
      expect(rig.store.listIdeas()[0]?.state).toBe("asked");
    });
  });

  it("stops on SIGTERM and on SIGINT, but listens for them only when asked to and only while running", async () => {
    const counts = () => [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    const before = counts();
    /** Hand a signal to the listeners added since `known`, as the process would. The test runner has listeners of its own. */
    const deliver = (name: "SIGTERM" | "SIGINT", known: unknown[]) => {
      for (const listener of process.rawListeners(name)) if (!known.includes(listener)) (listener as (signal: NodeJS.Signals) => void).call(process, name);
    };

    const plain = startedRig();
    await vi.waitFor(() => expect(plain.rig.bee.streams).toHaveLength(1));
    expect(counts()).toEqual(before);
    await plain.rig.listener.stop();

    for (const name of ["SIGTERM", "SIGINT"] as const) {
      const known = process.rawListeners(name);
      const { rig, running, isDone } = startedRig({ options: { handleSignals: true } });
      await vi.waitFor(() => expect(rig.bee.streams).toHaveLength(1));
      expect(counts()).toEqual(before.map((count) => count + 1));

      deliver(name, known);
      await running;
      expect(isDone()).toBe(true);
      expect(rig.bee.lastStream.closed).toBe(true);
      expect(messagesIn(rig, "stop signal received")).toMatchObject([{ signal: name }]);
      expect(rig.logs().at(-1)).toMatchObject({ message: "listener stopped", clean: true });
      expect(counts()).toEqual(before);
    }
  });

  it("holds the Mac awake while it runs when asked to, and lets go when it stops", async () => {
    // Nothing here starts a real program: the spawn function is a fake.
    const spawned: Array<{ command: string; args: string[] }> = [];
    let kills = 0;
    const spawnKeepAwake: SpawnKeepAwake = (command, args) => {
      spawned.push({ command, args });
      const child = {
        on: () => child,
        kill: () => {
          kills += 1;
          return true;
        },
      };
      return child;
    };

    const asked = startedRig({ options: { keepAwake: true }, spawnKeepAwake });
    await vi.waitFor(() => expect(asked.rig.bee.streams).toHaveLength(1));
    // Tied to our own process, so the helper goes away by itself if we die.
    expect(spawned).toEqual([{ command: "/usr/bin/caffeinate", args: ["-s", "-w", String(process.pid)] }]);
    expect(kills).toBe(0);
    await asked.rig.listener.stop();
    await asked.running;
    expect(kills).toBe(1);

    const notAsked = startedRig({ spawnKeepAwake });
    await vi.waitFor(() => expect(notAsked.rig.bee.streams).toHaveLength(1));
    await notAsked.rig.listener.stop();
    expect(spawned).toHaveLength(1);
    expect(kills).toBe(1);
  });
});
