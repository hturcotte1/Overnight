import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { ConfigError, DASHBOARD_PORT, HIGHEST_BUILD_CREDIT_LIMIT, dataPaths, ensureDataDirs, parseConfig } from "../src/index.ts";

describe("config", () => {
  it("uses the spec defaults when nothing is set", () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      dataDir: path.join(homedir(), ".overnight"),
      githubPagesRepo: "overnight-apps",
      timeZone: "America/Boise",
      askCutoff: "23:00",
      buildTime: "01:00",
      deliverTime: "07:00",
      maxAsksPerDay: 3,
      maxBuildsPerNight: 2,
      buildTimeoutMin: 45,
      maxBuildCreditsPerMonth: 400,
      writeBeeFacts: true,
      buildBackend: "kiro-crew",
      buildSandbox: "overnight",
      pausedByDefault: true,
    });
  });

  it("treats blank values as unset", () => {
    expect(parseConfig({ OVERNIGHT_DATA_DIR: "", MAX_ASKS_PER_DAY: " " }).maxAsksPerDay).toBe(3);
  });

  it("reads overrides", () => {
    const config = parseConfig({ OVERNIGHT_DATA_DIR: "~/somewhere", MAX_ASKS_PER_DAY: "1", PAUSED: "false", ASK_CUTOFF: "22:30" });
    expect(config.dataDir).toBe(path.join(homedir(), "somewhere"));
    expect(config.maxAsksPerDay).toBe(1);
    expect(config.pausedByDefault).toBe(false);
    expect(config.askCutoff).toBe("22:30");
  });

  it("names the bad setting", () => {
    expect(() => parseConfig({ ASK_CUTOFF: "11pm" })).toThrow(ConfigError);
    expect(() => parseConfig({ ASK_CUTOFF: "11pm" })).toThrow("ASK_CUTOFF");
    expect(() => parseConfig({ MAX_ASKS_PER_DAY: "many" })).toThrow("MAX_ASKS_PER_DAY");
    expect(() => parseConfig({ TZ: "Mars/Olympus" })).toThrow("TZ");
    expect(() => parseConfig({ PAUSED: "yes" })).toThrow("PAUSED");
    expect(() => parseConfig({ BUILD_SANDBOX: "none" })).toThrow("BUILD_SANDBOX");
  });

  it("reads the monthly ceiling on build credits, where 0 means never build", () => {
    expect(parseConfig({}).maxBuildCreditsPerMonth).toBe(400);
    expect(parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: "" }).maxBuildCreditsPerMonth).toBe(400);
    expect(parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: "0" }).maxBuildCreditsPerMonth).toBe(0);
    expect(parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: "1" }).maxBuildCreditsPerMonth).toBe(1);
    expect(parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: "100000" }).maxBuildCreditsPerMonth).toBe(100_000);
    for (const bad of ["abc", "-1", "1.5", "100001", "400 credits"]) {
      expect(() => parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: bad }), bad).toThrow(ConfigError);
      expect(() => parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: bad }), bad).toThrow("MAX_BUILD_CREDITS_PER_MONTH");
    }
  });

  it("has one number for the highest ceiling, the one the ledger of build credits goes by too", () => {
    expect(parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: String(HIGHEST_BUILD_CREDIT_LIMIT) }).maxBuildCreditsPerMonth).toBe(HIGHEST_BUILD_CREDIT_LIMIT);
    expect(() => parseConfig({ MAX_BUILD_CREDITS_PER_MONTH: String(HIGHEST_BUILD_CREDIT_LIMIT + 1) })).toThrow("MAX_BUILD_CREDITS_PER_MONTH");
  });

  it("has one port for the dashboard", () => {
    expect(DASHBOARD_PORT).toBe(4321);
  });

  it("refuses a data folder that is not a full path", () => {
    expect(() => parseConfig({ OVERNIGHT_DATA_DIR: "overnight-data" })).toThrow("OVERNIGHT_DATA_DIR");
    expect(() => parseConfig({ OVERNIGHT_DATA_DIR: "./data" })).toThrow(ConfigError);
    expect(parseConfig({ OVERNIGHT_DATA_DIR: "/tmp/overnight-x" }).dataDir).toBe("/tmp/overnight-x");
  });

  it("keeps every data path under the data folder", () => {
    const paths = dataPaths("/tmp/overnight-test");
    for (const value of Object.values(paths)) expect(value.startsWith("/tmp/overnight-test")).toBe(true);
  });

  it("makes the data folders private even when they already existed with open permissions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "overnight-paths-"));
    try {
      const paths = dataPaths(path.join(root, "data"));
      mkdirSync(paths.logs, { recursive: true, mode: 0o755 });
      ensureDataDirs(paths);
      for (const dir of [paths.root, paths.logs, paths.ideas]) expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
