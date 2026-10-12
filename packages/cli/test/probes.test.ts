// How preflight and status really ask their questions of this Mac. Everything here is made up
// for the tests: the home folder is a scratch folder, the programs are stand-ins (a recorded fake,
// or /bin/sh running one line), and the only network call goes to a server this file starts on
// this Mac and stops again. No Bee, Kiro, Kiro Crew or GitHub call is made.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELIVER_LEAD_MINUTES as CORE_DELIVER_LEAD_MINUTES } from "@overnight/core";
import {
  DELIVER_LEAD_MINUTES,
  installedJobFolders,
  JOB_LABEL,
  jobSettingsFile,
  jobsBelongHere,
  NIGHT_JOB_LABELS,
  nightJobPath,
  readCrewJobSandbox,
  readJobDataDir,
  readJobTrigger,
  readJobTriggers,
  SANDBOX_EXEC,
} from "../src/background.ts";
import { repoRoot } from "../src/context.ts";
import { crewPort, DEFAULT_CREW_PORT, gatewayAnswers } from "../src/gateway.ts";
import { isOnline, ONLINE_CHECK_URL, ONLINE_TIMEOUT_MS } from "../src/online.ts";
import { parsePowerSource, readPowerSource } from "../src/power.ts";
import { realPreflightProbes } from "../src/preflight-probes.ts";
import type { ProbeParts } from "../src/preflight-probes.ts";
import { runQuiet } from "../src/run-quiet.ts";
import type { QuietOptions, QuietResult } from "../src/run-quiet.ts";
import { readSmallFile, sameText } from "../src/small-file.ts";

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "overnight probes "));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

describe("running a program for its answer only", () => {
  it("reports how the program ended, and reads nothing it printed unless asked", async () => {
    const quiet = await runQuiet("/bin/sh", ["-c", "echo someone@example.invalid; exit 3"], { env: ENV, timeoutMs: 10_000 });
    expect(quiet).toEqual({ started: true, exitCode: 3, timedOut: false, output: "" });

    const kept = await runQuiet("/bin/sh", ["-c", "echo made-up-name; echo and-this >&2"], { env: ENV, timeoutMs: 10_000, keepOutput: true });
    expect(kept).toMatchObject({ started: true, exitCode: 0, timedOut: false });
    expect(kept.output.split("\n").filter(Boolean).sort()).toEqual(["and-this", "made-up-name"]);
  });

  it("gives the program only the environment it is handed, and finds it by name on that PATH", async () => {
    const result = await runQuiet("sh", ["-c", 'echo "$HOME|$MADE_UP|$PATH"'], { env: { ...ENV, MADE_UP: "from the test" }, timeoutMs: 10_000, keepOutput: true });
    expect(result.output.trim()).toBe("|from the test|/usr/bin:/bin:/usr/sbin:/sbin");
    // Not on the PATH given: not started, whatever this process's own PATH holds.
    expect(await runQuiet("sh", ["-c", "exit 0"], { env: { PATH: path.join(scratch, "empty bin") }, timeoutMs: 10_000 })).toMatchObject({ started: false, exitCode: null });
    expect(await runQuiet(path.join(scratch, "no such program"), [], { env: ENV, timeoutMs: 10_000 })).toMatchObject({ started: false, exitCode: null, timedOut: false });
  });

  it("stops a program that runs past its time limit, and keeps only so much of what one prints", async () => {
    const slow = await runQuiet("/bin/sh", ["-c", "sleep 30"], { env: ENV, timeoutMs: 100 });
    expect(slow).toMatchObject({ started: true, timedOut: true });
    const loud = await runQuiet("/bin/sh", ["-c", "head -c 300000 /dev/zero | tr '\\0' x"], { env: ENV, timeoutMs: 10_000, keepOutput: true });
    expect(loud.output.length).toBe(64 * 1024);
  });
});

