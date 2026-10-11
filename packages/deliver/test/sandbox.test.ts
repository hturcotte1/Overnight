// Synthetic test data: every path in this file is made up.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sandboxCommand, sandboxEnv, SandboxSetupError } from "../src/sandbox.ts";
import type { SandboxPlaces } from "../src/sandbox.ts";

const places: SandboxPlaces = {
  home: "/Users/made-up",
  dataDir: "/Users/made-up/.overnight",
  workspace: "/Users/made-up/.overnight/tmp/deliver/idea_1/app",
  runDir: "/Users/made-up/.overnight/tmp/deliver/idea_1/scratch",
  siteDir: "/Users/made-up/.overnight/tmp/deliver/idea_1/site",
  harnessDir: "/Users/made-up/.overnight/tmp/deliver/idea_1/harness",
  nodeDir: "/Users/made-up/.local/node-v24",
  toolsDir: "/Users/made-up/repo/node_modules",
  browsersDir: "/Users/made-up/Library/Caches/ms-playwright",
  npmCache: "/Users/made-up/.npm",
};
const PROFILE = "/Users/made-up/repo/packages/deliver/sandbox/deliver.sb";

describe("sandboxCommand", () => {
  it("builds sandbox-exec with every folder, both ports, the profile, then the command", () => {
    const { command, args } = sandboxCommand(PROFILE, places, { port: 50123, proxyPort: null }, ["/Users/made-up/.local/node-v24/bin/npm", "run", "build"]);
    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual([
      "-D",
      "HOME=/Users/made-up",
      "-D",
      "DATA_DIR=/Users/made-up/.overnight",
      "-D",
      "WORKSPACE=/Users/made-up/.overnight/tmp/deliver/idea_1/app",
      "-D",
      "RUN_DIR=/Users/made-up/.overnight/tmp/deliver/idea_1/scratch",
      "-D",
      "SITE_DIR=/Users/made-up/.overnight/tmp/deliver/idea_1/site",
      "-D",
      "HARNESS_DIR=/Users/made-up/.overnight/tmp/deliver/idea_1/harness",
      "-D",
      "NODE_DIR=/Users/made-up/.local/node-v24",
      "-D",
      "TOOLS_DIR=/Users/made-up/repo/node_modules",
      "-D",
      "PW_BROWSERS=/Users/made-up/Library/Caches/ms-playwright",
      "-D",
      "NPM_CACHE=/Users/made-up/.npm",
      "-D",
      "PORT=50123",
      "-D",
      "PROXY_PORT=1",
      "-f",
      PROFILE,
      "/Users/made-up/.local/node-v24/bin/npm",
      "run",
      "build",
    ]);
  });

  it("gives the profile every value it asks for, so it can never start half-configured", () => {
    const profile = readFileSync(fileURLToPath(new URL("../sandbox/deliver.sb", import.meta.url)), "utf8");
    const wanted = new Set([...profile.matchAll(/\(param "([A-Z_]+)"\)/g)].map((match) => match[1]));
    const { args } = sandboxCommand(PROFILE, places, { port: null, proxyPort: null }, ["/bin/echo"]);
    const given = new Set(args.filter((arg) => /^[A-Z_]+=/.test(arg)).map((arg) => arg.split("=")[0]));
    expect([...given].sort()).toEqual([...wanted].sort());
  });

  it("refuses paths that are not full, tidy paths", () => {
    for (const bad of ["relative/path", "/Users/made-up/app/", "/Users/made-up/../other", "/Users/made-up/a\nb", ""]) {
      expect(() => sandboxCommand(PROFILE, { ...places, workspace: bad }, { port: null, proxyPort: null }, ["/bin/echo"]), JSON.stringify(bad)).toThrow(SandboxSetupError);
    }
  });

  it("refuses to make the data folder, the home folder or anything above them writable", () => {
    for (const writable of ["/Users/made-up/.overnight", "/Users/made-up", "/Users", "/"]) {
      expect(() => sandboxCommand(PROFILE, { ...places, workspace: writable }, { port: null, proxyPort: null }, ["/bin/echo"]), writable).toThrow(SandboxSetupError);
      expect(() => sandboxCommand(PROFILE, { ...places, runDir: writable }, { port: null, proxyPort: null }, ["/bin/echo"]), writable).toThrow(SandboxSetupError);
    }
  });

  it("refuses ports that are not ordinary local ports, and an empty command", () => {
    for (const port of [0, 80, 1023, 65536, 3.5, Number.NaN]) {
      expect(() => sandboxCommand(PROFILE, places, { port, proxyPort: null }, ["/bin/echo"]), String(port)).toThrow(SandboxSetupError);
      expect(() => sandboxCommand(PROFILE, places, { port: null, proxyPort: port }, ["/bin/echo"]), String(port)).toThrow(SandboxSetupError);
    }
    expect(() => sandboxCommand(PROFILE, places, { port: null, proxyPort: null }, [])).toThrow(SandboxSetupError);
  });
});

describe("sandboxEnv", () => {
  it("is a short fixed list: nothing of ours is inherited", () => {
    process.env.OVERNIGHT_MADE_UP_SECRET = "made-up-token";
    try {
      const env = sandboxEnv(places, { SHOT_DIR: "/x" });
      expect(env).toEqual({
        HOME: "/Users/made-up",
        PATH: "/Users/made-up/.local/node-v24/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: "/Users/made-up/.overnight/tmp/deliver/idea_1/scratch/tmp",
        NO_COLOR: "1",
        PLAYWRIGHT_BROWSERS_PATH: "/Users/made-up/Library/Caches/ms-playwright",
        npm_config_cache: "/Users/made-up/.npm",
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        SHOT_DIR: "/x",
      });
    } finally {
      delete process.env.OVERNIGHT_MADE_UP_SECRET;
    }
  });
});

