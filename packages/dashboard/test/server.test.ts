// The web server, over real HTTP on a port of its own, with a stand-in Site.
// Every page, key, id and picture here is invented for the test.
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { html } from "../src/render/html.ts";
import type { SafeHtml } from "../src/render/html.ts";
import { keyCookieName, SECURITY_HEADERS } from "../src/server/guard.ts";
import { createDashboard, LIMITS, loadAssets } from "../src/server/server.ts";
import type { Asset, Dashboard, DashboardOptions } from "../src/server/server.ts";
import type { AssetName, PageRoute, Site } from "../src/types.ts";

const KEY = "invented-key-Aa0_-Zz9-0123456789";
const SECRET = "SECRET-SENTINEL a path /Users/invented/.overnight and words nobody said";
/** Not a real picture: the eight bytes every PNG starts with, and a few more. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const ASSETS: ReadonlyMap<AssetName, Asset> = new Map<AssetName, Asset>([
  ["app.css", { type: "text/css; charset=utf-8", body: Buffer.from("body { color: black; }\n") }],
  ["app.js", { type: "text/javascript; charset=utf-8", body: Buffer.from("// invented script\n") }],
  ["icon.svg", { type: "image/svg+xml", body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n') }],
]);

interface StubSite extends Site {
  pages: PageRoute[];
  shots: Array<[string, string]>;
}

/** A Site that knows three things: pages by their kind, one idea that is not there, one picture that is not there. */
function stubSite(over: Partial<Site> = {}): StubSite {
  const pages: PageRoute[] = [];
  const shots: Array<[string, string]> = [];
  return {
    pages,
    shots,
    page(route) {
      pages.push(route);
      if (route.kind === "idea" && route.id === "gone") return { status: 404, html: html`<!doctype html><p>NO SUCH IDEA</p>`, etag: '"gone"' };
      const name = route.kind === "idea" ? `idea ${route.id}` : route.kind;
      return { status: 200, html: html`<!doctype html><title>${name}</title><p>PAGE ${name} café</p>`, etag: `"v1-${route.kind}"` };
    },
    problem(kind) {
      return html`<!doctype html><p>PROBLEM ${kind}</p>`;
    },
    shot(ideaId, which) {
      shots.push([ideaId, which]);
      return ideaId === "gone" ? null : PNG;
    },
    ...over,
  };
}

interface Running {
  dashboard: Dashboard;
  port: number;
  url: string;
  keyUrl: string;
  cookie: string;
  lines: string[];
  site: StubSite;
}

const started: Dashboard[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((dashboard) => dashboard.close()));
});

async function start(over: Partial<DashboardOptions> & { site?: Site } = {}): Promise<Running> {
  const lines: string[] = [];
  const site = (over.site ?? stubSite()) as StubSite;
  const dashboard = createDashboard({ port: 0, key: KEY, assets: ASSETS, log: (line) => lines.push(line), ...over, site });
  started.push(dashboard);
  const { port, url, keyUrl } = await dashboard.listen();
  return { dashboard, port, url, keyUrl, cookie: `${keyCookieName(port)}=${KEY}`, lines, site };
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

/** One request on a connection of its own. No header is added that the test did not name, apart from Host. */
function ask(port: number, target: string, options: { method?: string; headers?: Record<string, string>; host?: string | null; agent?: http.Agent } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.host !== null) headers.Host = options.host ?? `localhost:${port}`;
    const request = http.request({ host: "127.0.0.1", port, path: target, method: options.method ?? "GET", headers, setHost: false, agent: options.agent ?? false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text: body.toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

/** Bytes straight onto a connection, for what a well-behaved client would never send. Resolves when the server hangs up, or after `waitMs`. */
function raw(port: number, bytes: string, waitMs = 1500, host = "127.0.0.1"): Promise<{ got: string; hungUp: boolean; ms: number }> {
  return new Promise((resolve) => {
    const begun = Date.now();
    const socket = net.connect({ port, host });
    let got = "";
    let done = false;
    const finish = (hungUp: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ got, hungUp, ms: Date.now() - begun });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    socket.on("data", (chunk: Buffer) => (got += chunk.toString("latin1")));
    socket.on("error", () => finish(true));
    socket.on("close", () => finish(true));
    if (bytes !== "") socket.write(bytes);
  });
}

/** Can anything be reached at this address and port? */
function connects(host: string, port: number): Promise<"connected" | string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("no answer");
    }, 1500);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? "error");
    });
  });
}

/** The first line and the headers of an answer read off a raw connection. */
function head(got: string): { statusLine: string; headers: Record<string, string> } {
  const [top = ""] = got.split("\r\n\r\n");
  const [statusLine = "", ...lines] = top.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon !== -1) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { statusLine, headers };
}

function expectSecurityHeaders(headers: Record<string, string | string[] | undefined>): void {
  expect(headers["content-security-policy"]).toBe(
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["cache-control"]).toBe("no-store");
  expect(Object.keys(headers).filter((name) => name.startsWith("access-control"))).toEqual([]);
}

