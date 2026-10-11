// Synthetic test data: every title, pitch, quote and link in this file is made up. None of it is Bee data.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BeeError, BUILD_INTERRUPTED_REASON, BUILD_STOPPED_REASON, MAX_BUILD_STARTS } from "@overnight/core";
import { describe, expect, it, vi } from "vitest";
import { ANNOUNCING_NOTE, BUILD_RETRY_PENDING_REASON, DELIVER_STOPPED_REASON, deliverOne, NOT_SEEN_LIVE_NOTE, PUSHED_UNCONFIRMED_NOTE, reportPath, runDeliver } from "../src/index.ts";
import { HOUR, lostReply, makeRig, MINUTE, PITCH, QUOTE, refused, T_0630, TITLE } from "./helpers.ts";

const SEVEN_AM = "2026-10-10T13:00:00.000Z";

function readReport(rig: ReturnType<typeof makeRig>, ideaId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(reportPath(rig.paths, ideaId), "utf8")) as Record<string, unknown>;
}

describe("runDeliver: the happy path", () => {
  it("verifies, publishes, records the link, creates the to-do for 7:00, writes the fact and the report, in that order", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    const order: string[] = [];
    rig.bee.onCreateTodo = () => order.push(`todo while ${rig.store.getIdea(idea.id)?.state}`);

    const summary = await runDeliver(rig.deps);

    expect(summary).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.states(idea.id)).toEqual(["heard", "asked", "approved", "building", "built", "published", "delivered"]);
    // The link was recorded before anyone was told about it.
    expect(order).toEqual(["todo while published"]);

    expect(rig.verifier.calls).toHaveLength(1);
    const job = rig.verifier.calls[0];
    expect(job).toMatchObject({ ideaId: idea.id, workspace: path.join(rig.paths.workspaces, idea.id) });
    // A run folder of its own, inside the idea's folder under tmp/deliver.
    expect(path.dirname(job?.runDir ?? "")).toBe(path.join(rig.paths.deliverRuns, idea.id));
    expect(path.basename(job?.runDir ?? "")).toMatch(/^run-[a-z0-9]+-[0-9a-f]{6}$/);
    expect(rig.publisher.calls).toHaveLength(1);
    expect(rig.publisher.calls[0]).toMatchObject({ ideaId: idea.id, slug: idea.slug, distDir: path.join(job?.runDir ?? "", "site") });
    expect(rig.publisher.calls[0]?.marker).toMatch(new RegExp(`^${idea.id}-[a-z0-9]+-[0-9a-f]{8}$`));

    const url = `https://made-up-owner.github.io/overnight-apps/${idea.slug}/`;
    expect(rig.bee.todoCalls).toEqual([{ text: `☀️ Built overnight: ${TITLE} → ${url}`, alarmAt: new Date(SEVEN_AM) }]);
    expect(rig.bee.factCalls).toEqual([`Overnight built "${TITLE}" on Oct 10: ${url}`]);

    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({ state: "delivered", publishedUrl: url, publishedAt: T_0630, deliveredAt: T_0630, morningTodoId: 7001, factId: 301, failureReason: null, failureNotifiedAt: null });

    const report = readReport(rig, idea.id);
    expect(report).toMatchObject({
      ideaId: idea.id,
      slug: idea.slug,
      title: TITLE,
      pitch: PITCH,
      backend: "kiro-crew",
      state: "delivered",
      ok: true,
      url,
      confirmedLive: true,
      failureReason: null,
      note: null,
      checks: { buildOk: true, distFiles: 1 },
      timings: { liveAfterMs: 21_000 },
      sizes: { sourceFiles: 4, sourceBytes: 900, distFiles: 1, distBytes: 23 },
      screenshots: { phone: `/made-up/screenshots/${idea.id}.png`, desktop: `/made-up/screenshots/${idea.id}-desktop.png` },
      morningTodoId: 7001,
      factId: 301,
    });
    expect(JSON.stringify(report)).not.toContain(QUOTE);
    // The throwaway run folder is gone once the app is published.
    expect(existsSync(path.join(rig.paths.deliverRuns, idea.id))).toBe(false);
  });

  it("delivers while Overnight is paused: only asking and building stop", async () => {
    const rig = makeRig({ env: { PAUSED: "true" } });
    rig.store.setPaused(true, rig.clock.iso());
    const idea = rig.idea("built");
    expect((await runDeliver(rig.deps)).delivered).toEqual([idea.id]);
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("handles two built ideas one after the other, each announced before the next starts", async () => {
    const rig = makeRig();
    const first = rig.idea("built");
    const second = rig.idea("built", { title: "Marmalade tracker" });
    const seen: string[] = [];
    rig.bee.onCreateTodo = () => seen.push(`${rig.verifier.calls.length} verified`);

    const summary = await runDeliver(rig.deps);

    expect(summary.delivered).toEqual([first.id, second.id]);
    expect(seen).toEqual(["1 verified", "2 verified"]);
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([
      `☀️ Built overnight: ${TITLE} → https://made-up-owner.github.io/overnight-apps/${first.slug}/`,
      `☀️ Built overnight: Marmalade tracker → https://made-up-owner.github.io/overnight-apps/${second.slug}/`,
    ]);
  });

  it("does not write a fact when facts are switched off", async () => {
    const rig = makeRig({ env: { WRITE_BEE_FACTS: "false" } });
    const idea = rig.idea("built");
    await runDeliver(rig.deps);
    expect(rig.bee.factCalls).toEqual([]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", factId: null });
  });
});

describe("runDeliver: when something fails", () => {
  it("verification fails: publish_failed with the reason, nothing published, one 🌙 to-do", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.verifier.results.push({ ok: false, reason: "The app's build command (npm run build) failed.", checks: { installOk: true, failedStep: "build" } });

    const summary = await runDeliver(rig.deps);

    expect(summary).toEqual({ delivered: [], failed: [idea.id], notified: [idea.id] });
    expect(rig.publisher.calls).toEqual([]);
    expect(rig.states(idea.id).slice(-2)).toEqual(["built", "publish_failed"]);
    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({ state: "publish_failed", failureReason: "The app's build command (npm run build) failed.", publishedUrl: null, failureNotifiedAt: T_0630, morningTodoId: null });
    expect(rig.bee.todoCalls).toEqual([{ text: `🌙 Couldn't finish ${TITLE}, details on the dashboard`, alarmAt: new Date(SEVEN_AM) }]);
    expect(rig.bee.factCalls).toEqual([]);
    expect(readReport(rig, idea.id)).toMatchObject({ ok: false, state: "publish_failed", url: null, confirmedLive: null, failureReason: "The app's build command (npm run build) failed.", checks: { failedStep: "build" } });
  });

  it("publishing fails: publish_failed with the publisher's reason, and one 🌙 to-do", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.results.push({ ok: false, reason: "Could not push the new version to GitHub." });

    const summary = await runDeliver(rig.deps);

    expect(summary).toEqual({ delivered: [], failed: [idea.id], notified: [idea.id] });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "publish_failed", failureReason: "Could not push the new version to GitHub.", publishedUrl: null });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`🌙 Couldn't finish ${TITLE}, details on the dashboard`]);
  });

  it("a verifier or publisher that throws is treated as a failure, and the next idea still goes out", async () => {
    const rig = makeRig();
    const broken = rig.idea("built");
    const fine = rig.idea("built", { title: "Marmalade tracker" });
    rig.verifier.results.push(new Error("made-up crash"));

    const summary = await runDeliver(rig.deps);

    expect(summary.failed).toEqual([broken.id]);
    expect(summary.delivered).toEqual([fine.id]);
    expect(rig.store.getIdea(broken.id)?.state).toBe("publish_failed");
  });

  it("an idea without a usable slug is never handed to the verifier or the publisher", async () => {
    const rig = makeRig();
    const idea = rig.idea("built", { slug: null });
    const summary = await runDeliver(rig.deps);
    expect(summary.failed).toEqual([idea.id]);
    expect(rig.verifier.calls).toEqual([]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "publish_failed", failureReason: "The idea has no usable folder name for its link." });
  });

  it("tells the wearer once about a build that failed in the night, and never again", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed");

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [idea.id] });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`🌙 Couldn't finish ${TITLE}, details on the dashboard`]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureNotifiedAt: T_0630 });

    rig.clock.advance(24 * HOUR);
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [] });
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("a 🌙 to-do Bee refused is tried again on the next run; one whose reply was lost is not", async () => {
    const rig = makeRig();
    const refusedIdea = rig.idea("build_failed");
    rig.bee.todoErrors.push(refused(), refused(), refused());
    expect((await runDeliver(rig.deps)).notified).toEqual([]);
    expect(rig.bee.todoCalls).toHaveLength(3);
    expect(rig.store.getIdea(refusedIdea.id)?.failureNotifiedAt).toBeNull();

    // Next run: Bee loses the reply. The to-do may exist, so that was the one and only try.
    rig.bee.todoErrors.push(lostReply());
    expect((await runDeliver(rig.deps)).notified).toEqual([]);
    expect(rig.bee.todoCalls).toHaveLength(4);
    expect(rig.store.getIdea(refusedIdea.id)?.failureNotifiedAt).toBe(T_0630);
    await runDeliver(rig.deps);
    expect(rig.bee.todoCalls).toHaveLength(4);
  });
});

