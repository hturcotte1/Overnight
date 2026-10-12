// SYNTHETIC: every title, pitch, quote and line in these tests is made up by the demo's seed. None of it is Bee data.
//
// The whole dashboard over real HTTP: the real server and the real site over the invented
// scene. What is tried here is the wiring: every address answers, a change in the data reaches
// the page, and looking at the pages writes nothing.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPaths, Store } from "@overnight/core";
import { afterEach, describe, expect, it } from "vitest";
import { PNG_SIGNATURE } from "../src/demo/png.ts";
import { seedDemoData } from "../src/demo/seed.ts";
import { createSite } from "../src/site.ts";
import { closeServers, configFor, FILMING, listing, NOT_FILMING, pageAddresses, region, removeScratch, SCENE_NOW, scratch, seeded, serve, sha256 } from "./demo-server.ts";

afterEach(async () => {
  await closeServers();
  removeScratch();
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SIDE_FILES = ["overnight.db-shm", "overnight.db-wal"];

describe("every address of the dashboard, over the invented scene", () => {
  it("answers 200 for the four views and for every idea's page, each with its own words", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const words: Record<string, string> = { "/": "Kiro Crew is building", "/ideas": "13 ideas, newest first", "/nights": "Building now.", "/settings": "This page changes nothing." };
    for (const address of pageAddresses(scene.ideaIds)) {
      const answer = await served.get(address);
      expect(answer.status, address).toBe(200);
      expect(answer.headers.get("content-type"), address).toBe("text/html; charset=utf-8");
      expect(answer.headers.get("etag"), address).toMatch(/^"[0-9a-f]{40}"$/);
      expect(answer.text, address).toContain("<!doctype html>");
      expect(answer.text, address).toContain('data-pill="demo"');
      if (words[address] !== undefined) expect(answer.text, address).toContain(words[address]);
    }
    expect(served.logged).toEqual([]);
  });

  it("shows each idea under its own title, with the story's seven steps", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const page = (await served.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text;
    expect(page).toContain('<h1 class="hero__now">Packing Checklist</h1>');
    expect(Array.from(page.matchAll(/data-step="(\w+)" data-status="(\w+)"/g), (match) => `${match[1]}:${match[2]}`)).toEqual(["heard:done", "asked:done", "approved:done", "built:done", "checked:done", "published:done", "delivered:done"]);
    // What the logs and the report say about it reaches the page: the night's ticks and the facts.
    expect(page).toContain("Sandbox check passed");
    expect(page).toContain("4.59 credits");
    expect(page).toContain('href="https://example.invalid/overnight-apps/packing-checklist/"');
    // The page of the idea being built carries the files its build has made so far.
    const building = (await served.get(`/ideas/${scene.ideaIds.choreWheel}`)).text;
    expect(Array.from(building.matchAll(/data-check="(mark-[a-z]+)" data-status="(\w+)"/g), (match) => `${match[1]}:${match[2]}`)).toEqual(["mark-started:done", "mark-project:done", "mark-packages:todo", "mark-app:todo", "mark-notes:todo"]);
  });

  it("leads Today with the idea being built, and says which programs are running from the locks", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const page = (await served.get("/")).text;
    expect(region(page, "story")?.text).toContain("Chore Wheel");
    expect(region(page, "story")?.text).toContain('data-step="built" data-status="active"');
    // The hero's story carries the night's ticks and the files its build has made so far; the cards do not need them.
    expect(region(page, "story")?.text).toContain('data-check="sandbox" data-status="done"');
    expect(region(page, "story")?.text).toContain('data-check="mark-project" data-status="done"');
    expect(region(page, "story")?.text).toContain('data-check="mark-packages" data-status="todo"');
    // The line about the night, and what tonight's build will take, in the builder's own order and within its limit.
    expect(region(page, "lastnight")?.text).toContain('<span class="lastnight__label">Tonight</span><span class="lastnight__headline">Building now.</span>');
    const queue = (region(page, "lane-tonight")?.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(queue).toContain("1 Chore Wheel building 2 Lunch Turns next 3 Recipe Doubler waits for another night");
    // Nothing holds a lock in this folder: the page says so instead of guessing.
    expect(page).toContain('data-pill="listening">Not listening<');
    // A build is marked as under way, so the page looks every two seconds.
    expect(page).toContain('data-poll-ms="2000"');
  });

  it("answers 404 for an idea that is not there, with a page that has no data on it", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const answer = await served.get("/ideas/idea_20261012_n0th1ng0");
    expect(answer.status).toBe(404);
    expect(answer.text).toContain("There is no page at this address.");
    expect(answer.headers.get("etag")).toBeNull();
    for (const title of ["Chore Wheel", "Packing Checklist"]) expect(answer.text).not.toContain(title);
    expect((await served.get("/ideas")).status).toBe(200);
  });

  it("serves the three files of its own and the pictures of an app that is out", async () => {
    const scene = seeded();
    const served = await serve(scene);
    for (const [address, type] of [["/assets/app.css", "text/css; charset=utf-8"], ["/assets/app.js", "text/javascript; charset=utf-8"], ["/assets/icon.svg", "image/svg+xml"]] as const) {
      const answer = await served.get(address, { cookie: false });
      expect(answer.status, address).toBe(200);
      expect(answer.headers.get("content-type"), address).toBe(type);
    }
    for (const key of ["packingChecklist", "readingLog"] as const) {
      for (const which of ["phone", "desktop"]) {
        const answer = await served.get(`/shots/${scene.ideaIds[key]}/${which}.png`);
        expect(answer.status, `${key} ${which}`).toBe(200);
        expect(answer.headers.get("content-type")).toBe("image/png");
        expect(answer.bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      }
    }
    // The idea's page asks for exactly these two addresses.
    const page = (await served.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text;
    expect(page).toContain(`src="/shots/${scene.ideaIds.packingChecklist}/phone.png"`);
    expect(page).toContain(`src="/shots/${scene.ideaIds.packingChecklist}/desktop.png"`);
  });

  it("hands out a picture only for an idea whose page shows it", async () => {
    const scene = seeded();
    const served = await serve(scene);
    // "Game Night Scores" has pictures on disk from its morning check, but it was not published.
    expect(existsSync(path.join(scene.paths.screenshots, `${scene.ideaIds.gameNightScores}.png`))).toBe(true);
    expect((await served.get(`/shots/${scene.ideaIds.gameNightScores}/phone.png`)).status).toBe(404);
    expect((await served.get(`/shots/${scene.ideaIds.choreWheel}/phone.png`)).status).toBe(404);
    expect((await served.get("/shots/idea_20261012_n0th1ng0/phone.png")).status).toBe(404);
    // And never without the key, even for one that is out.
    expect((await served.get(`/shots/${scene.ideaIds.packingChecklist}/phone.png`, { cookie: false })).status).toBe(401);
    // The site itself refuses a name that is not an idea's id, whoever asks.
    const site = createSite({ config: scene.config, paths: scene.paths, filming: NOT_FILMING, demo: true, port: 4999 });
    expect(site.shot("../reports", "phone")).toBeNull();
    expect(site.shot(scene.ideaIds.packingChecklist, "sideways" as "phone")).toBeNull();
    expect(site.shot(scene.ideaIds.packingChecklist, "phone")?.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it("has a card's seven dots say what the idea's own page says about a morning that went wrong, also when the log has gone", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const id = scene.ideaIds.gameNightScores;
    const dots = async (): Promise<string[]> => {
      const card = new RegExp(`<a class="card idea" href="/ideas/${id}">.*?<ol class="mini" aria-hidden="true">(.*?)</ol>`, "s").exec((await served.get("/ideas")).text)?.[1] ?? "";
      return Array.from(card.matchAll(/<li class="([^"]*)">/g), (match) => match[1] ?? "");
    };
    const steps = async (): Promise<string[]> => Array.from((await served.get(`/ideas/${id}`)).text.matchAll(/data-step="\w+" data-status="(\w+)"/g), (match) => match[1] ?? "");
    // The app was built and then did not pass the morning's check: the fifth step failed, not the sixth.
    const failedAtTheCheck = ["is-done", "is-done", "is-done", "is-done", "is-failed", "", ""];
    expect(await dots()).toEqual(failedAtTheCheck);
    expect(await steps()).toEqual(["done", "done", "done", "done", "failed", "todo", "todo"]);
    // With the morning's log gone, only the report still says where it failed. The card reads it too.
    writeFileSync(path.join(scene.paths.logs, "deliver.log"), "");
    expect(await steps()).toEqual(["done", "done", "done", "done", "failed", "todo", "todo"]);
    expect(await dots()).toEqual(failedAtTheCheck);
  });

  it("puts a card's picture on Today and on Ideas only for an app that is out and has one", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const shown = (page: string): string[] => Array.from(new Set(Array.from(page.matchAll(/class="idea__shot" alt="" src="\/shots\/([^/]+)\/phone\.png"/g), (match) => match[1] ?? ""))).sort();
    const out = [scene.ideaIds.packingChecklist, scene.ideaIds.readingLog, scene.ideaIds.practiceDiceRoller].sort();
    expect(shown((await served.get("/ideas")).text)).toEqual(out);
    // Today shows only some of the earlier ideas, so only some of the pictures; never one that Ideas does not.
    const today = shown((await served.get("/")).text);
    expect(today).toContain(scene.ideaIds.packingChecklist);
    for (const id of today) expect(out).toContain(id);
  });

  // A file under a picture's name that is no picture used to be shown anyway: a broken picture on three pages, and a 404 behind it.
  it("shows no picture at all, rather than a broken one, when the file under a picture's name is not a picture", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const packing = scene.ideaIds.packingChecklist;
    const reading = scene.ideaIds.readingLog;
    // The test's own folder: one app's phone picture is emptied, another's two pictures become text.
    writeFileSync(path.join(scene.paths.screenshots, `${packing}.png`), "");
    writeFileSync(path.join(scene.paths.screenshots, `${reading}.png`), "this is not a picture\n");
    writeFileSync(path.join(scene.paths.screenshots, `${reading}-desktop.png`), "nor is this\n");

    const pictures = (page: string): string[] => Array.from(page.matchAll(/<img [^>]*src="([^"]+)"/g), (match) => match[1] ?? "");
    const ideas = pictures((await served.get("/ideas")).text);
    expect(ideas).not.toContain(`/shots/${packing}/phone.png`);
    expect(ideas).not.toContain(`/shots/${reading}/phone.png`);
    // An app whose pictures are fine keeps its picture.
    expect(ideas).toEqual([`/shots/${scene.ideaIds.practiceDiceRoller}/phone.png`]);
    // The idea's own page: the picture that is still one stays, the other is simply not there.
    expect(pictures((await served.get(`/ideas/${packing}`)).text)).toEqual([`/shots/${packing}/desktop.png`]);
    expect(pictures((await served.get(`/ideas/${reading}`)).text)).toEqual([]);
    expect((await served.get(`/ideas/${reading}`)).text).not.toContain("The app, as it was checked");
    // Every picture any page asks for is there.
    for (const address of pageAddresses(scene.ideaIds)) {
      for (const src of pictures((await served.get(address)).text)) expect((await served.get(src)).status, `${src} on ${address}`).toBe(200);
    }
    expect((await served.get(`/shots/${packing}/phone.png`)).status).toBe(404);
  });
});

// The builder keeps more in <data>/built than one folder per finished build (builder, seal.ts and
// probe.ts): a file of the sandbox check's, older builds moved aside, and after a move that was
// killed midway a folder of half-made copies. Here they are put beside the scene's own finished
// builds, with words in them that no page may ever show.
describe("what the builder keeps among the finished builds besides the builds", () => {
  const STAMP = "20261011T070040Z";
  const SECRET = "WORDS-FROM-A-FOLDER-THAT-IS-NO-IDEA";
  const GONE = "idea_20261001_g0ne0000";

  /** A folder that looks like a whole build, with the secret words in everything the pages read from a build. */
  function wholeBuildAt(folder: string): void {
    mkdirSync(path.join(folder, "dist"), { recursive: true });
    mkdirSync(path.join(folder, "node_modules"));
    writeFileSync(path.join(folder, "BUILD_NOTES.md"), `${SECRET}: the notes of a build that was moved aside\n`);
    writeFileSync(path.join(folder, "BUILD_STATUS.json"), '{"status":"built"}\n');
    writeFileSync(path.join(folder, "package.json"), "{}\n");
    writeFileSync(path.join(folder, "brief.md"), `${SECRET}: a brief\n`);
    writeFileSync(path.join(folder, "dist", "index.html"), `<!doctype html><title>${SECRET}</title>\n`);
  }

  function addTheExtras(scene: ReturnType<typeof seeded>): string[] {
    const { built } = scene.paths;
    const names = [
      ".overnight-probe-marker",
      // Of an app that is out, of the idea that is being built right now, and of one that was approved and never built.
      `${scene.ideaIds.packingChecklist}.old-${STAMP}`,
      `${scene.ideaIds.packingChecklist}.old-${STAMP}-2`,
      `${scene.ideaIds.packingChecklist}.sealing`,
      `${scene.ideaIds.choreWheel}.old-${STAMP}`,
      `${scene.ideaIds.choreWheel}.sealing`,
      `${scene.ideaIds.lunchTurns}.old-${STAMP}`,
      // And of ideas the database does not have (any more): a build, and what was kept beside it.
      GONE,
      `${GONE}.old-${STAMP}`,
      `${GONE}.sealing`,
    ];
    writeFileSync(path.join(built, ".overnight-probe-marker"), `${SECRET}: Overnight keeps this file here for its build sandbox check.\n`);
    for (const name of names.slice(1)) wholeBuildAt(path.join(built, name));
    // The same names where the reports, the briefs and the pictures are kept, in case a page ever went looking by one.
    for (const name of names) {
      mkdirSync(path.join(scene.paths.ideas, name), { recursive: true });
      writeFileSync(path.join(scene.paths.ideas, name, "brief.md"), `${SECRET}: a brief\n`);
      writeFileSync(path.join(scene.paths.reports, `${name}.json`), JSON.stringify({ ideaId: name, title: SECRET, confirmedLive: true }));
      writeFileSync(path.join(scene.paths.screenshots, `${name}.png`), Buffer.concat([PNG_SIGNATURE, Buffer.from(SECRET)]));
    }
    return names;
  }

  it("shows none of it as an idea and breaks no page over it: every page is exactly the page it was", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const addresses = pageAddresses(scene.ideaIds);
    const before = new Map<string, { etag: string | null; text: string }>();
    for (const address of addresses) {
      const answer = await served.get(address);
      before.set(address, { etag: answer.headers.get("etag"), text: answer.text });
    }
    // The scene keeps its finished builds where the builder does, so the extras really do lie beside builds the pages read.
    expect(readdirSync(scene.paths.built)).toContain(scene.ideaIds.packingChecklist);
    expect((await served.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text).toContain("Build notes");

    const names = addTheExtras(scene);
    for (const name of names) expect(readdirSync(scene.paths.built), name).toContain(name);

    for (const address of addresses) {
      const answer = await served.get(address);
      expect(answer.status, address).toBe(200);
      // The version mark is a fingerprint of everything on the page but the clock, and the scene's clock stands still.
      expect(answer.headers.get("etag"), address).toBe(before.get(address)?.etag);
      expect(answer.text, address).toBe(before.get(address)?.text);
      for (const word of [SECRET, ".sealing", ".old-", "overnight-probe-marker", GONE]) expect(answer.text.includes(word), `${word} on ${address}`).toBe(false);
    }
    // Thirteen ideas, as before: one card each, and no card for anything in the folder.
    const ideas = (await served.get("/ideas")).text;
    expect(ideas).toContain("13 ideas, newest first");
    expect(Array.from(ideas.matchAll(/<a class="card idea" href="\/ideas\/([^"]+)">/g), (match) => match[1]).sort()).toEqual(Object.values(scene.ideaIds).sort());
    // The idea that is being built still shows its own build's files so far, not the whole build that lies under its name plus ".old-".
    const building = (await served.get(`/ideas/${scene.ideaIds.choreWheel}`)).text;
    expect(Array.from(building.matchAll(/data-check="(mark-[a-z]+)" data-status="(\w+)"/g), (match) => `${match[1]}:${match[2]}`)).toEqual(["mark-started:done", "mark-project:done", "mark-packages:todo", "mark-app:todo", "mark-notes:todo"]);
    // An approved idea that was never built has no build notes, whatever lies under its name plus ".old-".
    expect((await served.get(`/ideas/${scene.ideaIds.lunchTurns}`)).text).not.toContain("Build notes");
    expect(served.logged).toEqual([]);
  });

  it("serves none of it, under any address", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const names = addTheExtras(scene);
    const packing = scene.ideaIds.packingChecklist;
    const tried: string[] = [];
    const refused = async (address: string): Promise<void> => {
      tried.push(address);
      const answer = await served.get(address);
      // 404 from the list of routes; an address the gate cannot read at all is 400. Never a page, a file or a picture.
      expect([400, 404], address).toContain(answer.status);
      expect(answer.text.includes(SECRET), address).toBe(false);
      expect(answer.headers.get("content-type"), address).not.toBe("image/png");
    };
    for (const name of names) {
      await refused(`/ideas/${name}`);
      await refused(`/ideas/${encodeURIComponent(name)}`);
      await refused(`/ideas/${name.replaceAll(".", "%2E")}`);
      await refused(`/shots/${name}/phone.png`);
      await refused(`/shots/${name}/desktop.png`);
      await refused(`/shots/${name}.png`);
      // There is no address for a file of a build at all: not by the folder's name, not through an idea's page.
      await refused(`/built/${name}`);
      await refused(`/built/${name}/BUILD_NOTES.md`);
      await refused(`/built/${name}/dist/index.html`);
      await refused(`/ideas/${packing}/${name}`);
      await refused(`/ideas/${packing}%2F..%2F${name}`);
      await refused(`/assets/${name}`);
    }
    for (const address of ["/built", "/built/", `/built/${packing}`, `/built/${packing}/BUILD_NOTES.md`, `/built/${packing}/dist/index.html`, `/workspaces/${scene.ideaIds.choreWheel}/brief.md`, "/assets/../built/.overnight-probe-marker", "/assets/%2E%2E/built/.overnight-probe-marker"]) await refused(address);
    expect(tried.length).toBeGreaterThan(100);
    // The site itself, asked without the server in front of it, gives no picture for any of the names.
    const site = createSite({ config: scene.config, paths: scene.paths, filming: NOT_FILMING, demo: true, port: 4999 });
    for (const name of names) {
      expect(site.shot(name, "phone"), name).toBeNull();
      expect(site.page({ kind: "idea", id: name }).status, name).toBe(404);
    }
    // And an app that is out still has its page and both its pictures.
    expect((await served.get(`/ideas/${packing}`)).status).toBe(200);
    expect((await served.get(`/shots/${packing}/phone.png`)).headers.get("content-type")).toBe("image/png");
    expect(served.logged).toEqual([]);
  });

  it("shows no idea for a finished build the database knows nothing of, also while filming", async () => {
    const scene = seeded();
    addTheExtras(scene);
    const served = await serve(scene, { filming: FILMING });
    for (const address of pageAddresses(scene.ideaIds)) {
      const answer = await served.get(address);
      expect(answer.status, address).toBe(200);
      expect(answer.text.includes(SECRET) || answer.text.includes(GONE), address).toBe(false);
    }
    expect((await served.get(`/ideas/${GONE}`)).status).toBe(404);
  });
});

describe("what the shell says", () => {
  it("marks the tab of the view that is open; an idea's page belongs to Ideas", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const open = async (address: string): Promise<string[]> => Array.from((await served.get(address)).text.matchAll(/<a href="([^"]*)" aria-current="page">/g), (match) => match[1] ?? "");
    expect(await open("/")).toEqual(["/"]);
    expect(await open("/ideas")).toEqual(["/ideas"]);
    expect(await open(`/ideas/${scene.ideaIds.choreWheel}`)).toEqual(["/ideas"]);
    expect(await open("/nights")).toEqual(["/nights"]);
    expect(await open("/settings")).toEqual(["/settings"]);
    // A page with no data on it has no tabs at all.
    expect((await served.get("/nope")).text).not.toContain('aria-label="Views"');
  });

  it("says when asking and building are paused, from the database and not from the settings", async () => {
    const scene = seeded();
    const served = await serve(scene);
    expect((await served.get("/")).text).not.toContain('data-pill="paused"');
    const store = new Store(scene.paths.database);
    try {
      store.setPaused(true, SCENE_NOW.toISOString());
    } finally {
      store.close();
    }
    for (const address of ["/", "/ideas", "/nights", "/settings"]) expect((await served.get(address)).text, address).toContain('data-pill="paused">Quiet mode<');
    expect(region((await served.get("/")).text, "lane-tonight")?.text).toContain("Paused: nothing will be built");
    expect((await served.get("/settings")).text).toContain("Paused (quiet mode)");
    expect(scene.config.pausedByDefault).toBe(false);
  });

  it("opens from the key link and from nothing else, and the page without the key names the right address", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const without = await served.get("/", { cookie: false });
    expect(without.status).toBe(401);
    expect(without.text).toContain(`It starts with http://127.0.0.1:${served.port}/?key=</p>`);
    expect(without.text).not.toContain("Chore Wheel");
    const link = await served.get(served.keyUrl, { cookie: false });
    expect(link.status).toBe(303);
    expect(link.headers.get("location")).toBe("/");
    expect(link.headers.get("set-cookie")).toContain(served.cookie);
    // The link starts the way the page without the key says it does.
    expect(served.keyUrl.startsWith(`http://127.0.0.1:${served.port}/?key=`)).toBe(true);
    expect((await served.get("/settings")).text).toContain(`http://127.0.0.1:${served.port}`);
  });

  it("marks invented data on every page when the database carries the demo's mark, even if nobody said --demo", async () => {
    const scene = seeded();
    const served = await serve(scene, { demo: false });
    for (const address of ["/", "/ideas", "/nights", "/settings", `/ideas/${scene.ideaIds.choreWheel}`]) {
      const page = (await served.get(address)).text;
      expect(page, address).toContain('data-pill="demo">DEMO DATA: invented<');
      expect(page, address).toContain("<title>DEMO · ");
    }
    expect((await served.get("/settings")).text).toContain("Invented data (demo)");
    // A page with no data on it has not looked at the database, so it only knows what the command said.
    expect((await served.get("/", { cookie: false })).text).not.toContain('data-pill="demo"');
    const told = await serve(scene, { demo: true });
    expect((await told.get("/", { cookie: false })).text).toContain('data-pill="demo"');
  });

  it("says on every page whether what was said is hidden", async () => {
    const scene = seeded();
    const showing = await serve(scene);
    const filming = await serve(scene, { filming: FILMING });
    for (const address of ["/", "/ideas", "/nights", "/settings", `/ideas/${scene.ideaIds.packingChecklist}`]) {
      const shown = (await showing.get(address)).text;
      expect(shown, address).toContain('data-pill="private">Shows what was said<');
      expect(shown, address).not.toContain('data-pill="filming"');
      const hidden = (await filming.get(address)).text;
      expect(hidden, address).toContain('data-pill="filming">FILMING: what was said is hidden<');
      expect(hidden, address).not.toContain('data-pill="private"');
    }
    expect((await filming.get("/", { cookie: false })).text).toContain('data-pill="filming"');
    expect((await showing.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text).toContain("what if there was a little list we could tick off while we pack");
    const hidden = (await filming.get(`/ideas/${scene.ideaIds.packingChecklist}`)).text;
    expect(hidden).not.toContain("what if there was a little list");
    expect(hidden).toContain("Hidden while filming");
    expect(hidden).toContain("Build notes are hidden while filming.");
  });

  it("goes by the clock it is handed, and tells the page that clock", async () => {
    const scene = seeded();
    let now = SCENE_NOW;
    const served = await serve(scene, { clock: () => now });
    const first = await served.get("/");
    expect(first.text).toContain(`<body data-now="${SCENE_NOW.getTime()}" data-time-zone="America/Boise" data-poll-ms="2000">`);
    expect(region(first.text, "clock")?.text).toContain("1:02 AM");
    now = new Date(SCENE_NOW.getTime() + 3 * 60_000);
    const later = await served.get("/");
    expect(later.text).toContain(`<body data-now="${now.getTime()}"`);
    expect(region(later.text, "clock")?.text).toContain("1:05 AM");
  });
});

describe("the page's version mark", () => {
  it("stays the same while only the clock moves, so the page is not sent again", async () => {
    const scene = seeded();
    let now = SCENE_NOW;
    const served = await serve(scene, { clock: () => now });
    for (const address of ["/", "/ideas", "/nights", "/settings", `/ideas/${scene.ideaIds.choreWheel}`, `/ideas/${scene.ideaIds.packingChecklist}`]) {
      now = SCENE_NOW;
      const first = await served.get(address);
      const etag = first.headers.get("etag") ?? "";
      now = new Date(SCENE_NOW.getTime() + 45_000);
      const again = await served.get(address, { headers: { "If-None-Match": etag } });
      expect(again.status, address).toBe(304);
      expect(again.text, address).toBe("");
      expect(again.headers.get("etag"), address).toBe(etag);
    }
  });

  it("changes when the data does, and only the part of the page that changed has a new fingerprint", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const before = await served.get("/");
    const ideaBefore = await served.get(`/ideas/${scene.ideaIds.plantWateringDays}`);
    const store = new Store(scene.paths.database);
    try {
      store.transitionIdea(scene.ideaIds.plantWateringDays, "approved", { answeredAt: SCENE_NOW.toISOString(), note: "ticked in Bee" }, SCENE_NOW.toISOString());
    } finally {
      store.close();
    }
    const after = await served.get("/", { headers: { "If-None-Match": before.headers.get("etag") ?? "" } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    const rev = (page: string, id: string): string | undefined => region(page, id)?.rev;
    // The ask was answered and the idea joined the queue: those parts changed.
    for (const id of ["lane-asked", "lane-tonight", "cards"]) expect(rev(after.text, id), id).not.toBe(rev(before.text, id));
    // The hero, what was heard and the line about the night did not.
    for (const id of ["story", "lane-heard", "lastnight", "pills"]) expect(rev(after.text, id), id).toBe(rev(before.text, id));
    expect(rev(before.text, "story")).toMatch(/^[0-9a-f]{12}$/);
    // The idea's own page moved a step on.
    const ideaAfter = await served.get(`/ideas/${scene.ideaIds.plantWateringDays}`);
    expect(ideaAfter.headers.get("etag")).not.toBe(ideaBefore.headers.get("etag"));
    expect(ideaBefore.text).toContain('data-step="approved" data-status="active"');
    expect(ideaAfter.text).toContain('data-step="approved" data-status="done"');
    expect(rev(ideaAfter.text, "story")).not.toBe(rev(ideaBefore.text, "story"));
    expect(rev(ideaAfter.text, "history")).not.toBe(rev(ideaBefore.text, "history"));
  });

  it("is different for every page, and for the same page in another mode", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const filming = await serve(scene, { filming: FILMING });
    const tags = new Set<string>();
    for (const address of pageAddresses(scene.ideaIds)) tags.add((await served.get(address)).headers.get("etag") ?? "");
    expect(tags.size).toBe(pageAddresses(scene.ideaIds).length);
    // Settings shows no quote, so only the pill differs between the two modes: the mark must still change.
    expect((await filming.get("/nights")).headers.get("etag")).not.toBe((await served.get("/nights")).headers.get("etag"));
  });

  it("looks at the data once a second at most, however many pages are asked for", async () => {
    const scene = seeded();
    // The usual reuse of one second, not the tests' zero.
    const served = await serve(scene, { reuseMs: "usual" });
    const before = await served.get("/");
    const store = new Store(scene.paths.database);
    try {
      store.transitionIdea(scene.ideaIds.plantWateringDays, "approved", { answeredAt: SCENE_NOW.toISOString() }, SCENE_NOW.toISOString());
    } finally {
      store.close();
    }
    // Within the second: the same look, so the same page, on this address and on any other.
    expect((await served.get("/", { headers: { "If-None-Match": before.headers.get("etag") ?? "" } })).status).toBe(304);
    expect((await served.get(`/ideas/${scene.ideaIds.plantWateringDays}`)).text).toContain('data-step="approved" data-status="active"');
    await pause(1100);
    expect((await served.get("/", { headers: { "If-None-Match": before.headers.get("etag") ?? "" } })).status).toBe(200);
    expect((await served.get(`/ideas/${scene.ideaIds.plantWateringDays}`)).text).toContain('data-step="approved" data-status="done"');
  });
});

describe("a data folder with nothing in it, and one that cannot be read", () => {
  it("says nothing is saved yet, makes nothing, and fills in by itself once there is data", async () => {
    const home = scratch();
    const dir = path.join(home, "not-made-yet");
    const served = await serve({ config: configFor(dir), paths: dataPaths(dir) }, { demo: false, home });
    for (const address of ["/", "/ideas"]) {
      const answer = await served.get(address);
      expect(answer.status, address).toBe(200);
      expect(answer.text, address).toContain("<h1>Nothing saved yet</h1><p>Overnight has not run with this data folder: ~/not-made-yet.</p>");
    }
    expect((await served.get("/nights")).text).toContain("No nights yet.");
    expect((await served.get("/settings")).text).toContain("~/not-made-yet");
    expect((await served.get("/ideas/idea_20261012_n0th1ng0")).status).toBe(404);
    // Looking made no folder and no file.
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(home)).toEqual([]);

    const empty = await served.get("/");
    mkdirSync(dir);
    const { ideaIds } = seedDemoData(dir, { now: SCENE_NOW, config: configFor(dir) });
    const filled = await served.get("/", { headers: { "If-None-Match": empty.headers.get("etag") ?? "" } });
    expect(filled.status).toBe(200);
    expect(filled.text).not.toContain("Nothing saved yet");
    expect(region(filled.text, "story")?.text).toContain("Chore Wheel");
    expect((await served.get(`/ideas/${ideaIds.choreWheel}`)).status).toBe(200);
  });

  it("keeps showing what it last read when the database cannot be read, and says so", async () => {
    const scene = seeded();
    const served = await serve(scene);
    const good = await served.get("/");
    expect(region(good.text, "banners")?.text).toBe("");
    // The test's own folder: the database is swapped for a file that is not one.
    writeFileSync(scene.paths.database, Buffer.alloc(8192, 7));
    const stale = await served.get("/");
    expect(stale.status).toBe(200);
    expect(region(stale.text, "banners")?.text).toContain("Could not read the database. Showing what was read at 1:02 AM. Trying again.");
    expect(region(stale.text, "story")?.text).toContain("Chore Wheel");
    expect(stale.headers.get("etag")).not.toBe(good.headers.get("etag"));
    expect((await served.get(`/ideas/${scene.ideaIds.choreWheel}`)).status).toBe(200);
  });
});