describe("the files we ship for the sandbox", () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  /** A profile's rules without its comments. */
  const rules = (text: string) =>
    text
      .split("\n")
      .map((line) => line.replace(/;;.*$/, "").trim())
      .filter(Boolean)
      .join("\n");

  it("the profile keeps its walls: no services, no network but two local ports, no writing outside two folders", () => {
    const profile = rules(read("../sandbox/deliver.sb"));
    for (const rule of ["(deny lsopen)", "(deny appleevent-send)", "(deny job-creation)", "(deny mach-lookup)", "(deny network*)", "(deny file-write*)", "(deny signal)"]) expect(profile, rule).toContain(rule);
    expect(profile).toContain('(deny file-read*\n(subpath home)\n(subpath data-dir)\n(subpath node-dir)\n(literal "/Users")');
    expect(profile).toContain("(deny process-exec*\n(subpath home)\n(subpath data-dir)\n(subpath node-dir))");
    // The only things it may write, and the only service it may look up.
    expect(profile).toMatch(/\(allow file-write\*\n\(subpath workspace\)\n\(subpath run-dir\)\n\(literal "\/dev\/null"\)/);
    expect([...profile.matchAll(/\(allow mach-lookup\n(.*)\)/g)].map((match) => match[1])).toEqual(['(global-name-regex #"^org\\.chromium\\.Chromium\\.MachPortRendezvousServer\\.[0-9]+$")']);
    // Network rules name "localhost" and a port from a parameter, never "*".
    expect(profile).not.toMatch(/remote ip "\*|local ip "\*/);
    // Of our node_modules only Playwright is readable, and of the npm cache only the package store.
    expect(profile).not.toContain("(subpath tools-dir)");
    expect(profile).not.toContain("(subpath npm-cache)");
    expect(profile).toContain('(subpath (string-append npm-cache "/_cacache"))');
    // Programs in the home folder cannot be started, only those in the folders the run needs. Of
    // the Node install that is node, npm and npx: whatever else is installed there (the Bee
    // program, on this Mac) can be neither read nor run.
    const nodeParts = '(literal (node-path "/bin/node"))\n(literal (node-path "/bin/npm"))\n(literal (node-path "/bin/npx"))\n(subpath (node-path "/lib/node_modules/npm"))\n(subpath (node-path "/lib/node_modules/corepack"))';
    expect(profile).toContain(`(allow process-exec*\n(subpath workspace)\n(subpath run-dir)\n${nodeParts}\n(subpath pw-browsers))`);
    expect(profile).toContain(`(allow file-read*\n(subpath workspace)\n(subpath run-dir)\n(subpath site-dir)\n(subpath harness-dir)\n${nodeParts}\n(subpath (node-path "/include"))`);
    expect(profile).not.toMatch(/\(allow[^)]*\n\(subpath node-dir\)/);
    expect(profile).not.toContain("(allow-traverse node-dir)");
  });

  it("other programs' command lines and the process table are denied by name PREFIX: the exact-name rule matched nothing", () => {
    // sandbox-real.test.ts shows what each form really does. This one also runs where the macOS
    // sandbox cannot be started, so the rule cannot quietly go back to the form that did nothing.
    const profile = rules(read("../sandbox/deliver.sb"));
    // Command lines, and the process table (kern.proc.all, kern.proc.pid.<id> and their relatives).
    expect(profile).toContain('(deny sysctl-read\n(sysctl-name-prefix "kern.procargs")\n(sysctl-name-prefix "kern.proc."))');
    expect(profile).not.toMatch(/\(sysctl-name "kern\.proc/);
    expect(profile).not.toMatch(/\(allow sysctl/);
    expect(profile).toContain("(deny process-info*)\n(allow process-info* (target same-sandbox))");
    // pgrep reads command lines through a system service: no lookup of it may ever be allowed.
    expect(profile).not.toContain("sysmond");
  });

  it("the two harness folders are split: ours alone for the contract test, the app's tests only next to the smoke settings", () => {
    const verifier = read("../src/verifier.ts");
    expect(verifier).toContain('const CONTRACT_HARNESS_FILES = ["static-server.ts", "serve-and-test.ts", "contract.spec.ts", "contract.config.ts"] as const;');
    expect(verifier).toContain('const SMOKE_HARNESS_FILES = ["static-server.ts", "serve-and-test.ts", "app-smoke.config.ts"] as const;');
  });

  it("our Playwright settings never switch Chromium's own sandbox on and never pick a channel", () => {
    for (const file of ["../src/harness/contract.config.ts", "../src/harness/app-smoke.config.ts"]) {
      const code = read(file)
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(code, file).not.toMatch(/chromiumSandbox|channel|webServer|launchOptions/);
      expect(code, file).toContain("headless: true");
    }
  });

  it("the harness imports nothing but Node, Playwright and itself, because nothing else is readable in the sandbox", () => {
    for (const file of ["static-server.ts", "serve-and-test.ts", "contract.spec.ts", "contract.config.ts", "app-smoke.config.ts"]) {
      const imports = [...read(`../src/harness/${file}`).matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const name of imports) expect(name.startsWith("node:") || name === "@playwright/test" || name.startsWith("./"), `${file} imports ${name}`).toBe(true);
    }
  });
});