describe("runDeliver: never twice", () => {
  it("a second run is a no-op: nothing verified, published or buzzed again", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    await runDeliver(rig.deps);
    const reportBefore = readFileSync(reportPath(rig.paths, idea.id), "utf8");

    rig.clock.advance(10 * MINUTE);
    const again = await runDeliver(rig.deps);

    expect(again).toEqual({ delivered: [], failed: [], notified: [] });
    expect(rig.verifier.calls).toHaveLength(1);
    expect(rig.publisher.calls).toHaveLength(1);
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.bee.factCalls).toHaveLength(1);
    expect(readFileSync(reportPath(rig.paths, idea.id), "utf8")).toBe(reportBefore);
  });

  it("a to-do whose reply was lost counts as delivered: no second to-do, now or on a later run", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.todoErrors.push(lostReply());

    const summary = await runDeliver(rig.deps);

    expect(summary.delivered).toEqual([idea.id]);
    expect(rig.bee.todoCalls).toHaveLength(1);
    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({ state: "delivered", morningTodoId: null, deliveredAt: T_0630 });
    expect(after?.note).toContain("reply was lost (timeout)");

    await runDeliver(rig.deps);
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.publisher.calls).toHaveLength(1);
  });

  it("a reply Bee sent but we could not read is treated the same way", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.todoErrors.push(new BeeError("bad-response", "bee printed something unexpected"));
    await runDeliver(rig.deps);
    await runDeliver(rig.deps);
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)?.state).toBe("delivered");
  });

  it("a to-do Bee plainly refused is asked for again, up to three times, and the idea stays published if all fail", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.todoErrors.push(refused(), refused(), refused());

    const summary = await runDeliver(rig.deps);

    expect(summary).toEqual({ delivered: [], failed: [idea.id], notified: [] });
    expect(rig.bee.todoCalls).toHaveLength(3);
    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({ state: "published", deliveredAt: null, note: null });
    // Not a failed build: no 🌙 to-do, and no fact before the wearer was told.
    expect(rig.bee.factCalls).toEqual([]);

    // The next run goes straight to the to-do: nothing is verified or published again.
    const next = await runDeliver(rig.deps);
    expect(next.delivered).toEqual([idea.id]);
    expect(rig.verifier.calls).toHaveLength(1);
    expect(rig.publisher.calls).toHaveLength(1);
    expect(rig.bee.todoCalls).toHaveLength(4);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", morningTodoId: 7001 });
  });

  it("does not ask again while Bee is logged out, and picks the idea up once it is back", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.todoErrors.push(new BeeError("logged-out", "bee is not logged in"));
    expect((await runDeliver(rig.deps)).failed).toEqual([idea.id]);
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)?.state).toBe("published");
    expect((await runDeliver(rig.deps)).delivered).toEqual([idea.id]);
  });

  it("resumes an idea that was published but not announced, without publishing it again", async () => {
    const rig = makeRig();
    const idea = rig.idea("published");

    const summary = await runDeliver(rig.deps);

    expect(summary).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.verifier.calls).toEqual([]);
    expect(rig.publisher.calls).toEqual([]);
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`☀️ Built overnight: ${TITLE} → ${idea.publishedUrl}`]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", morningTodoId: 7001 });
  });

  it("an idea cut off while its to-do was being created is closed without a second to-do", async () => {
    const rig = makeRig();
    const idea = rig.idea("published");
    rig.store.updateIdea(idea.id, { note: ANNOUNCING_NOTE }, rig.clock.iso());

    const summary = await runDeliver(rig.deps);

    expect(summary.delivered).toEqual([idea.id]);
    expect(rig.bee.todoCalls).toEqual([]);
    const after = rig.store.getIdea(idea.id);
    expect(after).toMatchObject({ state: "delivered", morningTodoId: null });
    expect(after?.note).toContain("stopped before the reply came");
  });

  it("leaves the mark in place while Bee is being asked, so a crash at that moment is seen by the next run", async () => {
    const rig = makeRig();
    const idea = rig.idea("published");
    let noteDuringCall: string | null | undefined;
    rig.bee.onCreateTodo = () => {
      noteDuringCall = rig.store.getIdea(idea.id)?.note;
    };
    await runDeliver(rig.deps);
    expect(noteDuringCall).toBe(ANNOUNCING_NOTE);
    expect(rig.store.getIdea(idea.id)?.note).toBeNull();
  });

  it("a fact Bee refused or lost does not hold up delivery and is not asked for on a later run", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.factErrors.push(lostReply());
    const summary = await runDeliver(rig.deps);
    expect(summary.delivered).toEqual([idea.id]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", factId: null });
    await runDeliver(rig.deps);
    expect(rig.bee.factCalls).toHaveLength(1);
  });

  it("leaves ideas in other states alone", async () => {
    const rig = makeRig();
    const untouched = [rig.idea("asked"), rig.idea("approved"), rig.idea("building"), rig.idea("delivered")];
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [] });
    expect(rig.bee.todoCalls).toEqual([]);
    for (const idea of untouched) expect(rig.store.getIdea(idea.id)?.state).toBe(idea.state);
  });
});