describe("every answer carries the security headers and never an Access-Control one", () => {
  const throwing = (): Site => stubSite({ page: () => { throw new Error(SECRET); } });
  const withKey = (r: Running): Record<string, string> => ({ Cookie: r.cookie });
  /** Each case is asked with GET and then with HEAD. The 405 ones name their own method. */
  const cases: Array<[number, string, (r: Running, method: string) => Promise<Answer>, (() => Site)?]> = [
    [200, "a page", (r, method) => ask(r.port, "/", { method, headers: withKey(r) })],
    [200, "one of the three files", (r, method) => ask(r.port, "/assets/app.css", { method })],
    [200, "a screenshot", (r, method) => ask(r.port, "/shots/idea_01/phone.png", { method, headers: withKey(r) })],
    [303, "the key link", (r, method) => ask(r.port, `/?key=${KEY}`, { method })],
    [304, "a page that has not changed", (r, method) => ask(r.port, "/", { method, headers: { ...withKey(r), "If-None-Match": '"v1-today"' } })],
    [400, "an address that cannot be read", (r, method) => ask(r.port, "/ideas#top", { method, headers: withKey(r) })],
    [401, "a page without the key", (r, method) => ask(r.port, "/", { method })],
    [403, "a foreign Host", (r, method) => ask(r.port, "/", { method, host: "evil.example", headers: withKey(r) })],
    [403, "a foreign Origin", (r, method) => ask(r.port, "/", { method, headers: { ...withKey(r), Origin: "http://evil.example" } })],
    [403, "another site's own request", (r, method) => ask(r.port, "/", { method, headers: { ...withKey(r), "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } })],
    [404, "an address on no list", (r, method) => ask(r.port, "/no-such-page", { method, headers: withKey(r) })],
    [404, "an idea that is not there", (r, method) => ask(r.port, "/ideas/gone", { method, headers: withKey(r) })],
    [404, "a screenshot that is not there", (r, method) => ask(r.port, "/shots/gone/phone.png", { method, headers: withKey(r) })],
    [405, "a POST", (r) => ask(r.port, "/", { method: "POST", headers: withKey(r) })],
    [405, "a preflight (OPTIONS)", (r) => ask(r.port, "/", { method: "OPTIONS", headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-anything" } })],
    [414, "an address that is too long", (r, method) => ask(r.port, `/${"a".repeat(2000)}`, { method, headers: withKey(r) })],
    [500, "a Site that throws", (r, method) => ask(r.port, "/", { method, headers: withKey(r) }), throwing],
  ];

  it.each(cases)("%i: %s", async (status, _what, request, site) => {
    const r = await start(site === undefined ? {} : { site: site() });
    const answer = await request(r, "GET");
    expect(answer.status).toBe(status);
    expectSecurityHeaders(answer.headers);
  });

  it.each(cases.filter(([status]) => status !== 405))("%i: %s, asked with HEAD: the same headers and no body", async (status, _what, request, site) => {
    const r = await start(site === undefined ? {} : { site: site() });
    const got = await request(r, "GET");
    const again = await request(r, "HEAD");
    expect(again.status).toBe(status);
    expect(again.body).toHaveLength(0);
    expectSecurityHeaders(again.headers);
    expect(again.headers["content-type"]).toBe(got.headers["content-type"]);
    expect(again.headers["content-length"]).toBe(got.headers["content-length"]);
    expect(again.headers.etag).toBe(got.headers.etag);
    expect(again.headers.location).toBe(got.headers.location);
    // A page, a file or a picture says how long it would have been.
    if (status === 200) expect(Number(again.headers["content-length"])).toBe(got.body.length);
  });

  it("sends exactly the headers the gate lists, with their values", async () => {
    const r = await start();
    const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie } });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(answer.headers[name.toLowerCase()]).toBe(value);
  });
});

describe("the key link", () => {
  it("answers 303 with the cookie and the plain address, and the plain address then works", async () => {
    const r = await start();
    const first = await ask(r.port, `/?key=${KEY}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    expect(first.headers["set-cookie"]).toEqual([`${keyCookieName(r.port)}=${KEY}; HttpOnly; SameSite=Lax; Path=/`]);
    expect(first.body).toHaveLength(0);
    expect(r.site.pages).toEqual([]);

    const cookie = (first.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    const second = await ask(r.port, first.headers.location ?? "", { headers: { Cookie: cookie } });
    expect(second.status).toBe(200);
    expect(second.text).toContain("PAGE today");
    expect(r.site.pages).toEqual([{ kind: "today" }]);
  });

  it("works for an idea's page too, and goes to that page", async () => {
    const r = await start();
    const first = await ask(r.port, `/ideas/idea_01?key=${KEY}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/ideas/idea_01");
  });

  it("works when a person clicks it on another site's page", async () => {
    const r = await start();
    const click = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1" };
    const first = await ask(r.port, `/?key=${KEY}`, { headers: click });
    expect(first.status).toBe(303);
    // The browser follows the redirect as part of the same click, now with the cookie.
    const second = await ask(r.port, "/", { headers: { ...click, Cookie: r.cookie } });
    expect(second.status).toBe(200);
    expect(second.text).toContain("PAGE today");
  });

  it("names the cookie after the port it really listens on", async () => {
    const one = await start();
    const two = await start();
    expect(one.port).not.toBe(two.port);
    const first = await ask(one.port, `/?key=${KEY}`);
    expect(first.headers["set-cookie"]?.[0]).toContain(`overnight_dashboard_${one.port}=`);
    // The cookie of one dashboard does not open the other, even with the same key.
    expect((await ask(two.port, "/", { headers: { Cookie: one.cookie } })).status).toBe(401);
    expect((await ask(two.port, "/", { headers: { Cookie: two.cookie } })).status).toBe(200);
  });

  it("without the key shows the page that says to open the link, and never asks the Site for data", async () => {
    const r = await start();
    for (const target of ["/", "/ideas", "/ideas/idea_01", "/nights", "/settings", "/shots/idea_01/phone.png", "/?key=wrong-key", `/?key=${KEY}.`]) {
      const answer = await ask(r.port, target);
      expect(answer.status).toBe(401);
      expect(answer.text).toBe("<!doctype html><p>PROBLEM needs-key</p>");
      expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    expect(r.site.pages).toEqual([]);
    expect(r.site.shots).toEqual([]);
  });

  it("gives every start a new random key when none is handed in", async () => {
    const one = await start({ key: undefined });
    const two = await start({ key: undefined });
    const keyOf = (keyUrl: string): string => keyUrl.split("?key=")[1] ?? "";
    expect(keyOf(one.keyUrl)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(keyOf(two.keyUrl)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(keyOf(one.keyUrl)).not.toBe(keyOf(two.keyUrl));
    // Random all the way through: two keys agree in a place only by chance (1 in 64 per place).
    const agree = [...keyOf(one.keyUrl)].filter((character, index) => character === keyOf(two.keyUrl)[index]).length;
    expect(agree).toBeLessThan(8);
    expect((await ask(one.port, `/?key=${keyOf(one.keyUrl)}`)).status).toBe(303);
    expect((await ask(one.port, `/?key=${keyOf(two.keyUrl)}`)).status).toBe(401);
    expect((await ask(one.port, `/?key=${KEY}`)).status).toBe(401);
  });

  it("puts the key in the redirect's cookie and nowhere else", async () => {
    const r = await start();
    const answers = [
      await ask(r.port, "/", { headers: { Cookie: r.cookie } }),
      await ask(r.port, "/"),
      await ask(r.port, "/no-such-page"),
      await ask(r.port, "/assets/app.js"),
      await ask(r.port, "/", { method: "POST" }),
    ];
    for (const answer of answers) expect(JSON.stringify(answer.headers) + answer.text).not.toContain(KEY);
    const link = await ask(r.port, `/?key=${KEY}`);
    expect(link.headers.location).not.toContain(KEY);
    expect(r.lines.join("\n")).not.toContain(KEY);
  });
});

describe("the links it hands out", () => {
  it("are written with 127.0.0.1, where this server listens, and the key link opens the dashboard", async () => {
    const r = await start();
    expect(r.url).toBe(`http://127.0.0.1:${r.port}/`);
    expect(r.keyUrl).toBe(`http://127.0.0.1:${r.port}/?key=${KEY}`);
    const link = new URL(r.keyUrl);
    const first = await ask(r.port, link.pathname + link.search, { host: link.host });
    expect(first.status).toBe(303);
    const second = await ask(r.port, first.headers.location ?? "", { host: link.host, headers: { Cookie: r.cookie } });
    expect(second.status).toBe(200);
  });

  it("is still answered when a request arrives under the name localhost", async () => {
    const r = await start();
    expect((await ask(r.port, "/", { host: `localhost:${r.port}`, headers: { Cookie: r.cookie } })).status).toBe(200);
    expect((await ask(r.port, "/", { host: `127.0.0.1:${r.port}`, headers: { Cookie: r.cookie } })).status).toBe(200);
  });
});

describe("it listens on 127.0.0.1 and nowhere else", () => {
  it("can be reached at 127.0.0.1, and not at the IPv6 loopback", async () => {
    const r = await start();
    expect(await connects("127.0.0.1", r.port)).toBe("connected");
    expect(await connects("::1", r.port)).toBe("ECONNREFUSED");
  });

  it("cannot be reached at this Mac's address on the network", async () => {
    const r = await start();
    const outside = Object.values(os.networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((entry) => !entry.internal && entry.family === "IPv4")
      .map((entry) => entry.address);
    // A Mac with no network has no such address, and then there is nothing to try.
    for (const address of outside) expect(await connects(address, r.port)).not.toBe("connected");
  });
});

describe("pages, versions and 304", () => {
  it("serves each page the gate lets through, as HTML in UTF-8, with its version", async () => {
    const r = await start();
    for (const [target, kind, name] of [
      ["/", "today", "today"],
      ["/ideas", "ideas", "ideas"],
      ["/ideas/idea_01", "idea", "idea idea_01"],
      ["/nights", "nights", "nights"],
      ["/settings", "settings", "settings"],
    ] as const) {
      const answer = await ask(r.port, target, { headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(answer.headers.etag).toBe(`"v1-${kind}"`);
      expect(answer.text).toBe(`<!doctype html><title>${name}</title><p>PAGE ${name} café</p>`);
      expect(answer.headers["content-length"]).toBe(String(Buffer.byteLength(answer.text, "utf8")));
    }
    expect(r.site.pages).toEqual([{ kind: "today" }, { kind: "ideas" }, { kind: "idea", id: "idea_01" }, { kind: "nights" }, { kind: "settings" }]);
  });

  it.each([
    ["the same version", '"v1-today"'],
    ["the same version marked weak", 'W/"v1-today"'],
    ["a list that holds it", '"old", "v1-today", "other"'],
    ["a list without spaces", '"old","v1-today"'],
    ["a star", "*"],
  ])("answers 304 with no body when If-None-Match is %s", async (_what, header) => {
    const r = await start();
    const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie, "If-None-Match": header } });
    expect(answer.status).toBe(304);
    expect(answer.body).toHaveLength(0);
    expect(answer.headers.etag).toBe('"v1-today"');
    expect(answer.headers["content-type"]).toBeUndefined();
  });

  it.each([
    ["another version", '"v0-today"'],
    ["the version without its quotes", "v1-today"],
    ["another page's version", '"v1-ideas"'],
    ["an empty header", ""],
  ])("sends the whole page when If-None-Match is %s", async (_what, header) => {
    const r = await start();
    const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie, "If-None-Match": header } });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("PAGE today");
  });

  it("does not answer 304 to somebody without the key, whatever version they name", async () => {
    const r = await start();
    for (const header of ['"v1-today"', "*"]) {
      const answer = await ask(r.port, "/", { headers: { "If-None-Match": header } });
      expect(answer.status).toBe(401);
      expect(answer.headers.etag).toBeUndefined();
    }
  });

  it("serves the Site's own not-found page with 404, without a version, and never as 304", async () => {
    const r = await start();
    const tries: Array<Record<string, string>> = [{ Cookie: r.cookie }, { Cookie: r.cookie, "If-None-Match": '"gone"' }, { Cookie: r.cookie, "If-None-Match": "*" }];
    for (const headers of tries) {
      const answer = await ask(r.port, "/ideas/gone", { headers });
      expect(answer.status).toBe(404);
      expect(answer.text).toBe("<!doctype html><p>NO SUCH IDEA</p>");
      expect(answer.headers.etag).toBeUndefined();
    }
  });

  it("answers 404 with the not-found page for an address on no list, with or without the key", async () => {
    const r = await start();
    const tries: Array<Record<string, string>> = [{}, { Cookie: r.cookie }];
    for (const headers of tries) {
      const answer = await ask(r.port, "/no-such-page", { headers });
      expect(answer.status).toBe(404);
      expect(answer.text).toBe("<!doctype html><p>PROBLEM not-found</p>");
    }
    expect(r.site.pages).toEqual([]);
  });

  it.each([
    ["has no quotes", "v1"],
    ["is empty", ""],
    ["is only quotes", '""'],
    ["has a quote inside", '"a"b"'],
    ["has a space", '"a b"'],
    ["has a new line and a header of its own", '"a"\r\nX-Injected: 1'],
    ["is not text", 7 as unknown as string],
  ])("sends the page without a version, and never 304, when the Site's version %s", async (_what, etag) => {
    const site = stubSite({ page: () => ({ status: 200, html: html`<p>PAGE</p>`, etag }) });
    const r = await start({ site });
    const tries: Array<Record<string, string>> = [{ Cookie: r.cookie }, { Cookie: r.cookie, "If-None-Match": "*" }];
    // Name the very same version back, when it is something a client can send at all.
    if (/^[\x20-\x7e]+$/.test(String(etag))) tries.push({ Cookie: r.cookie, "If-None-Match": String(etag) });
    for (const headers of tries) {
      const answer = await ask(r.port, "/", { headers });
      expect(answer.status).toBe(200);
      expect(answer.text).toBe("<p>PAGE</p>");
      expect(answer.headers.etag).toBeUndefined();
      expect(answer.headers["x-injected"]).toBeUndefined();
    }
  });
});

describe("the three files and the screenshots", () => {
  it("serves the stylesheet, the script and the icon with their types, without the key", async () => {
    const r = await start();
    for (const [name, asset] of ASSETS) {
      const answer = await ask(r.port, `/assets/${name}`);
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toBe(asset.type);
      expect(answer.body.equals(asset.body)).toBe(true);
      expect(answer.headers["content-length"]).toBe(String(asset.body.length));
    }
    expect(r.site.pages).toEqual([]);
  });

  it("answers 404 for a file it was not handed", async () => {
    const assets = new Map(ASSETS);
    assets.delete("icon.svg");
    const r = await start({ assets });
    const answer = await ask(r.port, "/assets/icon.svg");
    expect(answer.status).toBe(404);
    expect(answer.text).toBe("<!doctype html><p>PROBLEM not-found</p>");
  });

  it("serves a screenshot as image/png, byte for byte, and asks the Site with the id and the size", async () => {
    const r = await start();
    for (const which of ["phone", "desktop"]) {
      const answer = await ask(r.port, `/shots/idea_01/${which}.png`, { headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toBe("image/png");
      expect(answer.body.equals(PNG)).toBe(true);
      expect(answer.headers.etag).toBeUndefined();
    }
    expect(r.site.shots).toEqual([
      ["idea_01", "phone"],
      ["idea_01", "desktop"],
    ]);
  });

  it("answers 404 for a screenshot the Site does not have", async () => {
    const r = await start();
    const answer = await ask(r.port, "/shots/gone/desktop.png", { headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(404);
    expect(answer.text).toBe("<!doctype html><p>PROBLEM not-found</p>");
  });

  it("answers 500 when the Site hands back something that is not a picture's bytes", async () => {
    const site = stubSite({ shot: () => SECRET as unknown as Buffer });
    const r = await start({ site });
    const answer = await ask(r.port, "/shots/idea_01/phone.png", { headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(500);
    expect(answer.text).not.toContain("SECRET");
  });
});

describe("when the Site goes wrong", () => {
  it("answers 500 with the Site's error page, and neither the browser nor the log gets the error's message", async () => {
    const site = stubSite({ page: () => { throw new Error(SECRET); } });
    const r = await start({ site });
    const answer = await ask(r.port, "/ideas/idea_01", { headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(500);
    expect(answer.text).toBe("<!doctype html><p>PROBLEM error</p>");
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(answer.headers.etag).toBeUndefined();
    expect(r.lines).toEqual(["dashboard: failed while making the idea page (Error)"]);
    expect(JSON.stringify(answer.headers) + answer.text + r.lines.join("\n")).not.toContain("SECRET");
  });

  it("logs the kind of error and its code, when it has a plain one", async () => {
    class DatabaseTrouble extends Error {
      code = "SQLITE_BUSY";
      constructor() {
        super(SECRET);
        this.name = "SqliteError";
      }
    }
    const errors: unknown[] = [new TypeError(SECRET), new DatabaseTrouble(), Object.assign(new Error(SECRET), { code: SECRET }), Object.assign(new Error(SECRET), { name: SECRET }), SECRET, null, { message: SECRET }];
    const expected = ["TypeError", "SqliteError SQLITE_BUSY", "Error", "Error", "not an Error", "not an Error", "not an Error"];
    for (const [index, error] of errors.entries()) {
      const site = stubSite({ page: () => { throw error; } });
      const r = await start({ site });
      const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(500);
      expect(r.lines).toEqual([`dashboard: failed while making the today page (${expected[index]})`]);
      expect(answer.text + r.lines.join("\n")).not.toContain("SECRET");
    }
  });

  it("says what it was doing: a screenshot, or the needs-key page", async () => {
    const one = await start({ site: stubSite({ shot: () => { throw new RangeError(SECRET); } }) });
    expect((await ask(one.port, "/shots/idea_01/phone.png", { headers: { Cookie: one.cookie } })).status).toBe(500);
    expect(one.lines).toEqual(["dashboard: failed while reading a screenshot (RangeError)"]);

    const site = stubSite();
    const real = site.problem.bind(site);
    site.problem = (kind) => {
      if (kind === "needs-key") throw new Error(SECRET);
      return real(kind);
    };
    const two = await start({ site });
    const answer = await ask(two.port, "/");
    expect(answer.status).toBe(500);
    expect(answer.text).toBe("<!doctype html><p>PROBLEM error</p>");
    expect(two.lines).toEqual(["dashboard: failed while checking the request (Error)"]);
  });

  it("answers 500 in its own plain words when even the error page cannot be made", async () => {
    const site = stubSite({ page: () => { throw new Error(SECRET); }, problem: () => { throw new Error(SECRET); } });
    const r = await start({ site });
    const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(500);
    expect(answer.text).toBe("The dashboard could not make this page.\n");
    expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expectSecurityHeaders(answer.headers);
    expect(answer.text).not.toContain("SECRET");
  });

  it("still answers when the log itself throws", async () => {
    const site = stubSite({ page: () => { throw new Error(SECRET); } });
    const r = await start({ site, log: () => { throw new Error("the log is broken"); } });
    const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(500);
    expect(answer.text).toBe("<!doctype html><p>PROBLEM error</p>");
    // And the server is still there for the next request.
    expect((await ask(r.port, "/assets/app.css")).status).toBe(200);
  });

  it("keeps serving after a failure", async () => {
    let fail = true;
    const base = stubSite();
    const site = stubSite({
      page: (route) => {
        if (fail) throw new Error(SECRET);
        return base.page(route);
      },
    });
    const r = await start({ site });
    expect((await ask(r.port, "/", { headers: { Cookie: r.cookie } })).status).toBe(500);
    fail = false;
    expect((await ask(r.port, "/", { headers: { Cookie: r.cookie } })).status).toBe(200);
  });

  it("hangs up, and carries on, when something fails after the headers have gone", async () => {
    // A stand-in file whose body cannot be written: the headers are out before that is found.
    const assets = new Map(ASSETS);
    assets.set("app.js", { type: "text/javascript; charset=utf-8", body: { length: 3 } as unknown as Buffer });
    const r = await start({ assets });
    await expect(ask(r.port, "/assets/app.js")).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(r.lines).toEqual(["dashboard: failed while sending one of its own files (TypeError ERR_INVALID_ARG_TYPE)"]);
    expect((await ask(r.port, "/assets/app.css")).status).toBe(200);
  });

  it("refuses to send a page that is a plain string, however it got here", async () => {
    const stringPage = `<p>${SECRET}</p><script>alert(1)</script>` as unknown as SafeHtml;
    const lookAlike = { text: `<p>${SECRET}</p>`, toString: () => SECRET } as unknown as SafeHtml;
    for (const page of [stringPage, lookAlike]) {
      const site = stubSite({ page: () => ({ status: 200, html: page, etag: '"v1"' }) });
      const r = await start({ site });
      const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(500);
      expect(answer.text).toBe("<!doctype html><p>PROBLEM error</p>");
      expect(r.lines).toEqual(["dashboard: failed while making the today page (TypeError)"]);
    }
  });

  it("refuses a problem page that is a plain string too", async () => {
    const site = stubSite({ problem: () => `<p>${SECRET}</p>` as unknown as SafeHtml });
    const r = await start({ site });
    for (const target of ["/", "/no-such-page"]) {
      const answer = await ask(r.port, target);
      expect(answer.status).toBe(500);
      expect(answer.text).toBe("The dashboard could not make this page.\n");
    }
  });

  it("answers 500 when the Site names a status that is not 200 or 404", async () => {
    for (const status of [201, 302, 500, 0]) {
      const site = stubSite({ page: () => ({ status: status as 200, html: html`<p>PAGE</p>`, etag: '"v1"' }) });
      const r = await start({ site });
      const answer = await ask(r.port, "/", { headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(500);
      expect(answer.text).toBe("<!doctype html><p>PROBLEM error</p>");
    }
  });

  it("writes its notes to standard output when no log is handed in", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const site = stubSite({ page: () => { throw new Error(SECRET); } });
      const r = await start({ site, log: undefined });
      expect((await ask(r.port, "/", { headers: { Cookie: r.cookie } })).status).toBe(500);
      expect(spy.mock.calls).toEqual([["dashboard: failed while making the today page (Error)"]]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("what it refuses in plain words", () => {
  it("answers 405 with the methods it does take, and hangs up", async () => {
    const r = await start();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const answer = await ask(r.port, "/", { method, headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(405);
      expect(answer.headers.allow).toBe("GET, HEAD");
      expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(answer.text).toBe("The dashboard only reads. It answers GET and HEAD requests and nothing else.\n");
    }
    expect(r.site.pages).toEqual([]);
  });

  it("answers a POST at once and hangs up, without waiting for the body it was promised", async () => {
    const r = await start();
    const answer = await raw(r.port, `POST / HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${r.cookie}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{"only the start`, 3000);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeLessThan(1000);
    expectSecurityHeaders(head(answer.got).headers);
  });

  it.each([
    [400, "/ideas#top", "The dashboard could not read that address.\n"],
    [414, `/${"a".repeat(2000)}`, "That address is too long for the dashboard.\n"],
  ])("answers %i in a sentence of its own", async (status, target, words) => {
    const r = await start();
    const answer = await ask(r.port, target, { headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(status);
    expect(answer.text).toBe(words);
    expect(answer.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it.each([
    ["400", (r: Running) => `GET /ideas#top HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${r.cookie}\r\n\r\n`, "HTTP/1.1 400 Bad Request"],
    ["403", (r: Running) => `GET / HTTP/1.1\r\nHost: evil.example\r\nCookie: ${r.cookie}\r\n\r\n`, "HTTP/1.1 403 Forbidden"],
    ["405", (r: Running) => `DELETE / HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${r.cookie}\r\n\r\n`, "HTTP/1.1 405 Method Not Allowed"],
    ["414", (r: Running) => `GET /${"a".repeat(2000)} HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${r.cookie}\r\n\r\n`, "HTTP/1.1 414 URI Too Long"],
  ])("hangs up after a %s, though the client asked to keep the connection", async (_status, bytes, statusLine) => {
    const r = await start();
    const answer = await raw(r.port, bytes(r), 3000);
    expect(head(answer.got).statusLine).toBe(statusLine);
    expect(head(answer.got).headers.connection).toBe("close");
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeLessThan(1000);
  });

  it("keeps the connection after a 500 too: the answer is whole and nothing is cut off", async () => {
    const r = await start({ site: stubSite({ page: () => { throw new Error(SECRET); } }) });
    const answer = await raw(r.port, `GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${r.cookie}\r\n\r\n`, 250);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 500 Internal Server Error");
    expect(answer.got.endsWith("<!doctype html><p>PROBLEM error</p>")).toBe(true);
    expect(head(answer.got).headers.connection).toBe("keep-alive");
    expect(answer.hungUp).toBe(false);
  });

  it("keeps the connection for what a browser's own page loads get: a page, a file, the needs-key page, a 404", async () => {
    const r = await start();
    for (const [target, cookie, statusLine] of [
      ["/", r.cookie, "HTTP/1.1 200 OK"],
      ["/assets/app.css", "", "HTTP/1.1 200 OK"],
      ["/", "", "HTTP/1.1 401 Unauthorized"],
      ["/no-such-page", r.cookie, "HTTP/1.1 404 Not Found"],
    ] as const) {
      const answer = await raw(r.port, `GET ${target} HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${cookie}\r\n\r\n`, 250);
      expect(head(answer.got).statusLine).toBe(statusLine);
      expect(head(answer.got).headers.connection).toBe("keep-alive");
      expect(answer.hungUp).toBe(false);
    }
  });

  it("answers 403 in a sentence of its own, the same whatever was asked for", async () => {
    const r = await start();
    for (const target of ["/", "/ideas/idea_01", "/assets/app.css", "/no-such-page", `/?key=${KEY}`]) {
      const answer = await ask(r.port, target, { host: "evil.example", headers: { Cookie: r.cookie } });
      expect(answer.status).toBe(403);
      expect(answer.text).toBe("The dashboard answers only on this Mac, at its own address.\n");
      expect(answer.headers["set-cookie"]).toBeUndefined();
    }
    expect(r.site.pages).toEqual([]);
  });

  it("refuses a request with no Host header, itself and with the security headers", async () => {
    const r = await start();
    const answer = await ask(r.port, "/", { host: null, headers: { Cookie: r.cookie } });
    expect(answer.status).toBe(403);
    expect(answer.text).toBe("The dashboard answers only on this Mac, at its own address.\n");
    expectSecurityHeaders(answer.headers);
    const old = await raw(r.port, `GET / HTTP/1.0\r\nCookie: ${r.cookie}\r\n\r\n`);
    expect(head(old.got).statusLine).toBe("HTTP/1.1 403 Forbidden");
    expectSecurityHeaders(head(old.got).headers);
    expect(r.site.pages).toEqual([]);
  });

  it("refuses a request with two Host headers, whichever comes first", async () => {
    const r = await start();
    for (const hosts of [`Host: localhost:${r.port}\r\nHost: evil.example`, `Host: evil.example\r\nHost: localhost:${r.port}`, `Host: localhost:${r.port}\r\nHost: localhost:${r.port}`]) {
      const answer = await raw(r.port, `GET / HTTP/1.1\r\n${hosts}\r\nCookie: ${r.cookie}\r\n\r\n`);
      expect(head(answer.got).statusLine).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(r.site.pages).toEqual([]);
  });

  it("refuses a request that says twice where it comes from, if either says another site", async () => {
    const r = await start();
    const answer = await raw(r.port, `GET /assets/app.css HTTP/1.1\r\nHost: localhost:${r.port}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Site: cross-site\r\n\r\n`);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 403 Forbidden");
  });

  it("answers a whole address with a name in it, as a proxy would be sent, with 400", async () => {
    const r = await start();
    const answer = await raw(r.port, `GET http://localhost:${r.port}/ HTTP/1.1\r\nHost: localhost:${r.port}\r\nCookie: ${r.cookie}\r\n\r\n`);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 400 Bad Request");
    expectSecurityHeaders(head(answer.got).headers);
    expect(r.site.pages).toEqual([]);
  });
});

describe("what Node refuses before it is a request", () => {
  it.each([
    ["something that is not HTTP", "NOT HTTP AT ALL\r\n\r\n", "HTTP/1.1 400 Bad Request"],
    ["a null byte in the address", "GET /a\u0000b HTTP/1.1\r\nHost: x\r\n\r\n", "HTTP/1.1 400 Bad Request"],
    ["a space in the address", "GET /a b HTTP/1.1\r\nHost: x\r\n\r\n", "HTTP/1.1 400 Bad Request"],
    ["more than fifty headers", `GET / HTTP/1.1\r\nHost: x\r\n${Array.from({ length: 60 }, (_, n) => `X-Invented-${n}: 1\r\n`).join("")}\r\n`, "HTTP/1.1 431 Request Header Fields Too Large"],
    ["a header larger than Node takes", `GET / HTTP/1.1\r\nHost: x\r\nX-Invented: ${"a".repeat(20_000)}\r\n\r\n`, "HTTP/1.1 431 Request Header Fields Too Large"],
  ])("answers %s with the security headers, and hangs up", async (_what, bytes, statusLine) => {
    const r = await start();
    const answer = await raw(r.port, bytes);
    expect(head(answer.got).statusLine).toBe(statusLine);
    expectSecurityHeaders(head(answer.got).headers);
    expect(head(answer.got).headers.connection).toBe("close");
    expect(answer.hungUp).toBe(true);
    expect(r.site.pages).toEqual([]);
  });

  it("takes a request with fifty headers and refuses one with fifty-one", async () => {
    const r = await start();
    // Host, Connection and the invented ones make up the count.
    const withHeaders = (count: number): string => `GET /assets/app.css HTTP/1.1\r\nHost: localhost:${r.port}\r\n${Array.from({ length: count - 2 }, (_, n) => `X-Invented-${n}: 1\r\n`).join("")}Connection: close\r\n\r\n`;
    expect(head((await raw(r.port, withHeaders(50))).got).statusLine).toBe("HTTP/1.1 200 OK");
    expect(head((await raw(r.port, withHeaders(51))).got).statusLine).toBe("HTTP/1.1 431 Request Header Fields Too Large");
  });

  it("is not disturbed by a client that breaks off in the middle of a request", async () => {
    const r = await start();
    await new Promise<void>((resolve) => {
      const socket = net.connect({ port: r.port, host: "127.0.0.1" });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
      socket.on("connect", () => {
        socket.write(`GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nX-Invented: half a hea`);
        setTimeout(() => socket.resetAndDestroy(), 50);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await ask(r.port, "/", { headers: { Cookie: r.cookie } })).status).toBe(200);
    expect(r.lines).toEqual([]);
  });

  it("does not say 100 Continue: an Expect request is judged like any other", async () => {
    const r = await start();
    const post = await raw(r.port, `POST / HTTP/1.1\r\nHost: localhost:${r.port}\r\nExpect: 100-continue\r\nContent-Length: 5\r\n\r\n`);
    expect(post.got).not.toContain("100 Continue");
    expect(head(post.got).statusLine).toBe("HTTP/1.1 405 Method Not Allowed");
    expectSecurityHeaders(head(post.got).headers);

    const get = await raw(r.port, `GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nExpect: 100-continue\r\nCookie: ${r.cookie}\r\nConnection: close\r\n\r\n`);
    expect(get.got).not.toContain("100 Continue");
    expect(head(get.got).statusLine).toBe("HTTP/1.1 200 OK");

    const odd = await raw(r.port, `GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nExpect: something-else\r\nConnection: close\r\n\r\n`);
    expect(head(odd.got).statusLine).toBe("HTTP/1.1 401 Unauthorized");
    expectSecurityHeaders(head(odd.got).headers);
  });

  it("treats a request to switch to a web socket as a plain request, and the gate refuses it from another site", async () => {
    const r = await start();
    const answer = await raw(
      r.port,
      `GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://evil.example\r\nSec-WebSocket-Key: aW52ZW50ZWQta2V5LTAxMjM=\r\nSec-WebSocket-Version: 13\r\nCookie: ${r.cookie}\r\n\r\n`,
    );
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 403 Forbidden");
    expect(answer.got).not.toContain("101");
  });
});

describe("the time limits", () => {
  it("are ten seconds for a request, five for its headers, five for an idle connection, fifty headers, checked every second", () => {
    expect(LIMITS).toEqual({ requestMs: 10_000, headersMs: 5_000, keepAliveMs: 5_000, maxHeaders: 50, checkEveryMs: 1_000 });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });

  // Each limit is tried with the other two left long, so that it is this one that cuts.
  const slowHeaders = { headersMs: 200, requestMs: 8_000, keepAliveMs: 8_000, checkEveryMs: 50 };
  const slowBody = { headersMs: 200, requestMs: 500, keepAliveMs: 8_000, checkEveryMs: 50 };
  const idle = { headersMs: 8_000, requestMs: 8_000, keepAliveMs: 100, checkEveryMs: 50 };

  it("hangs up on a connection that says nothing, with 408 and the security headers", async () => {
    const r = await start({ limits: slowHeaders });
    const answer = await raw(r.port, "", 3000);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 408 Request Timeout");
    expectSecurityHeaders(head(answer.got).headers);
    expect(head(answer.got).headers.connection).toBe("close");
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeGreaterThanOrEqual(150);
    expect(answer.ms).toBeLessThan(1500);
  });

  it("hangs up on a request whose headers never finish", async () => {
    const r = await start({ limits: slowHeaders });
    const answer = await raw(r.port, `GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nX-Invented: never fin`, 3000);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 408 Request Timeout");
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeLessThan(1500);
    expect(r.site.pages).toEqual([]);
  });

  it("hangs up on a request whose promised body never comes, though it was answered at once", async () => {
    const r = await start({ limits: slowBody });
    const answer = await raw(r.port, `GET /assets/app.css HTTP/1.1\r\nHost: localhost:${r.port}\r\nContent-Length: 10\r\n\r\nabc`, 3000);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 200 OK");
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeGreaterThanOrEqual(400);
    expect(answer.ms).toBeLessThan(2000);
  });

  it("hangs up on a connection left idle after an answer", async () => {
    // Node adds a second of its own to this wait, so a browser's next request is not cut off mid-way.
    const r = await start({ limits: idle });
    const answer = await raw(r.port, `GET /assets/app.css HTTP/1.1\r\nHost: localhost:${r.port}\r\n\r\n`, 4000);
    expect(head(answer.got).statusLine).toBe("HTTP/1.1 200 OK");
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeLessThan(2500);
  });

  it("waits longer than that by default", async () => {
    const r = await start();
    const answer = await raw(r.port, "", 600);
    expect(answer.hungUp).toBe(false);
    expect(answer.got).toBe("");
  });
});

describe("starting and stopping", () => {
  it("refuses a port that is not a port, and a key that is not fit to be one, before it listens", () => {
    for (const port of [-1, 65_536, 1.5, Number.NaN, "4321" as unknown as number]) {
      expect(() => createDashboard({ site: stubSite(), port, assets: ASSETS })).toThrow(RangeError);
    }
    for (const key of ["", "short", "a".repeat(31), `${"a".repeat(32)};`, `${"a".repeat(32)} `]) {
      expect(() => createDashboard({ site: stubSite(), port: 0, key, assets: ASSETS })).toThrow(TypeError);
    }
  });

  it("does not put a refused key in its error", () => {
    let message = "did not throw";
    try {
      createDashboard({ site: stubSite(), port: 0, key: "refused-key-SENTINEL;", assets: ASSETS });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("The dashboard's key must be 32 to 128 letters, digits, - or _.");
  });

  it("rejects with EADDRINUSE when the port is taken, and the first dashboard carries on", async () => {
    const first = await start();
    const second = createDashboard({ site: stubSite(), port: first.port, key: KEY, assets: ASSETS, log: () => {} });
    started.push(second);
    await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect((await ask(first.port, "/", { headers: { Cookie: first.cookie } })).status).toBe(200);
  });

  it("can only be started once", async () => {
    const r = await start();
    await expect(r.dashboard.listen()).rejects.toThrow("This dashboard was already started.");
    expect((await ask(r.port, "/", { headers: { Cookie: r.cookie } })).status).toBe(200);
  });

  it("stops answering when closed, and drops a connection that was being kept open", async () => {
    const r = await start();
    const agent = new http.Agent({ keepAlive: true });
    try {
      expect((await ask(r.port, "/", { headers: { Cookie: r.cookie }, agent })).status).toBe(200);
      const begun = Date.now();
      await r.dashboard.close();
      expect(Date.now() - begun).toBeLessThan(1000);
      expect(await connects("127.0.0.1", r.port)).toBe("ECONNREFUSED");
    } finally {
      agent.destroy();
    }
  });

  it("drops a connection that is in the middle of a request when closed, instead of waiting for it", async () => {
    const r = await start();
    const half = raw(r.port, `GET / HTTP/1.1\r\nHost: localhost:${r.port}\r\nX-Invented: half a hea`, 4000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const begun = Date.now();
    await r.dashboard.close();
    expect(Date.now() - begun).toBeLessThan(1000);
    const answer = await half;
    expect(answer.hungUp).toBe(true);
    expect(answer.ms).toBeLessThan(2000);
  });

  it("can be closed twice, and closed without ever being started", async () => {
    const r = await start();
    await r.dashboard.close();
    await r.dashboard.close();
    const never = createDashboard({ site: stubSite(), port: 0, key: KEY, assets: ASSETS });
    await never.close();
  });
});

describe("the dashboard's own files, when none are handed in", () => {
  it("serves the three files from the package's public folder", async () => {
    const folder = new URL("../public/", import.meta.url);
    const names = ["app.css", "app.js", "icon.svg"] as const;
    if (names.some((name) => !existsSync(new URL(name, folder)))) {
      // The pages part has not put its files there yet: a dashboard cannot be made without them.
      expect(() => createDashboard({ site: stubSite(), port: 0, key: KEY })).toThrow(/^The dashboard's own file public\/[a-z.]+ could not be read\.$/);
      return;
    }
    const r = await start({ assets: undefined });
    for (const name of names) {
      const answer = await ask(r.port, `/assets/${name}`);
      expect(answer.status).toBe(200);
      expect(answer.body.equals(readFileSync(new URL(name, folder)))).toBe(true);
    }
  });
});

describe("loadAssets", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function folderWith(files: Record<string, string>): URL {
    const folder = mkdtempSync(path.join(os.tmpdir(), "overnight-dashboard-assets-"));
    folders.push(folder);
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(folder, name), text);
    return pathToFileURL(`${folder}${path.sep}`);
  }

  it("reads the three files, each with its type", () => {
    const assets = loadAssets(folderWith({ "app.css": "/* invented */", "app.js": "// invented", "icon.svg": "<svg/>", "other.txt": "not served" }));
    expect([...assets.keys()]).toEqual(["app.css", "app.js", "icon.svg"]);
    expect(assets.get("app.css")).toEqual({ type: "text/css; charset=utf-8", body: Buffer.from("/* invented */") });
    expect(assets.get("app.js")).toEqual({ type: "text/javascript; charset=utf-8", body: Buffer.from("// invented") });
    expect(assets.get("icon.svg")).toEqual({ type: "image/svg+xml", body: Buffer.from("<svg/>") });
  });

  it("reads them once: a file changed afterwards is not what is served", async () => {
    const folder = folderWith({ "app.css": "first", "app.js": "first", "icon.svg": "first" });
    const r = await start({ assets: loadAssets(folder) });
    writeFileSync(new URL("app.css", folder), "second");
    expect((await ask(r.port, "/assets/app.css")).text).toBe("first");
  });

  it("says which file is missing, by its name and not by the folder's path", () => {
    const folder = folderWith({ "app.css": "x", "icon.svg": "x" });
    let message = "did not throw";
    try {
      loadAssets(folder);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("The dashboard's own file public/app.js could not be read.");
  });

  it("reads the package's own public folder when no folder is named", () => {
    const folder = new URL("../public/", import.meta.url);
    const names = ["app.css", "app.js", "icon.svg"] as const;
    const missing = names.find((name) => !existsSync(new URL(name, folder)));
    if (missing !== undefined) {
      // The pages part has not put its files there yet: then the error names the first one missing.
      expect(() => loadAssets()).toThrow(`The dashboard's own file public/${missing} could not be read.`);
      return;
    }
    const assets = loadAssets();
    for (const name of names) expect(assets.get(name)?.body.equals(readFileSync(new URL(name, folder)))).toBe(true);
  });
});
