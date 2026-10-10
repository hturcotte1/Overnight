import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, dataPaths, parseConfig } from "../src/index.ts";

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
      writeBeeFacts: true,
      pausedByDefault: false,
    });
  });

  it("treats blank values as unset", () => {
    expect(parseConfig({ OVERNIGHT_DATA_DIR: "", MAX_ASKS_PER_DAY: " " }).maxAsksPerDay).toBe(3);
  });

  it("reads overrides", () => {
    const config = parseConfig({ OVERNIGHT_DATA_DIR: "~/somewhere", MAX_ASKS_PER_DAY: "1", PAUSED: "true", ASK_CUTOFF: "22:30" });
    expect(config.dataDir).toBe(path.join(homedir(), "somewhere"));
    expect(config.maxAsksPerDay).toBe(1);
    expect(config.pausedByDefault).toBe(true);
    expect(config.askCutoff).toBe("22:30");
  });

  it("names the bad setting", () => {
    expect(() => parseConfig({ ASK_CUTOFF: "11pm" })).toThrow(ConfigError);
    expect(() => parseConfig({ ASK_CUTOFF: "11pm" })).toThrow("ASK_CUTOFF");
    expect(() => parseConfig({ MAX_ASKS_PER_DAY: "many" })).toThrow("MAX_ASKS_PER_DAY");
    expect(() => parseConfig({ TZ: "Mars/Olympus" })).toThrow("TZ");
    expect(() => parseConfig({ PAUSED: "yes" })).toThrow("PAUSED");
  });

  it("keeps every data path under the data folder", () => {
    const paths = dataPaths("/tmp/overnight-test");
    for (const value of Object.values(paths)) expect(value.startsWith("/tmp/overnight-test")).toBe(true);
  });
});