describe("reading a small file something else may have written", () => {
  it("reads a plain file, and refuses a missing one, a big one, a folder, a link and a named pipe without waiting", () => {
    const dir = path.join(scratch, "small files");
    mkdirSync(dir, { recursive: true });
    const plain = path.join(dir, "plain.txt");
    writeFileSync(plain, "made-up text\n");
    expect(readSmallFile(plain, 100)).toBe("made-up text\n");
    expect(readSmallFile(plain, 5)).toBeNull();
    expect(readSmallFile(path.join(dir, "missing.txt"), 100)).toBeNull();
    expect(readSmallFile(dir, 100)).toBeNull();

    // A link to a file that IS readable: still refused. The reader never follows one.
    const link = path.join(dir, "link.txt");
    symlinkSync(plain, link);
    expect(readSmallFile(link, 100)).toBeNull();

    // A named pipe with nobody writing: a plain read would wait for ever.
    const pipe = path.join(dir, "pipe");
    execFileSync("/usr/bin/mkfifo", [pipe], { timeout: 10_000 });
    const started = Date.now();
    expect(readSmallFile(pipe, 100)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("calls two texts the same whatever their line endings or blank ends", () => {
    expect(sameText("a\r\nb\n\n", "\na\nb")).toBe(true);
    expect(sameText("a\nb", "a\nB")).toBe(false);
  });
});

describe("is the Kiro Crew gateway there?", () => {
  it("looks where Kiro Crew listens: 5476, or KIROCREW_PORT when that is a port number", () => {
    expect(DEFAULT_CREW_PORT).toBe(5476);
    expect(crewPort({})).toBe(5476);
    expect(crewPort({ KIROCREW_PORT: "5478" })).toBe(5478);
    expect(crewPort({ KIROCREW_PORT: " 5478 " })).toBe(5478);
    for (const bad of ["", "0", "70000", "54 76", "port", "-1", "5476; rm"]) expect(crewPort({ KIROCREW_PORT: bad }), bad).toBe(5476);
    // The installer waits on the same port.
    expect(readFileSync(path.join(repoRoot(), "scripts", "install-agents.sh"), "utf8")).toContain(`CREW_PORT=${DEFAULT_CREW_PORT}\n`);
  });

  it("says yes when anything answers on this Mac at that port, whatever it answers, and asks only the health page", async () => {
    for (const status of [200, 401, 500]) {
      const asked: string[] = [];
      const server = createServer((request, response) => {
        asked.push(`${request.method} ${request.url} from ${request.socket.remoteAddress}`);
        response.writeHead(status, { "content-type": "text/plain" });
        response.end("made-up body that is never read");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        expect(await gatewayAnswers({ port }), String(status)).toBe(true);
        expect(asked).toEqual(["GET /api/health from 127.0.0.1"]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      // Nothing listens there any more.
      expect(await gatewayAnswers({ port, timeoutMs: 2_000 })).toBe(false);
    }
  });

  it("says no, and does not throw, when nothing answers in time", async () => {
    const neverAnswers: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("made-up: timed out"))));
    const started = Date.now();
    expect(await gatewayAnswers({ port: 5478, timeoutMs: 50, fetchFn: neverAnswers })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);

    const urls: string[] = [];
    const answering: typeof fetch = async (url) => (urls.push(String(url)), new Response("ok"));
    expect(await gatewayAnswers({ port: 5478, fetchFn: answering })).toBe(true);
    expect(urls).toEqual(["http://127.0.0.1:5478/api/health"]);
  });
});

describe("what the installed background jobs say", () => {
  const plist = (first: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.overnight.crew</string>\n\n  <key>ProgramArguments</key>\n  <array>\n    <string>${first}</string>\n    <string>gateway</string>\n  </array>\n</dict>\n</plist>\n`;
  const homeWith = (name: string, content: string | null) => {
    const home = path.join(scratch, name);
    mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    if (content !== null) writeFileSync(jobSettingsFile(home, NIGHT_JOB_LABELS.crew), content);
    return home;
  };

  it("tells a gateway job that starts inside Overnight's sandbox from one that starts the gateway bare", () => {
    expect(SANDBOX_EXEC).toBe("/usr/bin/sandbox-exec");
    expect(readCrewJobSandbox(homeWith("home overnight", plist("/usr/bin/sandbox-exec")))).toBe("overnight");
    expect(readCrewJobSandbox(homeWith("home crew", plist("/Users/someone/.local/bin/kirocrew")))).toBe("crew");
    // A program merely named like it, somewhere else, is not the sandbox.
    expect(readCrewJobSandbox(homeWith("home lookalike", plist("/Users/someone/bin/sandbox-exec")))).toBe("crew");
    expect(readCrewJobSandbox(homeWith("home none", null))).toBeNull();
    expect(readCrewJobSandbox(homeWith("home junk", "not a settings file"))).toBeNull();
  });

  it("reads the mode from a settings file exactly as the installer writes one", () => {
    // The real template, filled in by the real installer function (nothing is installed).
    const render = (home: string, ...command: string[]) =>
      execFileSync("/bin/bash", ["-c", 'source "$1"; shift; render_plist crew "$@"', "bash", path.join(repoRoot(), "scripts", "install-agents.sh"), "/n/bin/node", "/r", "/d", home, ...command], {
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home },
      });
    const sandboxed = homeWith("home rendered overnight", null);
    writeFileSync(jobSettingsFile(sandboxed, NIGHT_JOB_LABELS.crew), render(sandboxed, "/usr/bin/sandbox-exec", "-f", "/r/profile.sb", "-D", "HOME=/h", "/h/kirocrew", "gateway"));
    expect(readCrewJobSandbox(sandboxed)).toBe("overnight");
    const bare = homeWith("home rendered crew", null);
    writeFileSync(jobSettingsFile(bare, NIGHT_JOB_LABELS.crew), render(bare, "/h/kirocrew", "gateway"));
    expect(readCrewJobSandbox(bare)).toBe("crew");
  });

  it("knows the PATH the build and deliver jobs run with, and the deliver job's head start, as the templates and the installer have them", () => {
    expect(nightJobPath("/Users/someone", "/opt/node/bin")).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/node/bin:/Users/someone/.local/bin");
    for (const job of ["build", "deliver"]) {
      const template = readFileSync(path.join(repoRoot(), "launchd", `com.overnight.${job}.plist.template`), "utf8");
      expect(template, job).toContain(`<string>${nightJobPath("__HOME__", "__NODE_DIR__")}</string>`);
    }
    expect(DELIVER_LEAD_MINUTES).toBe(30);
    // One number, kept by the night clock in core and handed on from here.
    expect(DELIVER_LEAD_MINUTES).toBe(CORE_DELIVER_LEAD_MINUTES);
    expect(readFileSync(path.join(repoRoot(), "scripts", "install-agents.sh"), "utf8")).toContain(`DELIVER_LEAD_MINUTES=${DELIVER_LEAD_MINUTES}\n`);
  });

  /** A build or deliver settings file in the new shape: woken every minute, and at login. Made up, in the installer's layout. */
  const onTimer = (job: string, dataDir = "/made-up/data") =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Made up for the tests. This job used to have a <key>StartCalendarInterval</key> entry: macOS's
  calendar started it once a day. Now it is woken every minute and asks Overnight's own clock.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.overnight.${job}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/made-up/node</string>
    <string>/made-up/repo/packages/cli/src/main.ts</string>
    <string>${job}</string>
    <string>--if-due</string>
  </array>
  <!-- Every minute. Not a calendar time. -->
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${dataDir}/logs/${job}.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${dataDir}/logs/${job}.launchd.log</string>
</dict>
</plist>
`;
  /** The same job in the old shape, as Milestone 2 installed it: once a day, by macOS's calendar. */
  const onCalendar = (job: string, dataDir = "/made-up/data") =>
    onTimer(job, dataDir)
      .replace("    <string>--if-due</string>\n", "")
      .replace("  <!-- Every minute. Not a calendar time. -->\n  <key>StartInterval</key>\n  <integer>60</integer>\n  <key>RunAtLoad</key>\n  <true/>", "  <!-- Once a day. A <key>StartInterval</key> would be every so many seconds. -->\n  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>1</integer>\n    <key>Minute</key>\n    <integer>0</integer>\n  </dict>\n  <key>RunAtLoad</key>\n  <false/>");
  const install = (home: string, label: string, content: string) => {
    mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(jobSettingsFile(home, label), content);
  };

  it("tells a night job that is woken every minute from one still on macOS's calendar, and is not fooled by a word in a comment", () => {
    const home = homeWith("home triggers", null);
    expect(readJobTrigger("build", home)).toBeNull();
    expect(readJobTriggers(home)).toEqual({ build: null, deliver: null });

    install(home, NIGHT_JOB_LABELS.build, onTimer("build"));
    install(home, NIGHT_JOB_LABELS.deliver, onCalendar("deliver"));
    // Each of the two made-up files names the other way in a comment.
    expect(onTimer("build")).toContain("<key>StartCalendarInterval</key>");
    expect(onCalendar("deliver")).toContain("<key>StartInterval</key>");
    expect(onCalendar("deliver")).not.toContain("--if-due");
    expect(readJobTrigger("build", home)).toBe("timer");
    expect(readJobTrigger("deliver", home)).toBe("calendar");
    expect(readJobTriggers(home)).toEqual({ build: "timer", deliver: "calendar" });

    // Neither way, both ways, and nothing that can be read: never a guess.
    install(home, NIGHT_JOB_LABELS.build, "<plist><dict><key>Label</key><string>com.overnight.build</string></dict></plist>");
    expect(readJobTrigger("build", home)).toBeNull();
    install(home, NIGHT_JOB_LABELS.build, onTimer("build").replace("<key>RunAtLoad</key>", "<key>StartCalendarInterval</key><dict/>\n  <key>RunAtLoad</key>"));
    expect(readJobTrigger("build", home)).toBe("calendar");
    install(home, NIGHT_JOB_LABELS.build, `<!-- <key>StartInterval</key> -->\n<plist/>`);
    expect(readJobTrigger("build", home)).toBeNull();
    // A link where the settings file should be is not read through.
    const linked = homeWith("home linked trigger", null);
    writeFileSync(path.join(linked, "elsewhere.plist"), onTimer("build"));
    symlinkSync(path.join(linked, "elsewhere.plist"), jobSettingsFile(linked, NIGHT_JOB_LABELS.build));
    expect(readJobTrigger("build", linked)).toBeNull();
  });

  it("reads the trigger from the repo's own build and deliver templates, whichever way they are written today", () => {
    for (const job of ["build", "deliver"] as const) {
      const template = readFileSync(path.join(repoRoot(), "launchd", `com.overnight.${job}.plist.template`), "utf8");
      const home = homeWith(`home template ${job}`, null);
      install(home, NIGHT_JOB_LABELS[job], template);
      // Looked at by hand here, outside the comments: the reader must agree.
      const settings = template.replace(/<!--[\s\S]*?-->/g, "");
      const expected = settings.includes("<key>StartCalendarInterval</key>") ? "calendar" : settings.includes("<key>StartInterval</key>") ? "timer" : null;
      expect(expected, job).not.toBeNull();
      expect(readJobTrigger(job, home), job).toBe(expected);
    }
  });

  it("reads the data folder a job was installed for from where its settings file sends what the job prints", () => {
    const home = homeWith("home data dirs", null);
    expect(readJobDataDir(home)).toBeNull();
    expect(installedJobFolders(home)).toEqual([]);

    install(home, JOB_LABEL, onTimer("listen", "/Users/someone/.overnight"));
    // The listener's, unless another job's label is given.
    expect(readJobDataDir(home)).toBe("/Users/someone/.overnight");
    expect(readJobDataDir(home, NIGHT_JOB_LABELS.build)).toBeNull();
    install(home, NIGHT_JOB_LABELS.build, onTimer("build", "/Users/someone/other data"));
    install(home, NIGHT_JOB_LABELS.deliver, onCalendar("deliver", "/Users/someone/.overnight"));
    install(home, NIGHT_JOB_LABELS.crew, onTimer("crew", "/Users/someone/.overnight"));
    expect(readJobDataDir(home, NIGHT_JOB_LABELS.build)).toBe("/Users/someone/other data");
    // All four jobs, each folder once.
    expect(installedJobFolders(home)).toEqual(["/Users/someone/.overnight", "/Users/someone/other data"]);

    // Not a path of the shape the installer writes: no folder is made of it.
    const odd = (logPath: string) => {
      install(home, NIGHT_JOB_LABELS.build, onTimer("build").replace(/<key>StandardOutPath<\/key>\s*<string>[^<]*<\/string>/, `<key>StandardOutPath</key>\n  <string>${logPath}</string>`));
      return readJobDataDir(home, NIGHT_JOB_LABELS.build);
    };
    expect(odd("/Users/someone/.overnight/logs/build.launchd.log")).toBe("/Users/someone/.overnight");
    expect(odd("/Users/someone/.overnight/build.launchd.log")).toBeNull();
    expect(odd("/Users/someone/.overnight/Logs/build.launchd.log")).toBeNull();
    expect(odd("relative/logs/build.launchd.log")).toBeNull();
    expect(odd("/logs/build.launchd.log")).toBeNull();
    expect(odd("")).toBeNull();
    // Only the setting itself counts, not a mention of it in a comment.
    install(home, NIGHT_JOB_LABELS.build, "<!-- <key>StandardOutPath</key>\n<string>/made-up/commented/logs/x.log</string> -->\n<plist/>");
    expect(readJobDataDir(home, NIGHT_JOB_LABELS.build)).toBeNull();
  });

  it("reads a data folder with XML's reserved characters in its name exactly as the installer wrote it", () => {
    // The real listener template, filled in by the real installer function (nothing is installed).
    const dataDir = "/made-up/R&D <data> & more";
    const home = homeWith("home escaped", null);
    const rendered = execFileSync("/bin/bash", ["-c", 'source "$1"; shift; render_plist listen "$@"', "bash", path.join(repoRoot(), "scripts", "install-agents.sh"), "/n/bin/node", "/r", dataDir, home], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home },
    });
    expect(rendered).toContain("/made-up/R&amp;D &lt;data&gt; &amp; more/logs/listen.launchd.log");
    install(home, JOB_LABEL, rendered);
    expect(readJobDataDir(home)).toBe(dataDir);
    // "&amp;lt;" in the file is the text "&lt;" in the name, not a "<".
    install(home, JOB_LABEL, onTimer("listen", "/made-up/a&amp;lt;b"));
    expect(readJobDataDir(home)).toBe("/made-up/a&lt;b");
  });

  it("says whether the installed jobs work on a data folder: yes, no, or cannot tell", () => {
    const here = path.join(scratch, "jobs data here");
    const there = path.join(scratch, "jobs data there");
    mkdirSync(here, { recursive: true });
    mkdirSync(there, { recursive: true });
    const home = homeWith("home belong", null);
    // No job is installed: nothing to go by.
    expect(jobsBelongHere({ root: here }, home)).toBeNull();

    install(home, JOB_LABEL, onTimer("listen", there));
    install(home, NIGHT_JOB_LABELS.build, onTimer("build", there));
    expect(jobsBelongHere({ root: here }, home)).toBe(false);
    expect(jobsBelongHere({ root: there }, home)).toBe(true);
    // One of them is this folder's: yes.
    install(home, NIGHT_JOB_LABELS.deliver, onTimer("deliver", here));
    expect(jobsBelongHere({ root: here }, home)).toBe(true);

    // The same folder under another name is the same folder: through a link, and before it has been made.
    const link = path.join(scratch, "jobs data link");
    symlinkSync(there, link);
    expect(jobsBelongHere({ root: link }, home)).toBe(true);
    const fresh = homeWith("home belong fresh", null);
    install(fresh, JOB_LABEL, onTimer("listen", path.join(link, "not made yet")));
    expect(jobsBelongHere({ root: path.join(there, "not made yet") }, fresh)).toBe(true);
    expect(jobsBelongHere({ root: path.join(there, "another") }, fresh)).toBe(false);

    // A folder that cannot be looked at: cannot tell.
    const loop = path.join(scratch, "jobs data loop");
    symlinkSync(loop, loop);
    const looped = homeWith("home belong loop", null);
    install(looped, JOB_LABEL, onTimer("listen", path.join(loop, "data")));
    expect(jobsBelongHere({ root: here }, looped)).toBeNull();
  });
});

describe("is this Mac plugged in?", () => {
  it("reads the first line of pmset's answer: mains, battery, or neither", () => {
    // As printed on the Mac this was written on (the battery's id replaced by a made-up one).
    expect(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true\n")).toBe("mains");
    // The same Mac's line shape when it runs on its battery.
    expect(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t87%; discharging; 5:12 remaining present: true\n")).toBe("battery");
    // A Mac on a UPS, a line cut short, nothing, and something else entirely.
    for (const other of ["Now drawing from 'UPS Power'\n", "Now drawing from 'AC Pow", "", "pmset: command not found", "now drawing from 'ac power'"]) expect(parsePowerSource(other), other).toBe("unknown");
  });

  it("asks macOS's own pmset once, by its full path, with a bare environment and a short time limit", async () => {
    const calls: Array<{ command: string; args: string[]; options: QuietOptions }> = [];
    const answering = (result: Partial<QuietResult>): typeof runQuiet => async (command, args, options) => {
      calls.push({ command, args, options });
      return { started: true, exitCode: 0, timedOut: false, output: "", ...result };
    };
    expect(await readPowerSource(answering({ output: "Now drawing from 'Battery Power'\n" }))).toBe("battery");
    expect(calls).toEqual([{ command: "/usr/bin/pmset", args: ["-g", "ps"], options: { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeoutMs: 5_000, keepOutput: true } }]);
    expect(await readPowerSource(answering({ output: "Now drawing from 'AC Power'\n" }))).toBe("mains");
  });

  it("says it does not know, and never throws, when pmset will not start, fails, takes too long or says something else", async () => {
    const answering = (result: Partial<QuietResult>): typeof runQuiet => async () => ({ started: true, exitCode: 0, timedOut: false, output: "Now drawing from 'AC Power'\n", ...result });
    expect(await readPowerSource(answering({ started: false, exitCode: null }))).toBe("unknown");
    expect(await readPowerSource(answering({ exitCode: 1 }))).toBe("unknown");
    expect(await readPowerSource(answering({ timedOut: true, exitCode: null }))).toBe("unknown");
    expect(await readPowerSource(answering({ output: "made-up nonsense" }))).toBe("unknown");
    const throwing: typeof runQuiet = async () => {
      throw new Error("made-up: the runner fell over");
    };
    expect(await readPowerSource(throwing)).toBe("unknown");
  });

  it.runIf(process.platform === "darwin")("gets one of the three answers from the real pmset on this Mac", async () => {
    expect(["mains", "battery", "unknown"]).toContain(await readPowerSource());
  });
});

describe("is there real internet?", () => {
  it("asks GitHub once with a HEAD request that carries no login, and takes any answer at all as yes", async () => {
    expect(ONLINE_CHECK_URL).toBe("https://api.github.com/");
    expect(ONLINE_TIMEOUT_MS).toBe(5_000);
    for (const status of [200, 301, 403, 500]) {
      const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
      const fetchFn: typeof fetch = async (url, init) => {
        asked.push({ url: String(url), init });
        return new Response(null, { status });
      };
      expect(await isOnline({ fetchFn }), String(status)).toBe(true);
      expect(asked).toHaveLength(1);
      expect(asked[0]?.url).toBe("https://api.github.com/");
      expect(asked[0]?.init).toMatchObject({ method: "HEAD", redirect: "manual", credentials: "omit" });
      // Nothing of ours goes along: no header, no body.
      expect(asked[0]?.init?.headers).toBeUndefined();
      expect(asked[0]?.init?.body).toBeUndefined();
      expect(asked[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("says no, and does not throw, when the request fails or nothing answers in time", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await isOnline({ fetchFn: failing })).toBe(false);
    const neverAnswers: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("made-up: timed out"))));
    const started = Date.now();
    expect(await isOnline({ fetchFn: neverAnswers, timeoutMs: 50 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("with the real fetch: yes for a server on this Mac that answers, no for a port where nothing listens", async () => {
    // The real request, sent to a made-up server on this Mac in place of GitHub.
    const asked: string[] = [];
    const server = createServer((request, response) => {
      asked.push(`${request.method} ${request.url} cookie:${request.headers.cookie ?? "none"} auth:${request.headers.authorization ?? "none"}`);
      response.writeHead(403);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const toThisMac: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${port}/`, init);
    try {
      expect(await isOnline({ fetchFn: toThisMac })).toBe(true);
      expect(asked).toEqual(["HEAD / cookie:none auth:none"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await isOnline({ fetchFn: toThisMac, timeoutMs: 2_000 })).toBe(false);
  });
});

describe("preflight's questions, as really asked", () => {
  /** A recorded stand-in for runQuiet: answers by the program's name and first words. */
  function recorded(answers: Record<string, Partial<QuietResult>>) {
    const calls: Array<{ command: string; args: string[]; options: QuietOptions }> = [];
    const run: ProbeParts["run"] = async (command, args, options) => {
      calls.push({ command, args, options });
      const key = [path.basename(command), ...args].join(" ");
      const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
      return { started: true, exitCode: 0, timedOut: false, output: "", ...(match?.[1] ?? {}) };
    };
    return { run, calls };
  }

  function setUp(answers: Record<string, Partial<QuietResult>> = {}, overrides: Partial<ProbeParts> = {}) {
    const home = mkdtempSync(path.join(scratch, "home "));
    const crewHome = path.join(home, ".kiro", "crew");
    const ours = path.join(home, "build-skill.md");
    writeFileSync(ours, "---\nname: made-up-skill\n---\nBuild one made-up app.\n");
    const fake = recorded(answers);
    const parts: ProbeParts = {
      beeLoginState: async () => "logged-in",
      findKiroBinary: () => "/made-up/bin/kiro-cli",
      crewHome: () => crewHome,
      crewSettingsProblem: () => null,
      installedSkillFile: (dir) => path.join(dir, "skills", "overnight-build", "SKILL.md"),
      buildSkillFile: ours,
      sandboxProbe: async () => ({ ok: true }),
      buildRunning: () => false,
      nightJobRunning: () => false,
      gatewayProfileFile: path.join(home, "repo-crew-gateway.sb"),
      installedGatewayProfileFile: path.join(home, "data", "sandbox", "crew-gateway.sb"),
      run: fake.run,
      gatewayAnswers: async () => true,
      home,
      nodeDir: "/made-up/node/bin",
      browsersDir: path.join(home, "browsers"),
      ...overrides,
    };
    return { home, crewHome, ours, parts, calls: fake.calls, probes: realPreflightProbes(parts), installed: path.join(crewHome, "skills", "overnight-build", "SKILL.md") };
  }

  it("asks kiro-cli who is signed in, by its full path, and takes \"Not logged in\" or a bad exit as signed out", async () => {
    const signedIn = setUp({ "kiro-cli whoami": { output: "someone@example.invalid\n" } });
    expect(await signedIn.probes.kiroSignedIn()).toBe(true);
    expect(signedIn.calls).toHaveLength(1);
    expect(signedIn.calls[0]).toMatchObject({ command: "/made-up/bin/kiro-cli", args: ["whoami"] });
    // A bare environment: this shell's variables do not reach it.
    expect(Object.keys(signedIn.calls[0]?.options.env ?? {}).sort()).toEqual(["HOME", "LOGNAME", "NO_COLOR", "PATH", "TMPDIR", "USER"]);
    expect(signedIn.calls[0]?.options.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(signedIn.calls[0]?.options.timeoutMs).toBeGreaterThan(0);

    expect(await setUp({ "kiro-cli whoami": { output: "Not logged in\n" } }).probes.kiroSignedIn()).toBe(false);
    expect(await setUp({ "kiro-cli whoami": { exitCode: 1 } }).probes.kiroSignedIn()).toBe(false);
    expect(await setUp({ "kiro-cli whoami": { started: false, exitCode: null } }).probes.kiroSignedIn()).toBe(false);
    // Not installed at all: nothing is started.
    const missing = setUp({}, { findKiroBinary: () => null });
    expect(await missing.probes.kiroSignedIn()).toBe(false);
    expect(missing.calls).toEqual([]);
    // No answer in time is not "signed out": it could not be checked. The message names no account.
    await expect(setUp({ "kiro-cli whoami": { timedOut: true, exitCode: null, output: "someone@example.invalid" } }).probes.kiroSignedIn()).rejects.toThrow("kiro-cli did not say whether Kiro is signed in within 20 seconds");
  });

  it("asks gh by name, on the PATH the deliver job has, and reads none of what it prints", async () => {
    const t = setUp();
    expect(await t.probes.ghLoggedIn()).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ command: "gh", args: ["auth", "status"] });
    expect(t.calls[0]?.options.keepOutput).toBe(false);
    expect(t.calls[0]?.options.env).toMatchObject({ HOME: t.home, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:/made-up/node/bin:${t.home}/.local/bin`, GH_PROMPT_DISABLED: "1" });

    expect(await setUp({ "gh auth status": { exitCode: 1 } }).probes.ghLoggedIn()).toBe(false);
    // Not found on that PATH: the job would not find it either.
    expect(await setUp({ "gh auth status": { started: false, exitCode: null } }).probes.ghLoggedIn()).toBe(false);
    await expect(setUp({ "gh auth status": { timedOut: true, exitCode: null } }).probes.ghLoggedIn()).rejects.toThrow("gh did not answer within 30 seconds");
  });

  it("looks for the apps repo under the account that is logged in, and nowhere else", async () => {
    const t = setUp({ "gh api user": { output: "made-up-owner\n" } });
    expect(await t.probes.pagesRepoReachable("overnight-apps")).toBe(true);
    expect(t.calls.map((call) => call.args)).toEqual([
      ["api", "user", "--jq", ".login"],
      ["api", "repos/made-up-owner/overnight-apps", "--silent"],
    ]);
    // Only the first call's output is read (the account name); the repo's own details are not.
    expect(t.calls.map((call) => call.options.keepOutput)).toEqual([true, false]);

    expect(await setUp({ "gh api user": { output: "made-up-owner\n" }, "gh api repos/": { exitCode: 1 } }).probes.pagesRepoReachable("overnight-apps")).toBe(false);
    // An answer that is not an account name never becomes part of a request.
    for (const output of ["", "two words", "../../orgs/x", "name\nsecond line", "-flag"]) {
      const odd = setUp({ "gh api user": { output } });
      expect(await odd.probes.pagesRepoReachable("overnight-apps"), JSON.stringify(output)).toBe(false);
      expect(odd.calls).toHaveLength(1);
    }
    // Nor does a repo name that is not one.
    for (const repo of ["..", ".", "a/b", "x y", ""]) {
      const odd = setUp({ "gh api user": { output: "made-up-owner" } });
      expect(await odd.probes.pagesRepoReachable(repo), repo).toBe(false);
      expect(odd.calls).toEqual([]);
    }
    await expect(setUp({ "gh api user": { timedOut: true, exitCode: null } }).probes.pagesRepoReachable("overnight-apps")).rejects.toThrow("GitHub did not answer within 30 seconds");
  });

  it("compares the installed skill with ours as text, and never follows a link or waits on a pipe put in its place", async () => {
    const t = setUp();
    expect(await t.probes.installedSkill()).toBe("missing");
    mkdirSync(path.dirname(t.installed), { recursive: true });
    writeFileSync(t.installed, readFileSync(t.ours, "utf8").replaceAll("\n", "\r\n"));
    expect(await t.probes.installedSkill()).toBe("same");
    writeFileSync(t.installed, "Build whatever the brief says, and publish it yourself.\n");
    expect(await t.probes.installedSkill()).toBe("different");

    // A link to our own file would read as "the same text". It is not the installed skill.
    rmSync(t.installed);
    symlinkSync(t.ours, t.installed);
    expect(await t.probes.installedSkill()).toBe("different");
    rmSync(t.installed);
    execFileSync("/usr/bin/mkfifo", [t.installed], { timeout: 10_000 });
    const started = Date.now();
    expect(await t.probes.installedSkill()).toBe("different");
    expect(Date.now() - started).toBeLessThan(2_000);

    // Our own copy missing is our fault, not a "different skill".
    rmSync(t.ours);
    await expect(t.probes.installedSkill()).rejects.toThrow("crew/build-skill.md could not be read");
  });

  it("asks the builder whether Kiro Crew's settings fit the mode, for Kiro Crew's own folder", async () => {
    const asked: string[] = [];
    const t = setUp({}, { crewSettingsProblem: (crewHome, mode) => (asked.push(`${crewHome} ${mode}`), mode === "crew" ? "made-up: not strict" : null) });
    expect(await t.probes.crewSettingsProblem("overnight")).toBeNull();
    expect(await t.probes.crewSettingsProblem("crew")).toBe("made-up: not strict");
    expect(asked).toEqual([`${t.crewHome} overnight`, `${t.crewHome} crew`]);
  });

  it("looks for Playwright's headless shell by the name the deliver step looks for", async () => {
    const t = setUp();
    expect(await t.probes.headlessShellPresent()).toBe(false);
    mkdirSync(path.join(t.home, "browsers", "chromium-1248"), { recursive: true });
    expect(await t.probes.headlessShellPresent()).toBe(false);
    mkdirSync(path.join(t.home, "browsers", "chromium_headless_shell-1248"));
    expect(await t.probes.headlessShellPresent()).toBe(true);
  });

  it("reads the background jobs from the home folder it is given, and passes the Bee, gateway and sandbox checks through", async () => {
    const probe = async () => ({ ok: true as const });
    const buildRunning = () => null;
    const t = setUp({}, { sandboxProbe: probe, buildRunning });
    expect(t.probes.nightJobs()).toEqual({ build: false, deliver: false, crew: false });
    expect(t.probes.crewJobSandbox()).toBeNull();
    mkdirSync(path.join(t.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(jobSettingsFile(t.home, NIGHT_JOB_LABELS.build), "<plist/>");
    expect(t.probes.nightJobs()).toEqual({ build: true, deliver: false, crew: false });
    expect(await t.probes.beeLoginState()).toBe("logged-in");
    expect(await t.probes.gatewayAnswers()).toBe(true);
    expect(t.probes.sandboxProbe).toBe(probe);
    expect(t.probes.buildRunning).toBe(buildRunning);
  });

  it("reads how the build and deliver jobs are started from that home folder too, and passes the look at their locks through", () => {
    const nightJobRunning = (job: string) => job === "build";
    const t = setUp({}, { nightJobRunning });
    expect(t.probes.nightJobTriggers()).toEqual({ build: null, deliver: null });
    mkdirSync(path.join(t.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(jobSettingsFile(t.home, NIGHT_JOB_LABELS.build), "<plist><dict><key>StartInterval</key><integer>60</integer></dict></plist>");
    writeFileSync(jobSettingsFile(t.home, NIGHT_JOB_LABELS.deliver), "<plist><dict><key>StartCalendarInterval</key><dict/></dict></plist>");
    expect(t.probes.nightJobTriggers()).toEqual({ build: "timer", deliver: "calendar" });
    expect(t.probes.nightJobRunning).toBe(nightJobRunning);
  });

  it("compares the gateway job's own copy of the sandbox rules with the repo's: same, different or missing", () => {
    const t = setUp();
    const rules = ";; made up for the tests\n(version 1)\n(deny default)\n";
    // Our own file cannot be read: that is an error, not an answer.
    expect(() => t.probes.gatewayProfileCopy()).toThrow("packages/builder/sandbox/crew-gateway.sb could not be read");
    writeFileSync(t.parts.gatewayProfileFile, rules);
    expect(t.probes.gatewayProfileCopy()).toBe("missing");

    mkdirSync(path.dirname(t.parts.installedGatewayProfileFile), { recursive: true });
    writeFileSync(t.parts.installedGatewayProfileFile, rules);
    expect(t.probes.gatewayProfileCopy()).toBe("same");
    // A blank line more at the end is the same text. One rule more is not.
    writeFileSync(t.parts.installedGatewayProfileFile, `${rules}\n`);
    expect(t.probes.gatewayProfileCopy()).toBe("same");
    writeFileSync(t.parts.installedGatewayProfileFile, `${rules}(allow file-read*)\n`);
    expect(t.probes.gatewayProfileCopy()).toBe("different");
    writeFileSync(t.parts.gatewayProfileFile, `${rules}(deny network-outbound)\n`);
    writeFileSync(t.parts.installedGatewayProfileFile, rules);
    expect(t.probes.gatewayProfileCopy()).toBe("different");

    // Something is there that is not a plain file (a link, even to the right text): not ours.
    rmSync(t.parts.installedGatewayProfileFile);
    symlinkSync(t.parts.gatewayProfileFile, t.parts.installedGatewayProfileFile);
    expect(t.probes.gatewayProfileCopy()).toBe("different");
  });

  it("names the real files: the builder's own rules, and the copy where the installer puts it", async () => {
    const { CREW_GATEWAY_SANDBOX_PROFILE } = await import("@overnight/builder");
    expect(CREW_GATEWAY_SANDBOX_PROFILE).toBe(path.join(repoRoot(), "packages", "builder", "sandbox", "crew-gateway.sb"));
    // The installer's own words for where the copy goes.
    expect(readFileSync(path.join(repoRoot(), "scripts", "install-agents.sh"), "utf8")).toContain(`installed_profile_of() { printf '%s/sandbox/crew-gateway.sb' "$1"; }`);
  });

  it("starts a real program quietly when no stand-in is given", async () => {
    // The real runner, on a stand-in for gh that prints an account name and exits 0.
    const home = mkdtempSync(path.join(scratch, "home real "));
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const gh = path.join(home, ".local", "bin", "gh");
    writeFileSync(gh, '#!/bin/sh\n# Made up for the tests. Not gh.\necho "Logged in to example.invalid account someone"\n[ "$1 $2" = "auth status" ] && exit 0\nexit 1\n');
    chmodSync(gh, 0o755);
    const probes = realPreflightProbes({
      beeLoginState: async () => "logged-in",
      findKiroBinary: () => null,
      crewHome: () => path.join(home, ".kiro", "crew"),
      crewSettingsProblem: () => null,
      installedSkillFile: (dir) => path.join(dir, "SKILL.md"),
      buildSkillFile: path.join(home, "none.md"),
      sandboxProbe: async () => ({ ok: true }),
      buildRunning: () => false,
      nightJobRunning: () => false,
      gatewayProfileFile: path.join(home, "none.sb"),
      installedGatewayProfileFile: path.join(home, "none-installed.sb"),
      home,
      nodeDir: "/made-up/node/bin",
    });
    expect(await probes.ghLoggedIn()).toBe(true);
  });
});