describe("runDeliver: a build that was cut short gets one more try before anyone is told", () => {
  const FAILURE_TODO = `🌙 Couldn't finish ${TITLE}, details on the dashboard`;
  const quiet = { delivered: [], failed: [], notified: [] };

  it("stopped once: no to-do, this morning or the next, and the log says why by id only", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_STOPPED_REASON });
    expect(rig.store.countBuildStarts(idea.id)).toBe(1);

    expect(await runDeliver(rig.deps)).toEqual(quiet);
    rig.clock.advance(24 * HOUR);
    expect(await runDeliver(rig.deps)).toEqual(quiet);

    expect(rig.bee.todoCalls).toEqual([]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureReason: BUILD_STOPPED_REASON, failureNotifiedAt: null });
    const lines = rig.logLines.filter((line) => line.includes("gets one more try"));
    // One line per such idea per run.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ level: "info", ideaId: idea.id, buildStarts: 1 });
      expect(line).not.toContain(TITLE);
    }
  });

  it("cut off once (a crash or a restart mid-build) is treated the same way", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_INTERRUPTED_REASON });
    expect(await runDeliver(rig.deps)).toEqual(quiet);
    expect(rig.bee.todoCalls).toEqual([]);
    expect(rig.store.getIdea(idea.id)?.failureNotifiedAt).toBeNull();
  });

  it("stopped on both starts: exactly one 🌙 to-do across the two mornings, and none after", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_STOPPED_REASON });

    // Morning 1: one start used, one to go.
    expect(await runDeliver(rig.deps)).toEqual(quiet);
    expect(rig.bee.todoCalls).toEqual([]);

    // The next night the builder starts it again, and that build is stopped too.
    rig.clock.advance(18 * HOUR);
    rig.buildAgain(idea.id, { failureReason: BUILD_STOPPED_REASON });
    expect(rig.store.countBuildStarts(idea.id)).toBe(MAX_BUILD_STARTS);

    // Morning 2: now it could not be finished.
    rig.clock.advance(6 * HOUR);
    const morningTwo = rig.clock.iso();
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [idea.id] });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([FAILURE_TODO]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "build_failed", failureNotifiedAt: morningTwo });

    // Morning 3: nothing more.
    rig.clock.advance(24 * HOUR);
    expect(await runDeliver(rig.deps)).toEqual(quiet);
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("stopped once, then cut off on the second start: told once as well", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_STOPPED_REASON });
    await runDeliver(rig.deps);
    rig.buildAgain(idea.id, { failureReason: BUILD_INTERRUPTED_REASON });
    expect((await runDeliver(rig.deps)).notified).toEqual([idea.id]);
    expect((await runDeliver(rig.deps)).notified).toEqual([]);
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([FAILURE_TODO]);
  });

  it("stopped once, then built by the second start: delivered with the ☀️ to-do and never a 🌙 one", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_STOPPED_REASON });
    expect(await runDeliver(rig.deps)).toEqual(quiet);

    rig.buildAgain(idea.id, "built");

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`☀️ Built overnight: ${TITLE} → https://made-up-owner.github.io/overnight-apps/${idea.slug}/`]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", failureReason: null, failureNotifiedAt: null });
  });

  it("stopped once, then the second start fails for real: told once, with no more waiting", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_STOPPED_REASON });
    await runDeliver(rig.deps);
    rig.buildAgain(idea.id, { failureReason: "The build agent ran out of time." });
    expect((await runDeliver(rig.deps)).notified).toEqual([idea.id]);
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("a build that really failed is told about as before, in the same run that keeps quiet about a stopped one", async () => {
    const rig = makeRig();
    const stopped = rig.idea("build_failed", { title: "Marmalade tracker", failureReason: BUILD_STOPPED_REASON });
    const failed = rig.idea("build_failed");
    expect(rig.store.countBuildStarts(failed.id)).toBe(1);

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [failed.id] });

    expect(rig.bee.todoCalls).toEqual([{ text: FAILURE_TODO, alarmAt: new Date(SEVEN_AM) }]);
    expect(rig.store.getIdea(failed.id)?.failureNotifiedAt).toBe(T_0630);
    expect(rig.store.getIdea(stopped.id)?.failureNotifiedAt).toBeNull();
  });

  it("a failed publish is not a cut-short build, whatever its reason says: told about as before", async () => {
    const rig = makeRig();
    const usual = rig.idea("publish_failed");
    const odd = rig.idea("publish_failed", { title: "Marmalade tracker" });
    // Cannot happen today; shows that the rule looks at the state, not only at the words.
    rig.store.updateIdea(odd.id, { failureReason: BUILD_STOPPED_REASON }, rig.clock.iso());

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [usual.id, odd.id] });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([FAILURE_TODO, "🌙 Couldn't finish Marmalade tracker, details on the dashboard"]);
    expect(rig.logLines.join("\n")).not.toContain("gets one more try");
  });

  it("a publish that fails this morning is still told about this morning", async () => {
    const rig = makeRig();
    const stopped = rig.idea("build_failed", { title: "Marmalade tracker", failureReason: BUILD_STOPPED_REASON });
    const built = rig.idea("built");
    rig.publisher.results.push({ ok: false, reason: "Could not push the new version to GitHub." });
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [built.id], notified: [built.id] });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([FAILURE_TODO]);
    expect(rig.store.getIdea(stopped.id)?.failureNotifiedAt).toBeNull();
  });

  it("when the number of build starts cannot be read, a cut-short build is left alone for this run and a real failure is still told", async () => {
    const rig = makeRig();
    const stopped = rig.idea("build_failed", { title: "Marmalade tracker", failureReason: BUILD_STOPPED_REASON });
    const failed = rig.idea("build_failed");
    const count = vi.spyOn(rig.store, "countBuildStarts").mockImplementation(() => {
      throw new Error("made-up database trouble");
    });
    try {
      expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [failed.id] });
      expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([FAILURE_TODO]);
      expect(rig.store.getIdea(stopped.id)?.failureNotifiedAt).toBeNull();
      expect(rig.logLines.join("\n")).toContain("could not count an idea's build starts");
      // A real failure is decided without counting at all.
      expect(count.mock.calls.map((call) => call[0])).toEqual([stopped.id]);
    } finally {
      count.mockRestore();
    }
  });

  it("deliverOne follows the same rule: silent while the second start is still to come, one 🌙 to-do after it", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed", { failureReason: BUILD_STOPPED_REASON });

    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: false, reason: BUILD_RETRY_PENDING_REASON });
    expect(rig.bee.todoCalls).toEqual([]);
    expect(rig.store.getIdea(idea.id)?.failureNotifiedAt).toBeNull();

    rig.buildAgain(idea.id, { failureReason: BUILD_STOPPED_REASON });
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: false, reason: BUILD_STOPPED_REASON });
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: false, reason: BUILD_STOPPED_REASON });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([FAILURE_TODO]);
  });
});

