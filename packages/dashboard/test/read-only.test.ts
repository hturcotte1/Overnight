// The dashboard only reads. That is a promise about the code, so it is checked by reading the
// code: everything under src/ except src/demo (the invented data, which is the one part that
// writes, and only into a folder of its own).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(folder: string): string[] {
  return readdirSync(path.join(PACKAGE, folder), { withFileTypes: true }).flatMap((entry) => {
    const inside = path.join(folder, entry.name);
    return entry.isDirectory() ? filesUnder(inside) : entry.name.endsWith(".ts") ? [inside] : [];
  });
}

/** A source with its comments taken out, so a rule about code is not tripped by a sentence about it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/([;{},)])\s*\/\/ .*$/gm, "$1");
}

const sources = filesUnder("src")
  .filter((file) => !file.startsWith(path.join("src", "demo") + path.sep))
  .map((file) => ({ file, text: code(readFileSync(path.join(PACKAGE, file), "utf8")) }));
const named = (file: string): string => path.join("src", ...file.split("/"));

/** Every `import` and `export ... from` in a source: where from, and which names. */
function imports(text: string): Array<{ from: string; names: string }> {
  return Array.from(text.matchAll(/^(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gms), (match) => ({ names: match[1] ?? "", from: match[2] ?? "" }));
}

/** The only things this half may take from the file system: looking, and reading. */
const READING = new Set(["closeSync", "constants", "existsSync", "fstatSync", "lstatSync", "openSync", "readFileSync", "readSync", "readdirSync", "realpathSync", "statSync"]);

describe("the half of the dashboard that shows real data (src/ without src/demo)", () => {
  it("is every source the package has outside the demo, and there are some", () => {
    const files = sources.map(({ file }) => file);
    for (const expected of ["main.ts", "site.ts", "index.ts", "args.ts", "story.ts", "data/db.ts", "data/locks.ts", "data/snapshot.ts", "server/server.ts", "server/guard.ts", "render/today.ts"]) expect(files).toContain(named(expected));
    expect(files.some((file) => file.includes("demo"))).toBe(false);
  });

  it.each(sources)("$file takes nothing from core that writes: no Store, no ensureDataDirs, no createLogger, no openContext", ({ text }) => {
    for (const name of ["Store", "ensureDataDirs", "createLogger", "openContext"]) expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(sources)("$file imports no builder, no way to start a program and no way to call out", ({ text }) => {
    const banned = /^(@overnight\/(builder|cli|deliver|listener|detector|bee)|(node:)?(child_process|https|http2|net|tls|dgram|dns|cluster|worker_threads|vm))(\/|$)/;
    for (const one of imports(text)) expect(banned.test(one.from), one.from).toBe(false);
    expect(text).not.toMatch(/\brequire\s*\(/);
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/process\.(binding|dlopen|kill)\b/);
  });

  it.each(sources)("$file takes only looking and reading from the file system", ({ text }) => {
    for (const one of imports(text)) {
      if (one.from === "node:fs/promises" || one.from === "fs/promises" || one.from === "fs") expect.fail(`imports ${one.from}`);
      if (one.from !== "node:fs") continue;
      // Named imports only, so every function used is on the list.
      expect(one.names).toMatch(/^\{[^}]*\}$/);
      for (const name of one.names.replace(/[{}]/g, "").split(",").map((part) => part.trim().split(/\s+as\s+/)[0] ?? "").filter((part) => part !== "")) expect(READING.has(name), name).toBe(true);
    }
    // No file is opened by a mode written as text ("w", "a", "r+"), and no flag that makes or changes a file is named.
    expect(text).not.toMatch(/openSync\([^)]*,\s*["'`]/);
    expect(text).not.toMatch(/\bO_(WRONLY|RDWR|CREAT|APPEND|TRUNC|EXCL)\b/);
  });

  it("opens a file in one place only, read-only and never through a link", () => {
    const openers = sources.filter(({ text }) => /\bopenSync\(/.test(text));
    expect(openers.map(({ file }) => file)).toEqual([named("data/safe-read.ts")]);
    expect(openers[0]?.text).toMatch(/constants\.O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/);
    expect(openers[0]?.text.match(/\bopenSync\(/g)?.length).toBe(1);
  });

  it("opens a database in two places only, each time read-only and only if the file is already there", () => {
    const openers = sources.filter(({ text }) => text.includes("new Database("));
    expect(openers.map(({ file }) => file).sort()).toEqual([named("data/db.ts"), named("data/locks.ts")]);
    for (const { file, text } of openers) {
      const calls = Array.from(text.matchAll(/new Database\(([^;]*?)\);/gs), (match) => match[1] ?? "");
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, file).toContain("readonly: true");
        expect(call, file).toContain("fileMustExist: true");
      }
    }
    // Nobody else even imports the database library.
    const users = sources.filter(({ text }) => imports(text).some((one) => one.from === "better-sqlite3" && !/^type\b/.test(one.names)));
    expect(users.map(({ file }) => file).sort()).toEqual([named("data/db.ts"), named("data/locks.ts")]);
  });

  it.each(sources)("$file holds no SQL that changes anything", ({ text }) => {
    expect(text).not.toMatch(/\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+(TABLE|INDEX|TRIGGER|VIEW)|DROP\s+(TABLE|INDEX)|ALTER\s+TABLE|VACUUM|ATTACH\s+DATABASE|wal_checkpoint|journal_mode)\b/i);
  });

  it("loads the writing half in one place only: the command, when it is told --demo", () => {
    const reaching = sources.filter(({ text }) => /["'`]\.\.?\/(?:[\w-]+\/)*demo\//.test(text)).map(({ file }) => file);
    expect(reaching.sort()).toEqual([named("index.ts"), named("main.ts")]);
    const main = sources.find(({ file }) => file === named("main.ts"))?.text ?? "";
    // The command never imports it up front: only by name, at the moment --demo is given.
    expect(imports(main).filter((one) => one.from.includes("demo"))).toEqual([]);
    expect(Array.from(main.matchAll(/\bimport\(([^)]*)\)/g), (match) => match[1])).toEqual(['"./demo/stage.ts"']);
    expect(/if \(args\.demo\) \{\s*const \{ openDemoStage \} = await import\("\.\/demo\/stage\.ts"\);/.test(main)).toBe(true);
    // The index only passes the demo's two functions on to whoever asks for them; nothing in src uses the index.
    const index = sources.find(({ file }) => file === named("index.ts"))?.text ?? "";
    expect(imports(index).filter((one) => one.from.includes("demo")).map((one) => one.from).sort()).toEqual(["./demo/night-script.ts", "./demo/seed.ts"]);
    expect(index).not.toMatch(/\bimport\(/);
    for (const { file, text } of sources) expect(/from\s+"\.\.?\/(?:\.\.\/)*index\.ts"/.test(text), file).toBe(false);
    // And no other source loads anything by a name worked out as it runs.
    for (const { file, text } of sources) if (file !== named("main.ts")) expect(/\bimport\(/.test(text), file).toBe(false);
  });

  it("starts with the same settings as every other command, and makes no folder", () => {
    const main = sources.find(({ file }) => file === named("main.ts"))?.text ?? "";
    expect(main).toContain("loadConfig(repoRoot())");
    expect(main).toContain("dataPaths(config.dataDir)");
    // Real data is only ever served on the one fixed port.
    expect(main).toContain("const port = args.demo ? (args.port ?? DASHBOARD_PORT) : DASHBOARD_PORT;");
    expect(imports(main).some((one) => one.from === "node:fs")).toBe(false);
  });
});

describe("the rule itself", () => {
  it("would catch the things it forbids", () => {
    // The checks above are only worth something if these texts trip them.
    expect(code('import { Store } from "@overnight/core"; // a note')).toMatch(/\bStore\b/);
    expect(code("// Store is never used here\nconst a = 1;")).not.toMatch(/\bStore\b/);
    expect(code("/* the Store\n writes */ const a = 1;")).not.toMatch(/\bStore\b/);
    expect(imports('import { writeFileSync } from "node:fs";')).toEqual([{ names: "{ writeFileSync }", from: "node:fs" }]);
    expect(imports('import type {\n  A,\n  B,\n} from "./types.ts";')).toEqual([{ names: "{\n  A,\n  B,\n}", from: "./types.ts" }]);
    expect(imports('export { seedDemoData } from "./demo/seed.ts";')).toEqual([{ names: "{ seedDemoData }", from: "./demo/seed.ts" }]);
    expect(READING.has("writeFileSync") || READING.has("mkdirSync") || READING.has("rmSync") || READING.has("renameSync")).toBe(false);
  });
});
