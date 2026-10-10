// Synthetic test data: all text in this file is made up for the tests. None of it is Bee data.
import { BeeError } from "@overnight/core";
import { gateVerdict } from "@overnight/detector";
import { describe, expect, it, vi } from "vitest";
import { askExpiresAt } from "../src/index.ts";
import { hearAndDetect, HOUR, IDEA_LINES, ideaVerdict, makeRig, MINUTE, notIdeaVerdict, SECOND, T0, testConfig } from "./helpers.ts";
import type { Rig } from "./helpers.ts";

/** Bee refused: nothing was created, so trying again is safe. */
const refused = () => new BeeError("failed", "bee exited with code 1");
const byTitle = (rig: Rig, title: string) => rig.store.listIdeas().find((idea) => idea.title === title);

const onlyIdea = (rig: Rig) => {
  const ideas = rig.store.listIdeas();
  expect(ideas).toHaveLength(1);
  return ideas[0]!;
};

describe("asking on the wrist", () => {
  it("creates the idea as heard, then asks with a to-do and a two-minute alarm", async () => {
    const rig = makeRig();
    const verdict = ideaVerdict();
    await hearAndDetect(rig, verdict);
    const askedAt = rig.clock.iso();

    expect(rig.bee.createCalls).toEqual([{ text: "💡 Build tonight? Whose turn to pay", alarmAt: new Date(Date.parse(askedAt) + 2 * MINUTE) }]);
    const idea = onlyIdea(rig);
    expect(idea).toMatchObject({
      state: "asked",
      title: "Whose turn to pay",
      pitch: verdict.pitch,
      quote: verdict.quote,
      confidence: 0.9,
      todoId: 9001,
      askedAt,
      // 2:02 pm in Boise, so tonight's 11 pm cutoff.
      askExpiresAt: "2026-10-10T05:00:00.000Z",
      answeredAt: null,
      note: null,
    });
    expect(idea.detectorRunId).toBeGreaterThan(0);
    expect(rig.store.countDetectorRuns("idea")).toBe(1);
    expect(rig.store.ideaEvents(idea.id).map((event) => [event.fromState, event.toState])).toEqual([
      [null, "heard"],
      ["heard", "asked"],
    ]);
  });

  it("makes no idea at all when the detector says it is not one", async () => {
    const rig = makeRig();
    await hearAndDetect(rig, notIdeaVerdict());
    expect(rig.store.listIdeas()).toEqual([]);
    expect(rig.bee.createCalls).toEqual([]);
  });

  describe("reasons not to ask (the idea stays heard, with a note)", () => {
    const gated = [
      ["low confidence", ideaVerdict({ confidence: 0.6 })],
      ["sounds like TV or a podcast", ideaVerdict({ likely_media: true })],
      ["needs more than a static web app", ideaVerdict({ buildable_as_static_web_app: false })],
    ] as const;

    it.each(gated)("%s", async (_name, verdict) => {
      const rig = makeRig();
      await hearAndDetect(rig, verdict);
      const gate = gateVerdict(verdict);
      expect(gate.pass).toBe(false);
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", todoId: null, note: gate.pass ? null : gate.reason });
      expect(rig.bee.createCalls).toEqual([]);
    });

    it("a title like one already asked about", async () => {
      const rig = makeRig();
      await hearAndDetect(rig, ideaVerdict(), "conv-a");
      rig.clock.advance(3 * HOUR);
      await hearAndDetect(rig, ideaVerdict(), "conv-b");

      const [first, second] = rig.store.listIdeas();
      expect(first).toMatchObject({ state: "asked" });
      expect(second).toMatchObject({ state: "heard", note: "already asked about something like this recently" });
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("but a title like one that was only heard is asked about", async () => {
      const rig = makeRig();
      // Heard while paused, so never asked.
      rig.store.setPaused(true, rig.clock.iso());
      await hearAndDetect(rig, ideaVerdict(), "conv-a");
      rig.store.setPaused(false, rig.clock.iso());
      rig.clock.advance(3 * HOUR);
      await hearAndDetect(rig, ideaVerdict(), "conv-b");

      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["heard", "asked"]);
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("an asked idea stops counting as a repeat after 14 days", async () => {
      const rig = makeRig();
      await hearAndDetect(rig, ideaVerdict(), "conv-a");
      rig.clock.advance(15 * 24 * HOUR);
      await hearAndDetect(rig, ideaVerdict(), "conv-b");
      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked", "asked"]);
    });

    it("paused", async () => {
      const rig = makeRig();
      rig.store.setPaused(true, rig.clock.iso());
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "paused: listening only" });
      expect(rig.bee.createCalls).toEqual([]);
    });

    it("paused by the PAUSED setting, until someone resumes", async () => {
      const rig = makeRig({ env: { PAUSED: "true" } });
      await hearAndDetect(rig, ideaVerdict({ title: "Chore wheel" }), "conv-a");
      rig.store.setPaused(false, rig.clock.iso());
      await hearAndDetect(rig, ideaVerdict({ title: "Parking spot swap board" }), "conv-b");
      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["heard", "asked"]);
    });

    it("the daily limit, which starts again on the next local day", async () => {
      const rig = makeRig();
      const titles = ["Chore wheel", "Parking spot swap board", "Library due dates", "Cabin cost splitter", "Carpool rota", "Recipe scaler"];
      const hearNext = async (index: number) => {
        await hearAndDetect(rig, ideaVerdict({ title: titles[index]! }), `conv-${index}`);
        return rig.store.listIdeas().find((idea) => idea.title === titles[index])!;
      };

      for (const index of [0, 1, 2]) expect((await hearNext(index)).state).toBe("asked");
      expect(await hearNext(3)).toMatchObject({ state: "heard", note: "already asked 3 times today" });

      // 11:30 pm in Boise is already Oct 10 in UTC, but still the same day where the wearer lives.
      rig.clock.set("2026-10-10T05:30:00.000Z");
      expect(await hearNext(4)).toMatchObject({ state: "heard", note: "already asked 3 times today" });

      // Half past seven the next morning in Boise: a new day, and quiet hours are over.
      rig.clock.set("2026-10-10T13:30:00.000Z");
      expect((await hearNext(5)).state).toBe("asked");
      expect(rig.bee.createCalls).toHaveLength(4);
    });

    it("a daily limit of zero", async () => {
      const rig = makeRig({ env: { MAX_ASKS_PER_DAY: "0" } });
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "asking is switched off (the daily limit is 0)" });
    });

    it("no title to ask with", async () => {
      const rig = makeRig();
      await hearAndDetect(rig, ideaVerdict({ title: "   " }));
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "the detector gave no title" });
      expect(rig.bee.createCalls).toEqual([]);
    });

    it("gives the most lasting reason when several apply", async () => {
      const rig = makeRig({ env: { MAX_ASKS_PER_DAY: "0" } });
      rig.store.setPaused(true, rig.clock.iso());
      const verdict = ideaVerdict({ likely_media: true });
      await hearAndDetect(rig, verdict);
      const gate = gateVerdict(verdict);
      expect(onlyIdea(rig).note).toBe(gate.pass ? null : gate.reason);
    });
  });

  describe("when Bee refuses to create the to-do", () => {
    it("leaves the idea heard with a note, and tries again a minute later", async () => {
      const rig = makeRig();
      rig.bee.createErrors.push(refused());
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", todoId: null, note: "could not create the Bee to-do: failed" });

      // Not on the very next pass: whatever was wrong gets a minute to clear.
      rig.clock.advance(10 * SECOND);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);

      rig.clock.advance(rig.options.retryDelayMs - 10 * SECOND);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001, note: null, askedAt: rig.clock.iso() });
      expect(rig.bee.createCalls).toHaveLength(2);
      // The alarm is two minutes from the try that worked, not from the first one.
      expect(rig.bee.createCalls[1]?.alarmAt).toEqual(new Date(Date.parse(rig.clock.iso()) + 2 * MINUTE));

      // Asked now: later passes make no second to-do.
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(rig.bee.created).toEqual([9001]);
      expect(rig.bee.createCalls).toHaveLength(2);
      expect(rig.detector.inputs).toHaveLength(1);
    });

    it("gives up after three tries in total", async () => {
      const rig = makeRig();
      rig.bee.createErrors.push(refused(), refused(), refused());
      const nextTry = async () => {
        rig.clock.advance(rig.options.retryDelayMs);
        await rig.listener.runDetectionPass();
      };
      await hearAndDetect(rig, ideaVerdict());
      await nextTry();
      await nextTry();
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "could not create the Bee to-do: failed" });

      // Bee works again, but the three tries are used up.
      await nextTry();
      await nextTry();
      expect(rig.bee.createCalls).toHaveLength(3);
      expect(rig.bee.created).toEqual([]);
    });

    it("checks the pause flag again before each new try", async () => {
      const rig = makeRig();
      rig.bee.createErrors.push(refused());
      await hearAndDetect(rig, ideaVerdict());
      rig.store.setPaused(true, rig.clock.iso());
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "paused: listening only" });

      // Paused means "do not ask", not "ask later": resuming does not bring the try back.
      rig.store.setPaused(false, rig.clock.iso());
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("checks the daily limit again before each new try", async () => {
      const rig = makeRig({ env: { MAX_ASKS_PER_DAY: "1" } });
      rig.bee.createErrors.push(refused());
      await hearAndDetect(rig, ideaVerdict({ title: "Chore wheel" }), "conv-a");
      // Before the retry, another idea takes today's only ask.
      rig.clock.advance(SECOND);
      rig.hear("i wish there was a page that swapped parking spots at work", "conv-b");
      rig.clock.advance(rig.options.quietMs);
      rig.detector.script.push(ideaVerdict({ title: "Parking spot swap board" }));
      vi.spyOn(rig.bee, "createTodo").mockRejectedValueOnce(refused());
      await rig.listener.runDetectionPass();

      // Pass 2 retried the first idea (refused again) and then asked about the second.
      expect(byTitle(rig, "Parking spot swap board")?.state).toBe("asked");
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(byTitle(rig, "Chore wheel")).toMatchObject({ state: "heard", note: "already asked 1 time today" });
      expect(rig.bee.created).toHaveLength(1);
    });
  });

  describe("when Bee is logged out as the to-do is created", () => {
    const loggedOut = () => new BeeError("logged-out", "Bee is not logged in");

    it("does not use up the idea's tries, and asks once Bee is logged in again", async () => {
      const rig = makeRig();
      // Logged out for longer than the three tries an idea gets. Then logged in, but Bee refuses
      // twice more for another reason: those are the idea's first two real tries, so a third is left.
      rig.bee.createErrors.push(loggedOut(), loggedOut(), loggedOut(), loggedOut(), refused(), refused());
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", todoId: null, note: "Bee is logged out; will ask once it is logged in again" });

      // Not before the next login check is due.
      rig.clock.advance(rig.options.loginRecheckMs - SECOND);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);

      for (let pass = 0; pass < 3; pass += 1) {
        rig.clock.advance(rig.options.loginRecheckMs);
        await rig.listener.runDetectionPass();
      }
      expect(rig.bee.createCalls).toHaveLength(4);
      expect(onlyIdea(rig).state).toBe("heard");

      for (let pass = 0; pass < 2; pass += 1) {
        rig.clock.advance(rig.options.retryDelayMs);
        await rig.listener.runDetectionPass();
      }
      expect(rig.bee.createCalls).toHaveLength(6);
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "could not create the Bee to-do: failed" });

      // The seventh call is the third real try, and it works.
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001, note: null });
      expect(rig.bee.created).toEqual([9001]);
    });

    it("stops waiting once the idea is twelve hours old", async () => {
      const rig = makeRig({ start: "2026-10-09T13:30:00.000Z" }); // 7:30 am, so the whole wait is outside quiet hours
      rig.bee.createErrors.push(loggedOut(), loggedOut());
      await hearAndDetect(rig, ideaVerdict());
      rig.clock.advance(11 * HOUR);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(2);

      rig.clock.advance(HOUR);
      await rig.listener.runDetectionPass();
      rig.clock.advance(HOUR);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(2);
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "waited more than 12 hours to be asked, so it was not asked" });
    });
  });

  describe("when Bee may have created the to-do but its reply was lost", () => {
    const lost = [
      ["no reply in time", "timeout", new BeeError("timeout", "bee todos create took longer than 30 s")],
      ["a reply that could not be read", "bad-response", new BeeError("bad-response", "bee todos create printed something unexpected")],
      ["a kind the contract does not call safe", "not-found", new BeeError("not-found", "Todo not found.")],
      ["an error that is not from Bee", "unexpected", new Error("something else broke")],
    ] as const;

    it.each(lost)("%s: never asks a second time, and counts it as the ask", async (_name, kind, error) => {
      const rig = makeRig();
      rig.bee.lostReplies.push(error);
      await hearAndDetect(rig, ideaVerdict());
      const askedAt = rig.clock.iso();

      const idea = onlyIdea(rig);
      expect(idea).toMatchObject({
        state: "asked",
        todoId: null,
        askedAt,
        askExpiresAt: "2026-10-10T05:00:00.000Z",
        note: `asked in Bee, but its reply was lost (${kind}), so the answer cannot be tracked`,
      });
      expect(rig.logs().find((line) => line.level === "warn")).toMatchObject({ message: "the ask to-do may exist, but Bee's reply was lost; not asking again", ideaId: idea.id, kind });

      // However many passes follow, Bee is not asked to make another.
      for (let pass = 0; pass < 4; pass += 1) {
        rig.clock.advance(rig.options.retryDelayMs);
        await rig.listener.runDetectionPass();
        await rig.listener.runApprovalPass();
      }
      expect(rig.bee.createCalls).toHaveLength(1);
      expect(rig.bee.created).toEqual([9001]);
      // With no id there is nothing to look up. All this ask can do is run out at the cutoff.
      expect(rig.bee.statusCalls).toEqual([]);
      rig.clock.set("2026-10-10T05:00:00.000Z");
      await rig.listener.runApprovalPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "expired", note: "no answer by the cutoff" });
      expect(rig.bee.statusCalls).toEqual([]);
    });

    it("still keeps to three asks a day when every reply is lost", async () => {
      const rig = makeRig();
      const titles = ["Chore wheel", "Parking spot swap board", "Library due dates", "Cabin cost splitter", "Carpool rota", "Recipe scaler"];
      for (const [index, title] of titles.entries()) {
        rig.bee.lostReplies.push(new BeeError(index % 2 === 0 ? "timeout" : "bad-response", "the reply was lost"));
        await hearAndDetect(rig, ideaVerdict({ title }), `conv-${index}`);
        // A few passes a minute apart, as the run loop would make.
        for (let pass = 0; pass < 3; pass += 1) {
          rig.clock.advance(rig.options.retryDelayMs);
          await rig.listener.runDetectionPass();
        }
      }

      expect(rig.bee.created).toHaveLength(3);
      expect(rig.bee.createCalls).toHaveLength(3);
      expect(rig.store.listIdeas().map((idea) => idea.state)).toEqual(["asked", "asked", "asked", "heard", "heard", "heard"]);
      expect(byTitle(rig, "Cabin cost splitter")?.note).toBe("already asked 3 times today");
    });
  });

  describe("when the listener is stopped while Bee is still creating the to-do", () => {
    const CUT_OFF = "asked in Bee, but the listener stopped before the reply came, so the answer cannot be tracked";

    /** Bee makes the to-do but never answers, as when the stop grace runs out mid-call. */
    const neverReplies = (rig: Rig) => {
      rig.bee.createTodo = (text, alarmAt) => {
        rig.bee.createCalls.push({ text, alarmAt });
        rig.bee.created.push(9001);
        return new Promise(() => {});
      };
    };

    it("leaves a mark on the idea before Bee is called, and no outcome keeps it", async () => {
      const rig = makeRig();
      let noteDuringCall: string | null | undefined;
      const real = rig.bee.createTodo.bind(rig.bee);
      rig.bee.createTodo = (text, alarmAt) => {
        noteDuringCall = onlyIdea(rig).note;
        return real(text, alarmAt);
      };
      await hearAndDetect(rig, ideaVerdict());
      expect(noteDuringCall).toBe("asking in Bee now");
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", note: null });
    });

    it("an idea that was waiting for the morning: no second to-do after the restart", async () => {
      const night = makeRig({ start: "2026-10-10T05:30:00.000Z" }); // 11:30 pm
      await hearAndDetect(night, ideaVerdict());
      expect(onlyIdea(night).note).toBe("heard during quiet hours; will ask after 07:00");

      // 7 am: the ask starts, Bee is slow, and the listener is stopped before the reply.
      night.clock.set("2026-10-10T13:00:00.000Z");
      neverReplies(night);
      void night.listener.runDetectionPass();
      await vi.waitFor(() => expect(night.bee.createCalls).toHaveLength(1));
      expect(onlyIdea(night)).toMatchObject({ state: "heard", note: "asking in Bee now" });

      // A new listener on the same data.
      const restarted = makeRig({ store: night.store, start: "2026-10-10T13:01:00.000Z" });
      await restarted.listener.runDetectionPass();
      const idea = onlyIdea(restarted);
      expect(idea).toMatchObject({ state: "asked", todoId: null, askedAt: "2026-10-10T13:01:00.000Z", askExpiresAt: "2026-10-11T05:00:00.000Z", note: CUT_OFF });
      expect(restarted.logs().find((line) => line.level === "warn")).toMatchObject({ message: "an ask was cut off by a stop before Bee replied; not asking again", ideaId: idea.id });

      for (let pass = 0; pass < 3; pass += 1) {
        restarted.clock.advance(restarted.options.retryDelayMs);
        await restarted.listener.runDetectionPass();
        await restarted.listener.runApprovalPass();
      }
      expect(restarted.bee.createCalls).toEqual([]);
      expect(restarted.bee.statusCalls).toEqual([]);

      // With no id, all it can do is run out at the cutoff.
      restarted.clock.set("2026-10-11T05:00:00.000Z");
      await restarted.listener.runApprovalPass();
      expect(onlyIdea(restarted)).toMatchObject({ state: "expired", note: "no answer by the cutoff" });
    });

    it("a daytime idea: recorded as asked after the restart, and counted toward the daily limit", async () => {
      const first = makeRig({ env: { MAX_ASKS_PER_DAY: "1" } });
      neverReplies(first);
      void hearAndDetect(first, ideaVerdict());
      await vi.waitFor(() => expect(first.bee.createCalls).toHaveLength(1));
      expect(onlyIdea(first)).toMatchObject({ state: "heard", note: "asking in Bee now" });

      const restarted = makeRig({ store: first.store, start: "2026-10-09T20:10:00.000Z", env: { MAX_ASKS_PER_DAY: "1" } });
      await restarted.listener.runDetectionPass();
      expect(onlyIdea(restarted)).toMatchObject({ state: "asked", todoId: null, askedAt: "2026-10-09T20:10:00.000Z", askExpiresAt: "2026-10-10T05:00:00.000Z", note: CUT_OFF });
      expect(restarted.store.countAsksBetween("2026-10-09T06:00:00.000Z", "2026-10-10T06:00:00.000Z")).toBe(1);
      expect(restarted.bee.createCalls).toEqual([]);

      // It used up today's one ask.
      // (Line ids of its own: the new rig would otherwise reuse the first one's.)
      for (const [index, text] of IDEA_LINES.entries()) {
        restarted.listener.handleEvent({ type: "utterance", beeUtteranceId: 7000 + index, conversationUuid: "conv-b", text, spokenAt: restarted.clock.iso() });
      }
      restarted.clock.advance(restarted.options.quietMs);
      restarted.detector.script.push(ideaVerdict({ title: "Chore wheel" }));
      await restarted.listener.runDetectionPass();
      expect(byTitle(restarted, "Chore wheel")).toMatchObject({ state: "heard", note: "already asked 1 time today" });
      expect(restarted.bee.createCalls).toEqual([]);
    });

    it("does not ask when the mark cannot be left, and tries again later", async () => {
      const rig = makeRig();
      const noNotes = vi.spyOn(rig.store, "setIdeaNote").mockImplementation(() => {
        throw new Error("database is locked");
      });
      await hearAndDetect(rig, ideaVerdict());
      expect(rig.bee.createCalls).toEqual([]);
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: null });

      noNotes.mockRestore();
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001, note: null });
      expect(rig.bee.createCalls).toHaveLength(1);
    });
  });

  describe("when the to-do exists but the ask cannot be saved", () => {
    const storeIsBusy = (rig: Rig, times: number) => {
      const real = rig.store.transitionIdea.bind(rig.store);
      let left = times;
      return vi.spyOn(rig.store, "transitionIdea").mockImplementation((...args) => {
        if (left > 0) {
          left -= 1;
          throw new Error("database is locked");
        }
        return real(...args);
      });
    };

    it("never makes a second to-do, and saves the ask on a later pass", async () => {
      const rig = makeRig();
      storeIsBusy(rig, 2);
      await hearAndDetect(rig, ideaVerdict());
      const askedAt = rig.clock.iso();
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: "asked in Bee, but the ask could not be saved yet, so its answer is not tracked" });
      expect(rig.logs().find((line) => line.level === "error")).toMatchObject({ todoId: 9001, error: "database is locked" });

      // The next pass finds the store still busy. The one after that gets through.
      rig.clock.advance(10 * SECOND);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig).state).toBe("heard");
      rig.clock.advance(10 * SECOND);
      await rig.listener.runDetectionPass();

      // Saved as asked when the to-do was made, with the id Bee gave, and no second to-do.
      const idea = onlyIdea(rig);
      expect(idea).toMatchObject({ state: "asked", todoId: 9001, askedAt, askExpiresAt: "2026-10-10T05:00:00.000Z", note: null });
      expect(rig.store.ideaEvents(idea.id).at(-1)).toMatchObject({ toState: "asked", at: askedAt });
      expect(rig.bee.created).toEqual([9001]);
      expect(rig.bee.createCalls).toHaveLength(1);

      // And from here its answer is tracked like any other.
      rig.bee.todos.set(9001, "completed");
      await rig.listener.runApprovalPass();
      expect(onlyIdea(rig).state).toBe("approved");
    });

    it("counts the unsaved ask toward the daily limit", async () => {
      const rig = makeRig({ env: { MAX_ASKS_PER_DAY: "1" } });
      const busy = storeIsBusy(rig, 1000);
      await hearAndDetect(rig, ideaVerdict({ title: "Chore wheel" }), "conv-a");
      rig.clock.advance(MINUTE);
      await hearAndDetect(rig, ideaVerdict({ title: "Parking spot swap board" }), "conv-b");

      // Bee holds one ask, not two, although the store has not recorded any.
      expect(rig.bee.created).toEqual([9001]);
      expect(byTitle(rig, "Parking spot swap board")).toMatchObject({ state: "heard", note: "already asked 1 time today" });

      busy.mockRestore();
      rig.clock.advance(10 * SECOND);
      await rig.listener.runDetectionPass();
      expect(byTitle(rig, "Chore wheel")).toMatchObject({ state: "asked", todoId: 9001 });
      expect(rig.bee.created).toEqual([9001]);
    });

    it("treats the unsaved ask as asked when a similar idea comes up", async () => {
      const rig = makeRig();
      const busy = storeIsBusy(rig, 1000);
      await hearAndDetect(rig, ideaVerdict(), "conv-a");
      rig.clock.advance(MINUTE);
      await hearAndDetect(rig, ideaVerdict(), "conv-b");
      busy.mockRestore();

      expect(rig.bee.created).toEqual([9001]);
      expect(rig.store.listIdeas()[1]).toMatchObject({ state: "heard", note: "already asked about something like this recently" });
    });
  });

  describe("quiet hours (from the ask cutoff until the morning delivery)", () => {
    /** 11:30 pm in Boise on Oct 9. */
    const LATE = "2026-10-10T05:30:00.000Z";
    /** 7:00 am in Boise on Oct 10. */
    const MORNING = "2026-10-10T13:00:00.000Z";
    const WAITING = "heard during quiet hours; will ask after 07:00";

    it("asks nothing at night, and asks on the first pass after 7 am", async () => {
      const rig = makeRig({ start: LATE });
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", todoId: null, note: WAITING });
      expect(rig.logs().find((line) => line.message === "idea heard but not asked")).toMatchObject({ why: "quiet-hours" });

      // Passes go by all night and nothing is asked.
      for (const at of ["2026-10-10T06:30:00.000Z", "2026-10-10T10:00:00.000Z", "2026-10-10T12:59:59.000Z"]) {
        rig.clock.set(at);
        await rig.listener.runDetectionPass();
      }
      expect(rig.bee.createCalls).toEqual([]);
      expect(onlyIdea(rig).note).toBe(WAITING);
      // Decided once, when it was heard. The night's passes do not go over it again.
      expect(rig.logs().filter((line) => line.message === "idea heard but not asked")).toHaveLength(1);

      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toEqual([{ text: "💡 Build tonight? Whose turn to pay", alarmAt: new Date(Date.parse(MORNING) + 2 * MINUTE) }]);
      // Asked in the morning, so it runs until tonight's cutoff.
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001, askedAt: MORNING, askExpiresAt: "2026-10-11T05:00:00.000Z", note: null });

      // Once only.
      rig.clock.advance(MINUTE);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("starts when the alarm would ring at the cutoff itself and not a moment before", async () => {
      const before = makeRig({ start: "2026-10-10T04:55:59.999Z" }); // detected at 10:57:59.999 pm, alarm at 10:59:59.999 pm
      await hearAndDetect(before, ideaVerdict());
      expect(onlyIdea(before).state).toBe("asked");

      const at = makeRig({ start: "2026-10-10T04:56:00.000Z" }); // detected at 10:58:00.000 pm, alarm at 11:00:00.000 pm
      await hearAndDetect(at, ideaVerdict());
      expect(onlyIdea(at)).toMatchObject({ state: "heard", note: WAITING });
      expect(at.bee.createCalls).toEqual([]);
    });

    it("does not ask at 10:58:30 pm, when the alarm would ring after the cutoff, and asks after 7 am", async () => {
      const rig = makeRig({ start: "2026-10-10T04:56:30.000Z" }); // noticed at 10:58:30 pm; the alarm would ring at 11:00:30 pm
      await hearAndDetect(rig, ideaVerdict());
      expect(rig.clock.iso()).toBe("2026-10-10T04:58:30.000Z");
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", todoId: null, note: WAITING });

      // Passes in the last minutes before the cutoff, and through the night: decided once, not on every pass.
      for (const at of ["2026-10-10T04:58:40.000Z", "2026-10-10T04:59:50.000Z", "2026-10-10T05:00:00.000Z", "2026-10-10T10:00:00.000Z", "2026-10-10T12:59:59.000Z"]) {
        rig.clock.set(at);
        await rig.listener.runDetectionPass();
      }
      expect(rig.bee.createCalls).toEqual([]);
      expect(onlyIdea(rig).note).toBe(WAITING);
      expect(rig.logs().filter((line) => line.message === "idea heard but not asked")).toHaveLength(1);

      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toEqual([{ text: "💡 Build tonight? Whose turn to pay", alarmAt: new Date(Date.parse(MORNING) + 2 * MINUTE) }]);
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001, askedAt: MORNING, note: null });
    });

    it("still asks in the morning after the listener was started again in the night", async () => {
      const night = makeRig({ start: LATE });
      await hearAndDetect(night, ideaVerdict());
      expect(onlyIdea(night).note).toBe(WAITING);

      // A new listener on the same data, as after a restart.
      const morning = makeRig({ store: night.store, start: MORNING });
      await morning.listener.runDetectionPass();
      expect(onlyIdea(morning)).toMatchObject({ state: "asked", todoId: 9001 });
      expect(morning.detector.inputs).toHaveLength(0);
    });

    it("checks the pause flag again in the morning", async () => {
      const rig = makeRig({ start: LATE });
      for (const [index, title] of ["Chore wheel", "Parking spot swap board"].entries()) {
        await hearAndDetect(rig, ideaVerdict({ title }), `conv-${index}`);
        rig.clock.advance(MINUTE);
      }
      expect(rig.store.listIdeas().map((idea) => idea.note)).toEqual([WAITING, WAITING]);

      // Paused when the morning comes: nothing is asked, and the note says why.
      rig.store.setPaused(true, rig.clock.iso());
      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toEqual([]);
      expect(rig.store.listIdeas().map((idea) => idea.note)).toEqual(["paused: listening only", "paused: listening only"]);

      // "Paused" is a lasting reason, so resuming does not bring those asks back.
      rig.store.setPaused(false, rig.clock.iso());
      rig.clock.advance(MINUTE);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toEqual([]);
    });

    it("asks the oldest first in the morning, up to the daily limit, and skips a repeat", async () => {
      const rig = makeRig({ start: LATE, env: { MAX_ASKS_PER_DAY: "2" } });
      const heard = ["Chore wheel", "Wheel of chores", "Parking spot swap board", "Library due dates"];
      for (const [index, title] of heard.entries()) {
        await hearAndDetect(rig, ideaVerdict({ title }), `conv-${index}`);
        rig.clock.advance(MINUTE);
      }

      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls.map((call) => call.text)).toEqual(["💡 Build tonight? Chore wheel", "💡 Build tonight? Parking spot swap board"]);
      expect(rig.store.listIdeas().map((idea) => [idea.state, idea.note])).toEqual([
        ["asked", null],
        ["heard", "already asked about something like this recently"],
        ["asked", null],
        ["heard", "already asked 2 times today"],
      ]);
    });

    it("does not ask about an idea that is twelve hours old by the morning", async () => {
      // An early cutoff makes the night thirteen hours long: 6 pm to 7 am.
      const rig = makeRig({ start: "2026-10-10T00:28:00.000Z", env: { ASK_CUTOFF: "18:00" } }); // detected at 6:30 pm
      await hearAndDetect(rig, ideaVerdict({ title: "Chore wheel" }), "conv-a");
      rig.clock.set("2026-10-10T02:00:00.000Z"); // 8 pm
      await hearAndDetect(rig, ideaVerdict({ title: "Parking spot swap board" }), "conv-b");
      expect(rig.store.listIdeas().map((idea) => idea.note)).toEqual(["heard during quiet hours; will ask after 07:00", "heard during quiet hours; will ask after 07:00"]);

      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(byTitle(rig, "Chore wheel")).toMatchObject({ state: "heard", note: "waited more than 12 hours to be asked, so it was not asked" });
      expect(byTitle(rig, "Parking spot swap board")?.state).toBe("asked");

      // The note no longer says "will ask", and later passes leave the idea alone.
      rig.clock.advance(MINUTE);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("makes one to-do in the morning even if the store can save nothing for a while", async () => {
      const rig = makeRig({ start: LATE });
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig).note).toBe(WAITING);

      // Morning, and every write fails: not even the "asking now" mark can be left, so nothing is
      // asked, and the idea goes on looking like one that is still waiting to be asked.
      rig.clock.set(MORNING);
      const busy = [
        vi.spyOn(rig.store, "transitionIdea").mockImplementation(() => {
          throw new Error("database is locked");
        }),
        vi.spyOn(rig.store, "setIdeaNote").mockImplementation(() => {
          throw new Error("database is locked");
        }),
      ];
      for (let pass = 0; pass < 4; pass += 1) {
        await rig.listener.runDetectionPass();
        rig.clock.advance(rig.options.retryDelayMs);
      }
      expect(onlyIdea(rig)).toMatchObject({ state: "heard", note: WAITING });
      expect(rig.bee.createCalls).toEqual([]);

      for (const spy of busy) spy.mockRestore();
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001, askedAt: rig.clock.iso(), note: null });
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(rig.bee.created).toEqual([9001]);
      expect(rig.bee.createCalls).toHaveLength(1);
    });

    it("leaves a morning ask that Bee refused to its own retries", async () => {
      const rig = makeRig({ start: LATE });
      await hearAndDetect(rig, ideaVerdict());
      rig.clock.set(MORNING);
      // Bee refuses, and the note saying so cannot be written either.
      rig.bee.createErrors.push(refused(), refused());
      const realSetNote = rig.store.setIdeaNote.bind(rig.store);
      const noNotes = vi.spyOn(rig.store, "setIdeaNote").mockImplementation((id, note, now) => {
        if (note?.startsWith("could not create") === true) throw new Error("database is locked");
        realSetNote(id, note, now);
      });
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);

      // Passes every ten seconds: the next try waits its minute like any other.
      for (let pass = 0; pass < 5; pass += 1) {
        rig.clock.advance(10 * SECOND);
        await rig.listener.runDetectionPass();
      }
      expect(rig.bee.createCalls).toHaveLength(1);
      rig.clock.advance(10 * SECOND);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(2);

      noNotes.mockRestore();
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001 });
      expect(rig.bee.createCalls).toHaveLength(3);
    });

    it("gives a more lasting reason when there is one", async () => {
      const rig = makeRig({ start: LATE, env: { MAX_ASKS_PER_DAY: "0" } });
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig).note).toBe("asking is switched off (the daily limit is 0)");
      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toEqual([]);
    });

    it("puts off a try that comes due after the cutoff", async () => {
      const rig = makeRig({ start: "2026-10-10T04:55:30.000Z" }); // detected at 10:57:30 pm
      rig.bee.createErrors.push(refused());
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig).note).toBe("could not create the Bee to-do: failed");

      // The second try is due at 10:58:30 pm. Its alarm would ring at 11:00:30 pm, which is quiet hours.
      rig.clock.advance(rig.options.retryDelayMs);
      await rig.listener.runDetectionPass();
      expect(rig.bee.createCalls).toHaveLength(1);
      expect(onlyIdea(rig).note).toBe(WAITING);

      rig.clock.set(MORNING);
      await rig.listener.runDetectionPass();
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", todoId: 9001 });
    });

    it("has no quiet hours when the cutoff and the delivery time are the same", async () => {
      const rig = makeRig({ start: LATE, env: { ASK_CUTOFF: "07:00" } });
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig).state).toBe("asked");
    });
  });

  it("never logs an idea's title", async () => {
    const rig = makeRig();
    // Heard, refused once, asked, then answered: every log line an idea can cause on its way.
    rig.bee.createErrors.push(refused());
    await hearAndDetect(rig, ideaVerdict({ title: "Zanzibar spice ledger" }));
    rig.clock.advance(rig.options.retryDelayMs);
    await rig.listener.runDetectionPass();
    rig.bee.todos.set(9001, "completed");
    await rig.listener.runApprovalPass();
    // And one that is heard but not asked.
    await hearAndDetect(rig, ideaVerdict({ title: "Zanzibar spice ledger" }), "conv-b");

    expect(rig.store.listIdeas().map((idea) => [idea.title, idea.state])).toEqual([
      ["Zanzibar spice ledger", "approved"],
      ["Zanzibar spice ledger", "heard"],
    ]);
    const ideaId = rig.store.listIdeas()[0]!.id;
    expect(rig.logs().filter((line) => line.ideaId === ideaId).map((line) => line.message)).toEqual([
      "idea heard",
      "could not create the ask to-do",
      "asked on the wrist",
      "ask approved",
    ]);
    const log = rig.logText.join("\n").toLowerCase();
    for (const word of ["zanzibar", "spice", "ledger"]) expect(log).not.toContain(word);
    for (const line of rig.logs()) expect(line).not.toHaveProperty("title");
  });

  describe("when an unanswered ask expires", () => {
    const config = testConfig();
    const expiry = (askedAt: string) => askExpiresAt(new Date(askedAt), config, HOUR).toISOString();

    it("is the next 11 pm in Boise", () => {
      expect(expiry(T0)).toBe("2026-10-10T05:00:00.000Z");
      // Exactly one hour before the cutoff is still enough.
      expect(expiry("2026-10-10T04:00:00.000Z")).toBe("2026-10-10T05:00:00.000Z");
    });

    it("is tomorrow's cutoff when today's is less than an hour away", () => {
      expect(expiry("2026-10-10T04:00:00.001Z")).toBe("2026-10-11T05:00:00.000Z");
      expect(expiry("2026-10-10T04:30:00.000Z")).toBe("2026-10-11T05:00:00.000Z");
      // Asked just after the cutoff: the next one is almost a day away, and that is the one.
      expect(expiry("2026-10-10T05:00:01.000Z")).toBe("2026-10-11T05:00:00.000Z");
    });

    it("follows the clocks going back on Nov 1", () => {
      // 10:30 pm on Oct 31 (UTC-6). The next cutoff after tonight's is 11 pm on Nov 1 (UTC-7).
      expect(expiry("2026-11-01T04:30:00.000Z")).toBe("2026-11-02T06:00:00.000Z");
    });

    it("is stored on the idea when it is asked late in the evening", async () => {
      const rig = makeRig({ start: "2026-10-10T04:28:00.000Z" }); // 10:28 pm; asked at 10:30 pm
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig)).toMatchObject({ state: "asked", askedAt: "2026-10-10T04:30:00.000Z", askExpiresAt: "2026-10-11T05:00:00.000Z" });
    });

    it("uses the ASK_CUTOFF setting", async () => {
      const rig = makeRig({ env: { ASK_CUTOFF: "21:30" } });
      await hearAndDetect(rig, ideaVerdict());
      expect(onlyIdea(rig).askExpiresAt).toBe("2026-10-10T03:30:00.000Z");
    });
  });
});