describe("runDeliver: pushed, but the page was not seen live before the wait ran out", () => {
  const TEN_MINUTES = 10 * MINUTE;
  const url = (slug: string | null) => `https://made-up-owner.github.io/overnight-apps/${slug}/`;
  const notSeenLive = (slug: string | null) => ({ ok: true as const, url: url(slug), liveAfterMs: null, confirmedLive: false as const, waitedMs: TEN_MINUTES });

  it("is recorded as published with its link and a note, reported, warned about, and announced as usual", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.results.push(notSeenLive(idea.slug));

    const summary = await runDeliver(rig.deps);

    // Delivered like any other, and named as not seen live.
    expect(summary).toEqual({ delivered: [idea.id], failed: [], notified: [], notSeenLive: [idea.id] });
    expect(rig.states(idea.id).slice(-3)).toEqual(["built", "published", "delivered"]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({
      state: "delivered",
      publishedUrl: url(idea.slug),
      publishedAt: T_0630,
      deliveredAt: T_0630,
      morningTodoId: 7001,
      factId: 301,
      failureReason: null,
      failureNotifiedAt: null,
      note: NOT_SEEN_LIVE_NOTE,
    });
    // The note is on the timeline too, where the move to "published" was recorded.
    expect(rig.store.ideaEvents(idea.id).find((event) => event.toState === "published")?.note).toBe(NOT_SEEN_LIVE_NOTE);
    // The same ☀️ to-do, for 7:00, and the same fact. No 🌙 to-do.
    expect(rig.bee.todoCalls).toEqual([{ text: `☀️ Built overnight: ${TITLE} → ${url(idea.slug)}`, alarmAt: new Date(SEVEN_AM) }]);
    expect(rig.bee.factCalls).toEqual([`Overnight built "${TITLE}" on Oct 10: ${url(idea.slug)}`]);

    const report = readReport(rig, idea.id);
    expect(report).toMatchObject({ state: "delivered", ok: true, url: url(idea.slug), confirmedLive: false, failureReason: null, note: NOT_SEEN_LIVE_NOTE, morningTodoId: 7001 });
    expect((report.timings as Record<string, unknown>).liveAfterMs).toBeNull();
    expect((report.timings as Record<string, unknown>).publishMs).toEqual(expect.any(Number));

    const warning = rig.logLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => String(line.msg ?? line.message ?? "").includes("was not seen live before the wait ran out"));
    expect(warning).toMatchObject({ level: "warn", ideaId: idea.id, waitedMs: TEN_MINUTES });
    expect(rig.logLines.join("\n")).not.toContain("a built app was not published");
    // The throwaway run folder is gone, as after any publish.
    expect(existsSync(path.join(rig.paths.deliverRuns, idea.id))).toBe(false);

    // The next morning: nothing is verified, published or buzzed again, and nobody is told it failed.
    rig.clock.advance(24 * HOUR);
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [] });
    expect(rig.publisher.calls).toHaveLength(1);
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("the three outcomes of a push side by side: seen live, not seen live, and stopped after the push", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const live = rig.idea("built");
    const unseen = rig.idea("built", { title: "Marmalade tracker" });
    const cutShort = rig.idea("built", { title: "Accordion lesson planner" });
    rig.publisher.results.push({ ok: true, url: url(live.slug), liveAfterMs: 21_000, confirmedLive: true }, notSeenLive(unseen.slug), { ok: false, reason: "Publishing was stopped before it finished.", stopped: true, pushed: true });
    rig.publisher.onPublish = (job) => {
      if (job.ideaId === cutShort.id) stop.abort();
    };

    const summary = await runDeliver({ ...rig.deps, signal: stop.signal });

    expect(summary).toEqual({ delivered: [live.id, unseen.id], failed: [], notified: [], stopped: true, notSeenLive: [unseen.id] });
    expect(rig.store.getIdea(live.id)).toMatchObject({ state: "delivered", publishedUrl: url(live.slug), note: null });
    expect(rig.store.getIdea(unseen.id)).toMatchObject({ state: "delivered", publishedUrl: url(unseen.slug), note: NOT_SEEN_LIVE_NOTE });
    // Stopped after the push: exactly as before. Not published, nobody told, published again next time.
    expect(rig.store.getIdea(cutShort.id)).toMatchObject({ state: "built", publishedUrl: null, note: PUSHED_UNCONFIRMED_NOTE, failureReason: null, failureNotifiedAt: null });
    expect(readReport(rig, live.id)).toMatchObject({ confirmedLive: true, timings: { liveAfterMs: 21_000 } });
    expect(readReport(rig, unseen.id)).toMatchObject({ confirmedLive: false, timings: { liveAfterMs: null } });
    expect(existsSync(reportPath(rig.paths, cutShort.id))).toBe(false);
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`☀️ Built overnight: ${TITLE} → ${url(live.slug)}`, `☀️ Built overnight: Marmalade tracker → ${url(unseen.slug)}`]);

    // The next run finishes the third one, and only that one.
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [cutShort.id], failed: [], notified: [] });
    expect(rig.publisher.calls.map((call) => call.ideaId)).toEqual([live.id, unseen.id, cutShort.id, cutShort.id]);
    expect(rig.bee.todoCalls).toHaveLength(3);
    expect(rig.store.getIdea(cutShort.id)).toMatchObject({ state: "delivered", note: null });
  });

  it("not seen live and stopped at the same moment: treated as stopped after the push, as before", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.onPublish = () => stop.abort();
    rig.publisher.results.push(notSeenLive(idea.slug));

    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toEqual({ delivered: [], failed: [], notified: [], stopped: true });

    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", publishedUrl: null, note: PUSHED_UNCONFIRMED_NOTE, failureReason: null });
    expect(rig.bee.todoCalls).toEqual([]);
    expect(existsSync(reportPath(rig.paths, idea.id))).toBe(false);
    // The next run publishes again and tells the wearer once.
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.publisher.calls).toHaveLength(2);
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", note: null });
  });

  it("when Bee refuses the to-do, the idea stays published with its note, and the next run tells the wearer without publishing again", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.results.push(notSeenLive(idea.slug));
    rig.bee.todoErrors.push(refused(), refused(), refused());

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [idea.id], notified: [], notSeenLive: [idea.id] });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "published", publishedUrl: url(idea.slug), note: NOT_SEEN_LIVE_NOTE, failureNotifiedAt: null });

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.publisher.calls).toHaveLength(1);
    expect(rig.bee.todoCalls.map((call) => call.text).at(-1)).toBe(`☀️ Built overnight: ${TITLE} → ${url(idea.slug)}`);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", note: NOT_SEEN_LIVE_NOTE });
    // The report still says what was and was not seen, a run later.
    expect(readReport(rig, idea.id)).toMatchObject({ state: "delivered", confirmedLive: false, note: NOT_SEEN_LIVE_NOTE, timings: { liveAfterMs: null } });
  });

  it("a push that did not go through is still a failure with a 🌙 to-do: only a push that succeeded can be 'not seen live'", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    // What the publisher answers when the push ran into its time limit: it MAY be on GitHub.
    rig.publisher.results.push({ ok: false, reason: "Could not push the new version to GitHub.", pushed: true });
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [idea.id], notified: [idea.id] });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "publish_failed", publishedUrl: null });
    expect(readReport(rig, idea.id)).toMatchObject({ ok: false, confirmedLive: null });
  });

  it("deliverOne says so in its answer, next to the link", async () => {
    const rig = makeRig({ startIso: "2026-10-10T21:00:00.000Z" });
    const idea = rig.idea("built");
    rig.publisher.results.push(notSeenLive(idea.slug));
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: true, url: url(idea.slug), notSeenLive: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", note: NOT_SEEN_LIVE_NOTE });
    expect(rig.bee.todoCalls).toHaveLength(1);
    // Asked again: already delivered, nothing new to say.
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: true, url: url(idea.slug) });
  });

  it("a failed publish tried again by id that is then pushed but not seen live: published, the old reason gone, the note in its place", async () => {
    const rig = makeRig();
    const idea = rig.idea("publish_failed");
    rig.publisher.results.push(notSeenLive(idea.slug));
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: true, url: url(idea.slug), notSeenLive: true });
    expect(rig.states(idea.id).slice(-3)).toEqual(["publish_failed", "published", "delivered"]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", failureReason: null, note: NOT_SEEN_LIVE_NOTE });
  });

  it("a publisher that says nothing either way (an older or stand-in one) counts as seen live", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.results.push({ ok: true, url: url(idea.slug), liveAfterMs: 5 });
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", note: null });
    expect(readReport(rig, idea.id)).toMatchObject({ confirmedLive: true });
  });
});

