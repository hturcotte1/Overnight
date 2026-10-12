// SYNTHETIC: every title, pitch, quote and line these helpers serve is made up by the demo's seed. None of it is Bee data.
//
// For the tests that try the whole dashboard: the real server and the real site over the
// invented scene, in a folder of their own, on a port the system picks. Nothing here ever
// touches Overnight's real data folder (the seed refuses it, and every folder comes from mkdtemp).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { dataPaths, nextLocalTime, parseConfig } from "@overnight/core";
import type { Config, DataPaths } from "@overnight/core";
import { seedDemoData } from "../src/demo/seed.ts";
import type { DemoIdeaKey } from "../src/demo/seed.ts";
import { keyCookieName } from "../src/server/guard.ts";
import { createDashboard } from "../src/server/server.ts";
import { createSite } from "../src/site.ts";
import type { FilmingPolicy, Site } from "../src/types.ts";

/** Is Playwright's headless browser on this Mac? Without it the browser tests are skipped, as the morning check's are. */
export function browserInstalled(): boolean {
  const folders = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(homedir(), "Library/Caches/ms-playwright"), path.join(homedir(), ".cache/ms-playwright")];
  return folders.some((folder) => folder !== undefined && existsSync(folder) && readdirSync(folder).some((name) => name.startsWith("chromium_headless_shell-")));
}

export const NOT_FILMING: FilmingPolicy = { on: false, showQuoteFor: new Set() };
export const FILMING: FilmingPolicy = { on: true, showQuoteFor: new Set() };

const made: string[] = [];

/** A new, empty folder of our own. `removeScratch` takes every one of them away again. */
export function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "overnight-dashboard-test-")));
  made.push(dir);
  return dir;
}

export function removeScratch(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The demo's own settings for a folder: the defaults, never `.env`. */
export function configFor(dir: string): Config {
  return parseConfig({ OVERNIGHT_DATA_DIR: dir, PAUSED: "false" });
}

/** The moment the scene is drawn for: 1:02 AM in Boise on Oct 12, 2026. */
export const SCENE_NOW: Date = nextLocalTime(new Date("2026-10-11T18:00:00.000Z"), "01:02", "America/Boise");

export interface Seeded {
  dir: string;
  config: Config;
  paths: DataPaths;
  ideaIds: Readonly<Record<DemoIdeaKey, string>>;
}

/** The invented scene in a new folder. With `inHome`, the folder is `<inHome>/overnight-data`, so a test can see paths shown as "~". */
export function seeded(o: { hostile?: boolean; sentinels?: boolean; inHome?: string } = {}): Seeded {
  let dir: string;
  if (o.inHome === undefined) dir = scratch();
  else {
    dir = path.join(o.inHome, "overnight-data");
    mkdirSync(dir);
  }
  const config = configFor(dir);
  const { ideaIds } = seedDemoData(dir, { now: SCENE_NOW, config, hostile: o.hostile, sentinels: o.sentinels });
  return { dir, config, paths: dataPaths(dir), ideaIds };
}

export interface Answer {
  status: number;
  headers: Headers;
  text: string;
  bytes: Buffer;
}

export interface Served {
  port: number;
  /** "http://127.0.0.1:<port>" */
  origin: string;
  /** The link that opens the dashboard. */
  keyUrl: string;
  /** The cookie the key link hands out, as a request header's value. */
  cookie: string;
  /** What the server wrote to its log. */
  logged: string[];
  /** Ask for an address with the cookie (or without it), never following a redirect. */
  get(address: string, o?: { cookie?: boolean; headers?: Record<string, string> }): Promise<Answer>;
  close(): Promise<void>;
}

const open: Served[] = [];

/**
 * The real server over the real site, on a port the system picks. The site is made once the
 * port is known, so the two sentences that name the port are right.
 * `clock` is the pretend clock; left out, it stands still at the scene's 1:02 AM.
 * Every request gets a fresh look at the data, unless `reuseMs` says "usual" (one look a second, as for real).
 */
export async function serve(s: Pick<Seeded, "config" | "paths">, o: { filming?: FilmingPolicy; demo?: boolean; clock?: () => Date; home?: string; reuseMs?: number | "usual" } = {}): Promise<Served> {
  let site: Site | null = null;
  const real = (): Site => {
    if (site === null) throw new Error("a request arrived before the site was made");
    return site;
  };
  const logged: string[] = [];
  const dashboard = createDashboard({
    site: { page: (route) => real().page(route), problem: (kind) => real().problem(kind), shot: (id, which) => real().shot(id, which) },
    port: 0,
    log: (line) => logged.push(line),
  });
  const { port, keyUrl } = await dashboard.listen();
  site = createSite({ config: s.config, paths: s.paths, filming: o.filming ?? NOT_FILMING, demo: o.demo ?? true, port, now: o.clock ?? (() => SCENE_NOW), home: o.home, reuseMs: o.reuseMs === "usual" ? undefined : (o.reuseMs ?? 0) });
  const origin = `http://127.0.0.1:${port}`;
  const cookie = `${keyCookieName(port)}=${new URL(keyUrl).searchParams.get("key") ?? ""}`;
  const served: Served = {
    port,
    origin,
    keyUrl,
    cookie,
    logged,
    async get(address, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      if (options.cookie !== false) headers.Cookie = cookie;
      const response = await fetch(new URL(address, origin), { headers, redirect: "manual" });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, text: bytes.toString("utf8"), bytes };
    },
    close: () => dashboard.close(),
  };
  open.push(served);
  return served;
}

export async function closeServers(): Promise<void> {
  await Promise.all(open.splice(0).map((served) => served.close()));
}

/** The pages every dashboard has, and one page per idea of the scene. */
export function pageAddresses(ideaIds: Readonly<Record<string, string>>): string[] {
  return ["/", "/ideas", "/nights", "/settings", ...Object.values(ideaIds).map((id) => `/ideas/${id}`)];
}

/** Every file and folder below `dir`, with its kind, size and time of last change. */
export function listing(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      const stat = lstatSync(full);
      const kind = stat.isDirectory() ? "folder" : stat.isFile() ? "file" : "other";
      // A folder's own size is the file system's business; its time changes when something is added or removed in it.
      found.set(path.relative(dir, full), `${kind} ${stat.isDirectory() ? "" : stat.size} ${stat.mtimeMs} ${stat.mode.toString(8)}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found;
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The text of one live region of a page, and its fingerprint. */
export function region(page: string, id: string): { rev: string; text: string } | null {
  const start = new RegExp(`<section id="${id}"[^>]* data-rev="([0-9a-f]{12})">`).exec(page);
  if (start === null) return null;
  const from = start.index + start[0].length;
  const end = page.indexOf("</section>", from);
  return { rev: start[1] ?? "", text: page.slice(from, end === -1 ? undefined : end) };
}
