import { describe, expect, it } from "vitest";
import { BUILD_INTERRUPTED_REASON, BUILD_STOPPED_REASON, isBuildAwaitingRetry, MAX_BUILD_STARTS } from "../src/index.ts";

const failed = (failureReason: string | null, failureNotifiedAt: string | null = null) => ({ state: "build_failed" as const, failureReason, failureNotifiedAt });

describe("isBuildAwaitingRetry", () => {
  it("is true for a build that was stopped or cut off, once", () => {
    expect(isBuildAwaitingRetry(failed(BUILD_STOPPED_REASON), 1)).toBe(true);
    expect(isBuildAwaitingRetry(failed(BUILD_INTERRUPTED_REASON), 1)).toBe(true);
  });

  it("is false once the idea has used up its starts", () => {
    expect(MAX_BUILD_STARTS).toBe(2);
    expect(isBuildAwaitingRetry(failed(BUILD_STOPPED_REASON), MAX_BUILD_STARTS)).toBe(false);
    expect(isBuildAwaitingRetry(failed(BUILD_INTERRUPTED_REASON), MAX_BUILD_STARTS + 1)).toBe(false);
  });

  it("is false for a build that really failed, whatever the count", () => {
    expect(isBuildAwaitingRetry(failed("the build ran past its time limit of 45 minutes"), 1)).toBe(false);
    expect(isBuildAwaitingRetry(failed(null), 1)).toBe(false);
  });

  it("is false once the wearer has been told", () => {
    expect(isBuildAwaitingRetry(failed(BUILD_STOPPED_REASON, "2026-10-11T13:00:00.000Z"), 1)).toBe(false);
  });

  it("is false in any other state", () => {
    expect(isBuildAwaitingRetry({ state: "publish_failed", failureReason: BUILD_STOPPED_REASON, failureNotifiedAt: null }, 1)).toBe(false);
    expect(isBuildAwaitingRetry({ state: "approved", failureReason: null, failureNotifiedAt: null }, 0)).toBe(false);
  });
});