describe("the alarm on the morning to-do", () => {
  it("a late run (9:00) buzzes two minutes from now instead of waiting for tomorrow's 7:00", async () => {
    const nineAm = "2026-10-10T15:00:00.000Z";
    const rig = makeRig({ startIso: nineAm });
    rig.idea("built");
    await runDeliver(rig.deps);
    expect(rig.bee.todoCalls[0]?.alarmAt).toEqual(new Date(Date.parse(nineAm) + 2 * MINUTE));
  });
});

describe("deliverOne", () => {
  it("runs the same steps for one built idea and returns its link", async () => {
    const rig = makeRig({ startIso: "2026-10-10T21:00:00.000Z" });
    const idea = rig.idea("built");
    const other = rig.idea("built", { title: "Marmalade tracker" });

    const result = await deliverOne(idea.id, rig.deps);

    expect(result).toEqual({ ok: true, url: `https://made-up-owner.github.io/overnight-apps/${idea.slug}/` });
    expect(rig.store.getIdea(idea.id)?.state).toBe("delivered");
    expect(rig.store.getIdea(other.id)?.state).toBe("built");
    // Mid-afternoon: the alarm rings in two minutes.
    expect(rig.bee.todoCalls[0]?.alarmAt).toEqual(new Date(Date.parse("2026-10-10T21:02:00.000Z")));
  });

  it("returns the reason when verification fails, and sends the 🌙 to-do once", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.verifier.results.push({ ok: false, reason: "The app's own smoke test (tests/smoke.spec.ts) failed.", checks: { failedStep: "app-smoke" } });

    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: false, reason: "The app's own smoke test (tests/smoke.spec.ts) failed." });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`🌙 Couldn't finish ${TITLE}, details on the dashboard`]);

    // Asked for again by id, it is tried again; a second failure does not buzz again.
    rig.verifier.results.push({ ok: false, reason: "The app's build command (npm run build) failed.", checks: { failedStep: "build" } });
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: false, reason: "The app's build command (npm run build) failed." });
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "publish_failed", failureReason: "The app's build command (npm run build) failed." });
  });

  it("a publish that failed can be delivered later by id, and the old failure reason is cleared", async () => {
    const rig = makeRig();
    const idea = rig.idea("publish_failed");
    const result = await deliverOne(idea.id, rig.deps);
    expect(result.ok).toBe(true);
    expect(rig.states(idea.id).slice(-3)).toEqual(["publish_failed", "published", "delivered"]);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", failureReason: null });
  });

  it("an idea already published goes straight to the to-do; one already delivered is left alone", async () => {
    const rig = makeRig();
    const published = rig.idea("published");
    const delivered = rig.idea("delivered");

    expect(await deliverOne(published.id, rig.deps)).toEqual({ ok: true, url: published.publishedUrl });
    expect(await deliverOne(delivered.id, rig.deps)).toEqual({ ok: true, url: delivered.publishedUrl });
    expect(rig.verifier.calls).toEqual([]);
    expect(rig.publisher.calls).toEqual([]);
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("every try gets a run folder of its own, and what the try before left behind is cleared first", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.verifier.results.push({ ok: false, reason: "The app's build command (npm run build) failed.", checks: { failedStep: "build" } });
    await deliverOne(idea.id, rig.deps);
    const firstRunDir = rig.verifier.calls[0]?.runDir ?? "";
    mkdirSync(path.join(firstRunDir, "logs"), { recursive: true });
    writeFileSync(path.join(firstRunDir, "logs", "left-over.log"), "made-up\n");

    await deliverOne(idea.id, rig.deps);

    const secondRunDir = rig.verifier.calls[1]?.runDir ?? "";
    expect(secondRunDir).not.toBe(firstRunDir);
    expect(existsSync(firstRunDir)).toBe(false);
  });

  it("says so plainly when there is nothing to deliver", async () => {
    const rig = makeRig();
    const approved = rig.idea("approved");
    expect(await deliverOne("idea_20261010_nosuch00", rig.deps)).toEqual({ ok: false, reason: "There is no idea with that id." });
    expect(await deliverOne(approved.id, rig.deps)).toEqual({ ok: false, reason: 'The idea is "approved", so there is nothing to deliver yet.' });
    expect(rig.bee.todoCalls).toEqual([]);
  });

  it("reports a published app whose to-do Bee refused as not delivered, with its link", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.todoErrors.push(refused(), refused(), refused());
    const result = await deliverOne(idea.id, rig.deps);
    expect(result.ok).toBe(false);
    expect(result.url).toBe(`https://made-up-owner.github.io/overnight-apps/${idea.slug}/`);
    expect(result.reason).toContain("Bee to-do could not be created");
  });

  it("a build that failed gets its 🌙 to-do and the build's reason", async () => {
    const rig = makeRig();
    const idea = rig.idea("build_failed");
    expect(await deliverOne(idea.id, rig.deps)).toEqual({ ok: false, reason: "The build agent ran out of time." });
    expect(rig.bee.todoCalls).toHaveLength(1);
  });
});