describe("a database that cannot be read from the start", () => {
  // Under the banner the headline used to say "No ideas yet", and went on saying it for a file that can never be read.
  it("says so in the headline too, and never that there are no ideas", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "overnight.db"), Buffer.alloc(8192, 7));
    const served = await serve({ config: configFor(dir), paths: dataPaths(dir) }, { demo: false });
    const today = await served.get("/");
    expect(today.status).toBe(200);
    expect(region(today.text, "banners")?.text).toBe('<p class="banner" role="status">Could not read the database. Trying again.</p>');
    expect(region(today.text, "story")?.text).toContain('<h1 class="hero__now">Could not read the database</h1>');
    expect(today.text).not.toContain("No ideas yet");
    expect(today.text).not.toContain("just now");
  });
});

describe("looking at the pages writes nothing", () => {
  /** Every address there is, asked for twice: pages, pictures, the dashboard's own files, and addresses that lead nowhere. */
  async function askForEverything(served: Awaited<ReturnType<typeof serve>>, ideaIds: Readonly<Record<string, string>>): Promise<void> {
    const addresses = [
      ...pageAddresses(ideaIds),
      ...Object.values(ideaIds).flatMap((id) => [`/shots/${id}/phone.png`, `/shots/${id}/desktop.png`]),
      "/assets/app.css",
      "/assets/app.js",
      "/assets/icon.svg",
      "/ideas/idea_20261012_n0th1ng0",
      "/nope",
    ];
    for (let round = 0; round < 2; round += 1) {
      for (const address of addresses) expect((await served.get(address)).status, address).toBeLessThan(500);
    }
    expect(served.logged).toEqual([]);
  }

  it("with no other program on the database: only SQLite's own two side files appear, and the database's bytes stay the same", async () => {
    const scene = seeded();
    const before = listing(scene.dir);
    const hash = sha256(scene.paths.database);
    for (const name of SIDE_FILES) expect(before.has(name), name).toBe(false);
    const served = await serve(scene);

    // A page with no data on it does not even look: nothing appears.
    expect((await served.get("/", { cookie: false })).status).toBe(401);
    expect((await served.get("/nope")).status).toBe(404);
    expect((await served.get("/assets/app.css")).status).toBe(200);
    expect(listing(scene.dir)).toEqual(before);

    await askForEverything(served, scene.ideaIds);
    const after = listing(scene.dir);
    expect([...after.keys()].filter((name) => !before.has(name)).sort()).toEqual(SIDE_FILES);
    expect([...before.keys()].filter((name) => !after.has(name))).toEqual([]);
    for (const [name, was] of before) expect(after.get(name), name).toBe(was);
    expect(sha256(scene.paths.database)).toBe(hash);
  });

  it("beside a program that has the database open: not one file's size or time changes", async () => {
    const scene = seeded();
    const store = new Store(scene.paths.database);
    try {
      // As the listener leaves it between two writes.
      store.setValue("invented_marker", "1", SCENE_NOW.toISOString());
      const before = listing(scene.dir);
      const hash = sha256(scene.paths.database);
      for (const name of SIDE_FILES) expect(before.has(name), name).toBe(true);
      const served = await serve(scene);
      await askForEverything(served, scene.ideaIds);
      expect(listing(scene.dir)).toEqual(before);
      expect(sha256(scene.paths.database)).toBe(hash);
      // And the writer can still write, at once.
      store.setValue("invented_marker", "2", SCENE_NOW.toISOString());
      expect(store.getValue("invented_marker")).toBe("2");
    } finally {
      store.close();
    }
  });
});