describe("what reaches the log", () => {
  it("is never the title, the pitch or the quote, on the happy path or on a failure", async () => {
    const rig = makeRig();
    rig.idea("built");
    rig.idea("built", { title: "Marmalade tracker" });
    rig.idea("build_failed", { title: "Accordion lesson planner" });
    rig.verifier.results.push({ ok: false, reason: "The app's build command (npm run build) failed.", checks: { failedStep: "build" } });
    rig.bee.todoErrors.push(refused(), lostReply());
    rig.bee.factErrors.push(refused());

    await runDeliver(rig.deps);
    await runDeliver(rig.deps);

    expect(rig.logLines.length).toBeGreaterThan(3);
    const all = rig.logLines.join("\n");
    for (const secret of [TITLE, "Marmalade", "Accordion", PITCH, QUOTE, "noodles"]) expect(all).not.toContain(secret);
  });
});

describe("runDeliver: what an earlier run left on disk", () => {
  /** What a build that locks its own folders leaves in an old run folder: a folder that cannot be listed, with files in it. */
  function lockOldRun(rig: ReturnType<typeof makeRig>, ideaId: string): string {
    const locked = path.join(rig.paths.deliverRuns, ideaId, "run-old", "app", "locked");
    mkdirSync(path.join(locked, "deep"), { recursive: true });
    writeFileSync(path.join(locked, "deep", "file.txt"), "made-up\n");
    chmodSync(locked, 0o000);
    return locked;
  }
  const unlock = (dir: string) => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Deleted, as it should be.
    }
  };

  it("an old run folder that cannot even be listed does not keep the idea from being delivered", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    const locked = lockOldRun(rig, idea.id);
    try {
      const summary = await runDeliver(rig.deps);
      expect(summary).toEqual({ delivered: [idea.id], failed: [], notified: [] });
      expect(rig.verifier.calls).toHaveLength(1);
      expect(rig.store.getIdea(idea.id)?.state).toBe("delivered");
      // And the leftover is gone, locked folder and all.
      expect(existsSync(locked)).toBe(false);
      expect(readdirSync(rig.paths.deliverRuns)).toEqual([]);
    } finally {
      unlock(locked);
    }
  });

  it("with such a leftover, an app that fails verification still gets its verdict and its one 🌙 to-do", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    const locked = lockOldRun(rig, idea.id);
    rig.verifier.results.push({ ok: false, reason: "The app's build command (npm run build) failed.", checks: { failedStep: "build" } });
    try {
      expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [idea.id], notified: [idea.id] });
      expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "publish_failed", failureReason: "The app's build command (npm run build) failed." });
      expect(rig.bee.todoCalls).toHaveLength(1);
      // Three more mornings: nothing is verified, published or buzzed again.
      for (let morning = 0; morning < 3; morning += 1) expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [] });
      expect(rig.bee.todoCalls).toHaveLength(1);
    } finally {
      unlock(locked);
    }
  });

  it("deliverOne gets past the same leftover", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    const locked = lockOldRun(rig, idea.id);
    try {
      expect(await deliverOne(idea.id, rig.deps)).toMatchObject({ ok: true });
    } finally {
      unlock(locked);
    }
  });

  it("clears out what earlier clean-ups had to leave behind under tmp/deliver", async () => {
    const rig = makeRig();
    const idea = rig.idea("built");
    mkdirSync(path.join(rig.paths.deliverRuns, ".gone-idea_old-abc-12345678", "app"), { recursive: true });
    mkdirSync(path.join(rig.paths.deliverRuns, "idea_of_another_day", "run-1", "logs"), { recursive: true });
    await runDeliver(rig.deps);
    expect(rig.store.getIdea(idea.id)?.state).toBe("delivered");
    // Only the leftovers go; another idea's kept logs are not ours to clear here.
    expect(readdirSync(rig.paths.deliverRuns)).toEqual(["idea_of_another_day"]);
  });
});

describe("runDeliver: being stopped", () => {
  const stopReason = (rig: ReturnType<typeof makeRig>) => rig.logLines.join("\n");

  it("hands the stop signal to the verifier and the publisher", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    rig.idea("built");
    await runDeliver({ ...rig.deps, signal: stop.signal });
    expect(rig.verifier.calls[0]?.signal).toBe(stop.signal);
    expect(rig.publisher.calls[0]?.signal).toBe(stop.signal);
  });

  it("does nothing at all when the signal has already fired", async () => {
    const stop = new AbortController();
    stop.abort();
    const rig = makeRig();
    const built = rig.idea("built");
    const published = rig.idea("published");
    const failed = rig.idea("build_failed");

    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toEqual({ delivered: [], failed: [], notified: [], stopped: true });

    expect(rig.verifier.calls).toEqual([]);
    expect(rig.publisher.calls).toEqual([]);
    expect(rig.bee.todoCalls).toEqual([]);
    expect(rig.store.getIdea(built.id)).toMatchObject({ state: "built", note: null });
    expect(rig.store.getIdea(published.id)).toMatchObject({ state: "published", note: null });
    expect(rig.store.getIdea(failed.id)?.failureNotifiedAt).toBeNull();
  });

  it("stopped during verification: the idea stays built with no verdict, nothing is published or buzzed, the next idea is not started, and the next run delivers both", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const first = rig.idea("built");
    const second = rig.idea("built", { title: "Marmalade tracker" });
    rig.verifier.onVerify = () => stop.abort();
    rig.verifier.results.push({ ok: false, reason: "Verification was stopped before it finished.", checks: { failedStep: "stopped" }, stopped: true });

    const summary = await runDeliver({ ...rig.deps, signal: stop.signal });

    // Not a failure: no verdict was reached.
    expect(summary).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
    expect(rig.verifier.calls).toHaveLength(1);
    expect(rig.publisher.calls).toEqual([]);
    expect(rig.bee.todoCalls).toEqual([]);
    for (const idea of [first, second]) expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", failureReason: null, failureNotifiedAt: null, note: null });
    expect(existsSync(reportPath(rig.paths, first.id))).toBe(false);
    expect(stopReason(rig)).toContain("stopped before a built app was published");

    // The next morning, without a stop: both go out, one to-do each.
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [first.id, second.id], failed: [], notified: [] });
    expect(rig.bee.todoCalls).toHaveLength(2);
  });

  it("a verification that came back complete just as we were stopped is not acted on", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.verifier.onVerify = () => stop.abort();
    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toMatchObject({ delivered: [], failed: [], stopped: true });
    expect(rig.publisher.calls).toEqual([]);
    expect(rig.store.getIdea(idea.id)?.state).toBe("built");
  });

  it("stopped after the push but before the link was confirmed: the idea says so, nobody is told, and the next run publishes again with a new marker and one to-do", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.onPublish = () => stop.abort();
    rig.publisher.results.push({ ok: false, reason: "Publishing was stopped before it finished.", stopped: true, pushed: true });

    const summary = await runDeliver({ ...rig.deps, signal: stop.signal });

    expect(summary).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
    // Never half-published without a record.
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", publishedUrl: null, note: PUSHED_UNCONFIRMED_NOTE, failureReason: null, failureNotifiedAt: null });
    expect(rig.bee.todoCalls).toEqual([]);

    // Run 2: verified again, published again (a new marker), recorded, and told exactly once.
    rig.clock.advance(24 * HOUR);
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.verifier.calls).toHaveLength(2);
    expect(rig.publisher.calls).toHaveLength(2);
    expect(rig.publisher.calls[1]?.marker).not.toBe(rig.publisher.calls[0]?.marker);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", note: null, morningTodoId: 7001 });
    expect(rig.bee.todoCalls.map((call) => call.text)).toEqual([`☀️ Built overnight: ${TITLE} → https://made-up-owner.github.io/overnight-apps/${idea.slug}/`]);

    // Run 3: nothing more.
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [] });
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("stopped before the push: no note, no verdict", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.onPublish = () => stop.abort();
    rig.publisher.results.push({ ok: false, reason: "Publishing was stopped before it finished.", stopped: true });
    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toMatchObject({ failed: [], stopped: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", note: null, failureReason: null });
  });

  it("a publisher that reports a real failure just as we are stopped does not get the idea marked as failed", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.onPublish = () => stop.abort();
    rig.publisher.results.push({ ok: false, reason: "Could not push the new version to GitHub." });
    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toMatchObject({ failed: [], notified: [], stopped: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", failureReason: null });
    expect(rig.bee.todoCalls).toEqual([]);
  });

  it("a page that went live just as we were stopped is recorded as published; the to-do waits for the next run", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.publisher.onPublish = () => stop.abort();

    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "published", publishedUrl: `https://made-up-owner.github.io/overnight-apps/${idea.slug}/`, note: null });
    expect(rig.bee.todoCalls).toEqual([]);

    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.publisher.calls).toHaveLength(1);
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("stopped while Bee is being asked for the to-do, and Bee does not answer in time: returns anyway, and no later run asks a second time", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    let letBeeAnswer: () => void = () => {};
    rig.bee.todoGate = new Promise((resolve) => (letBeeAnswer = resolve));
    rig.bee.onCreateTodo = () => stop.abort();
    const started = Date.now();

    const summary = await runDeliver({ ...rig.deps, signal: stop.signal, stopGraceMs: 40 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(summary).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
    // The mark stays: a to-do may exist.
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "published", note: ANNOUNCING_NOTE, morningTodoId: null });

    // Bee's answer arrives after we have gone: it changes nothing.
    letBeeAnswer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "published", note: ANNOUNCING_NOTE });

    rig.bee.todoGate = null;
    rig.bee.onCreateTodo = () => {};
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [idea.id], failed: [], notified: [] });
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", morningTodoId: null });
  });

  it("stopped while Bee is being asked, and Bee answers within the grace period: the to-do is recorded, the fact is skipped", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.bee.todoGate = new Promise((resolve) => setTimeout(resolve, 30));
    rig.bee.onCreateTodo = () => stop.abort();

    const summary = await runDeliver({ ...rig.deps, signal: stop.signal, stopGraceMs: 2_000 });

    expect(summary).toEqual({ delivered: [idea.id], failed: [], notified: [], stopped: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", morningTodoId: 7001, factId: null });
    expect(rig.bee.factCalls).toEqual([]);
  });

  it("stopped while the 🌙 to-do is being created with no answer: the time stays recorded, so nobody is buzzed twice", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("build_failed");
    rig.bee.todoGate = new Promise(() => {});
    rig.bee.onCreateTodo = () => stop.abort();

    expect(await runDeliver({ ...rig.deps, signal: stop.signal, stopGraceMs: 30 })).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
    expect(rig.store.getIdea(idea.id)?.failureNotifiedAt).toBe(T_0630);

    rig.bee.todoGate = null;
    rig.bee.onCreateTodo = () => {};
    expect(await runDeliver(rig.deps)).toEqual({ delivered: [], failed: [], notified: [] });
    expect(rig.bee.todoCalls).toHaveLength(1);
  });

  it("stopped while Bee keeps refusing: stops trying, takes the mark off, and a later run asks again", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("published");
    rig.bee.todoErrors.push(refused(), refused(), refused());
    rig.bee.onCreateTodo = () => stop.abort();

    expect(await runDeliver({ ...rig.deps, signal: stop.signal })).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
    expect(rig.bee.todoCalls).toHaveLength(1);
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "published", note: null });

    rig.bee.todoErrors.length = 0;
    rig.bee.onCreateTodo = () => {};
    expect((await runDeliver(rig.deps)).delivered).toEqual([idea.id]);
  });

  it("answers within ten seconds of the stop signal even when the step in progress ignores it, and what that step does later changes nothing", async () => {
    vi.useFakeTimers();
    try {
      const stop = new AbortController();
      const rig = makeRig();
      const idea = rig.idea("built");
      let letVerifierFinish: () => void = () => {};
      rig.verifier.onVerify = () => new Promise<void>((resolve) => (letVerifierFinish = resolve));

      let answered: Awaited<ReturnType<typeof runDeliver>> | null = null;
      const running = runDeliver({ ...rig.deps, signal: stop.signal }).then((summary) => (answered = summary));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(answered).toBeNull();

      stop.abort();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(answered).toBeNull();
      await vi.advanceTimersByTimeAsync(999);
      await running;
      expect(answered).toEqual({ delivered: [], failed: [], notified: [], stopped: true });
      expect(rig.logLines.join("\n")).toContain("deliver did not stop in time");

      // The verifier finally returns, with a pass. Nothing is published or recorded any more.
      letVerifierFinish();
      await vi.advanceTimersByTimeAsync(100);
      expect(rig.publisher.calls).toEqual([]);
      expect(rig.bee.todoCalls).toEqual([]);
      expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", note: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a stop signal nothing is marked as stopped", async () => {
    const rig = makeRig();
    rig.idea("built");
    expect(await runDeliver(rig.deps)).not.toHaveProperty("stopped");
  });
});

describe("deliverOne: being stopped", () => {
  it("says it was stopped, not that the app failed, and leaves the idea for the next try", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("built");
    rig.verifier.onVerify = () => stop.abort();
    rig.verifier.results.push({ ok: false, reason: "Verification was stopped before it finished.", checks: {}, stopped: true });

    expect(await deliverOne(idea.id, { ...rig.deps, signal: stop.signal })).toEqual({ ok: false, reason: DELIVER_STOPPED_REASON, stopped: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "built", failureReason: null });
    expect(rig.bee.todoCalls).toEqual([]);

    expect(await deliverOne(idea.id, rig.deps)).toMatchObject({ ok: true });
  });

  it("a publish_failed idea that is stopped mid-retry keeps its old reason and gets no second 🌙 to-do", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("publish_failed");
    rig.publisher.onPublish = () => stop.abort();
    rig.publisher.results.push({ ok: false, reason: "Publishing was stopped before it finished.", stopped: true, pushed: true });

    expect(await deliverOne(idea.id, { ...rig.deps, signal: stop.signal })).toEqual({ ok: false, reason: DELIVER_STOPPED_REASON, stopped: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "publish_failed", failureReason: "The app's build command (npm run build) failed.", note: PUSHED_UNCONFIRMED_NOTE });
    expect(rig.bee.todoCalls).toEqual([]);

    // Tried again by id: published, the stale note gone.
    expect(await deliverOne(idea.id, rig.deps)).toMatchObject({ ok: true });
    expect(rig.store.getIdea(idea.id)).toMatchObject({ state: "delivered", failureReason: null, note: null });
  });

  it("stopped with the to-do still out: says so and gives the link", async () => {
    const stop = new AbortController();
    const rig = makeRig();
    const idea = rig.idea("published");
    rig.bee.todoGate = new Promise(() => {});
    rig.bee.onCreateTodo = () => stop.abort();
    expect(await deliverOne(idea.id, { ...rig.deps, signal: stop.signal, stopGraceMs: 30 })).toEqual({ ok: false, url: idea.publishedUrl, reason: DELIVER_STOPPED_REASON, stopped: true });
  });

  it("an idea that is already delivered is still answered when stopped: there is nothing left to do", async () => {
    const stop = new AbortController();
    stop.abort();
    const rig = makeRig();
    const delivered = rig.idea("delivered");
    const built = rig.idea("built");
    expect(await deliverOne(delivered.id, { ...rig.deps, signal: stop.signal })).toEqual({ ok: true, url: delivered.publishedUrl });
    expect(await deliverOne(built.id, { ...rig.deps, signal: stop.signal })).toEqual({ ok: false, reason: DELIVER_STOPPED_REASON, stopped: true });
    expect(rig.verifier.calls).toEqual([]);
  });
});
