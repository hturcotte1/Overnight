// The request gate: one test per check, and one per pair of checks for their order.
// Every key, id, host and address here is invented for the test.
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import { checkRequest, isUsableKey, keyCookie, keyCookieName, SECURITY_HEADERS } from "../src/server/guard.ts";
import type { GateCheck, Verdict } from "../src/server/guard.ts";
import type { Route } from "../src/types.ts";

const PORT = 4399;
const KEY = "invented-key-Aa0_-Zz9-0123456789";
const OTHER_KEY = "another-invented-key-0123456789ab";
const COOKIE = `${keyCookieName(PORT)}=${KEY}`;

interface Req {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

/** A request the gate lets through: our own address, a page, and the key cookie. */
function good(over: { method?: string; url?: string; headers?: IncomingHttpHeaders } = {}): Req {
  return { method: over.method ?? "GET", url: over.url ?? "/", headers: { host: `localhost:${PORT}`, cookie: COOKIE, ...over.headers } };
}

/** The same request without the cookie: somebody who does not have the key. */
function stranger(over: { method?: string; url?: string; headers?: IncomingHttpHeaders } = {}): Req {
  return good({ ...over, headers: { cookie: undefined, ...over.headers } });
}

function ask(r: Req, key: string = KEY): Verdict {
  return checkRequest(r, PORT, key);
}

function passes(route: Route, setKeyThenGoTo: string | null = null): Verdict {
  return { ok: true, route, setKeyThenGoTo };
}

function refused(status: 400 | 401 | 403 | 404 | 405 | 414, check: GateCheck): Verdict {
  return { ok: false, status, check };
}

/** What a browser sends when a person follows a link on another site. */
const LINK_CLICK = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

const ROUTES: Array<[string, Route]> = [
  ["/", { kind: "today" }],
  ["/ideas", { kind: "ideas" }],
  ["/ideas/idea_01-Chore", { kind: "idea", id: "idea_01-Chore" }],
  ["/ideas/7", { kind: "idea", id: "7" }],
  [`/ideas/${"a".repeat(80)}`, { kind: "idea", id: "a".repeat(80) }],
  ["/nights", { kind: "nights" }],
  ["/settings", { kind: "settings" }],
  ["/assets/app.css", { kind: "asset", name: "app.css" }],
  ["/assets/app.js", { kind: "asset", name: "app.js" }],
  ["/assets/icon.svg", { kind: "asset", name: "icon.svg" }],
  ["/shots/idea_01-Chore/phone.png", { kind: "shot", id: "idea_01-Chore", which: "phone" }],
  ["/shots/idea_01-Chore/desktop.png", { kind: "shot", id: "idea_01-Chore", which: "desktop" }],
];
const PAGES = ROUTES.filter(([, route]) => route.kind !== "asset" && route.kind !== "shot");

describe("a request the gate lets through", () => {
  it.each(ROUTES)("GET %s with the key cookie", (url, route) => {
    expect(ask(good({ url }))).toEqual(passes(route));
  });

  it.each(ROUTES)("HEAD %s with the key cookie", (url, route) => {
    expect(ask(good({ url, method: "HEAD" }))).toEqual(passes(route));
  });

  it("answers to 127.0.0.1 as well as to localhost", () => {
    expect(ask(good({ headers: { host: `127.0.0.1:${PORT}` } }))).toEqual(passes({ kind: "today" }));
  });

  it("has exactly these routes and no other", () => {
    expect(ROUTES.map(([url]) => url.replace(/idea_01-Chore|a{80}|7$/, "<id>"))).toEqual([
      "/",
      "/ideas",
      "/ideas/<id>",
      "/ideas/<id>",
      "/ideas/<id>",
      "/nights",
      "/settings",
      "/assets/app.css",
      "/assets/app.js",
      "/assets/icon.svg",
      "/shots/<id>/phone.png",
      "/shots/<id>/desktop.png",
    ]);
  });
});

describe("check 1: the method", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "PROPFIND", "get", "head", "", "GET "])("refuses %j with 405", (method) => {
    expect(ask(good({ method }))).toEqual(refused(405, "method"));
  });

  it("refuses a request with no method at all", () => {
    expect(checkRequest({ url: "/", headers: good().headers }, PORT, KEY)).toEqual(refused(405, "method"));
  });
});

describe("check 2: the Host header", () => {
  it.each([
    ["no Host at all", undefined],
    ["an empty Host", ""],
    ["another name", "evil.example"],
    ["another name on our port", `evil.example:${PORT}`],
    ["our name without the port", "localhost"],
    ["our name on another port", `localhost:${PORT + 1}`],
    ["our port with more digits after it", `localhost:${PORT}0`],
    ["our name in capitals", `LOCALHOST:${PORT}`],
    ["our name with a dot after it", `localhost.:${PORT}`],
    ["a name that only starts like ours", `localhost:${PORT}.evil.example`],
    ["a name that only ends like ours", `evil.example.localhost:${PORT}`],
    ["a name that starts with our number", `127.0.0.1.evil.example:${PORT}`],
    ["the IPv6 loopback", `[::1]:${PORT}`],
    ["every address", `0.0.0.0:${PORT}`],
    ["another loopback number", `127.0.0.2:${PORT}`],
    ["a user name in front", `user@localhost:${PORT}`],
    ["a space in front", ` localhost:${PORT}`],
    ["two Host headers, joined by the server", `localhost:${PORT}, evil.example`],
    ["two Host headers the other way round", `evil.example, localhost:${PORT}`],
  ])("refuses %s with 403", (_what, host) => {
    expect(ask(good({ headers: { host } }))).toEqual(refused(403, "host"));
  });

  it("compares with this dashboard's own port, not with any port", () => {
    expect(checkRequest(good(), PORT + 1, KEY)).toEqual(refused(403, "host"));
  });
});

describe("check 3: where the browser says the request comes from", () => {
  it.each([
    ["no Sec-Fetch-Site (not a browser, or an old one)", {}],
    ["our own page asking for more", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }],
    ["our own page loading a picture", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
    ["an address typed or pasted by a person", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }],
  ])("lets through %s", (_what, headers) => {
    expect(ask(good({ headers }))).toEqual(passes({ kind: "today" }));
    expect(ask(good({ url: "/assets/app.js", headers }))).toEqual(passes({ kind: "asset", name: "app.js" }));
  });

  it.each(PAGES)("lets a person follow a link from another site to the page %s", (url, route) => {
    expect(ask(good({ url, headers: LINK_CLICK }))).toEqual(passes(route));
    expect(ask(good({ url, headers: { ...LINK_CLICK, "sec-fetch-site": "same-site" } }))).toEqual(passes(route));
  });

  it("lets the key link be clicked on a web page: a link from another site, to a page, with the key", () => {
    expect(ask(stranger({ url: `/?key=${KEY}`, headers: LINK_CLICK }))).toEqual(passes({ kind: "today" }, "/"));
    expect(ask(stranger({ url: `/?key=${KEY}`, headers: { ...LINK_CLICK, "sec-fetch-site": "same-site" } }))).toEqual(passes({ kind: "today" }, "/"));
  });

  it("still asks a person who follows a link for the key", () => {
    expect(ask(stranger({ headers: LINK_CLICK }))).toEqual(refused(401, "key"));
  });

  it.each([
    ["a picture", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
    ["a script", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }],
    ["a stylesheet", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style" }],
    ["a background request", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }],
    ["a background request that hides where it goes", { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" }],
    ["a frame", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }],
    ["an old-style frame", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "frame" }],
    ["an embedded object", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "object" }],
    ["an embed", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "embed" }],
    ["a web socket", { "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" }],
    ["a navigation that does not say what for", { "sec-fetch-mode": "navigate" }],
    ["a document that does not say how", { "sec-fetch-dest": "document" }],
    ["a request that says neither", {}],
    ["the right words in capitals", { "sec-fetch-mode": "NAVIGATE", "sec-fetch-dest": "DOCUMENT" }],
    ["the right words twice", { "sec-fetch-mode": "navigate, navigate", "sec-fetch-dest": "document" }],
  ])("refuses %s from another site, even with the key cookie", (_what, how) => {
    for (const from of ["cross-site", "same-site"]) {
      expect(ask(good({ headers: { "sec-fetch-site": from, ...how } }))).toEqual(refused(403, "cross-site"));
    }
  });

  it.each([
    ["the stylesheet", "/assets/app.css"],
    ["the script", "/assets/app.js"],
    ["the icon", "/assets/icon.svg"],
    ["a screenshot", "/shots/idea_01-Chore/phone.png"],
    ["an address that is on no list", "/no-such-page"],
    ["an address that cannot be read", "/a b"],
    ["an address that is too long", `/${"a".repeat(2000)}`],
    ["no address", undefined],
  ])("refuses a link from another site to %s with 403: only pages can be linked to", (_what, url) => {
    const r: Req = { method: "GET", headers: { ...good().headers, ...LINK_CLICK } };
    if (url !== undefined) r.url = url;
    expect(ask(r)).toEqual(refused(403, "cross-site"));
  });

  it.each([
    ["an empty value", ""],
    ["a word it does not know", "elsewhere"],
    ["the right word in capitals", "SAME-ORIGIN"],
    ["the right word with a space", "same-origin "],
    ["two headers, joined by the server", "same-origin, cross-site"],
    ["two headers that both look fine", "none, none"],
  ])("treats %s as another site", (_what, from) => {
    expect(ask(good({ headers: { "sec-fetch-site": from, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } }))).toEqual(refused(403, "cross-site"));
    expect(ask(good({ headers: { "sec-fetch-site": from, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }))).toEqual(passes({ kind: "today" }));
  });

  it("treats a header that arrives as a list as another site", () => {
    const headers = { ...good().headers, "sec-fetch-site": ["same-origin"] } as unknown as IncomingHttpHeaders;
    expect(ask({ method: "GET", url: "/assets/app.css", headers })).toEqual(refused(403, "cross-site"));
  });
});

describe("check 4: the Origin header", () => {
  it("lets through a request with no Origin, and one that names our own address", () => {
    expect(ask(good())).toEqual(passes({ kind: "today" }));
    expect(ask(good({ headers: { origin: `http://localhost:${PORT}` } }))).toEqual(passes({ kind: "today" }));
    expect(ask(good({ headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` } }))).toEqual(passes({ kind: "today" }));
  });

  it.each([
    ["another site", "http://evil.example"],
    ["another site on our port", `http://evil.example:${PORT}`],
    ["our address over https", `https://localhost:${PORT}`],
    ["our address on another port", `http://localhost:${PORT + 1}`],
    ["our address without the port", "http://localhost"],
    ["our address with a slash after it", `http://localhost:${PORT}/`],
    ["our other address (the page was opened at the other one)", `http://127.0.0.1:${PORT}`],
    ["a page that hides its origin", "null"],
    ["an empty Origin", ""],
    ["our address in capitals", `HTTP://LOCALHOST:${PORT}`],
    ["two Origin headers, joined by the server", `http://localhost:${PORT}, http://evil.example`],
  ])("refuses %s with 403", (_what, origin) => {
    expect(ask(good({ headers: { origin } }))).toEqual(refused(403, "origin"));
  });

  it("refuses a foreign Origin even on a link a person followed", () => {
    expect(ask(good({ headers: { ...LINK_CLICK, origin: "http://evil.example" } }))).toEqual(refused(403, "origin"));
  });
});

describe("check 5: the address", () => {
  it("refuses an address over 2,000 characters with 414, and not one of exactly 2,000", () => {
    expect(ask(good({ url: `/${"a".repeat(2000)}` }))).toEqual(refused(414, "address"));
    expect(ask(good({ url: `/?${"a".repeat(1999)}` }))).toEqual(refused(414, "address"));
    expect(ask(good({ url: `/${"a".repeat(1999)}` }))).toEqual(refused(404, "address"));
    expect(ask(good({ url: `/?${"a".repeat(1998)}` }))).toEqual(passes({ kind: "today" }));
  });

  it.each([
    ["nothing", ""],
    ["no slash in front", "ideas"],
    ["a whole address with a name in it", `http://localhost:${PORT}/`],
    ["a star", "*"],
    ["a space", "/ideas/a b"],
    ["a tab", "/ideas\t"],
    ["a new line", "/ideas\n/settings"],
    ["a null byte", "/ideas/a\u0000b"],
    ["a delete character", "/ideas/\u007f"],
    ["a letter outside plain ASCII", "/idées"],
    ["a right-to-left override", "/ideas/‮abc"],
    ["a backslash", "/ideas\\..\\settings"],
    ["a backslash after the question mark", "/?a=\\"],
    ["a fragment", "/ideas#top"],
  ])("refuses an address with %s with 400", (_what, url) => {
    expect(ask(good({ url }))).toEqual(refused(400, "address"));
  });

  it("refuses a request with no address with 400", () => {
    expect(checkRequest({ method: "GET", headers: good().headers }, PORT, KEY)).toEqual(refused(400, "address"));
  });

  it.each([
    "//",
    "//ideas",
    "//evil.example/",
    "/ideas/",
    "/ideas//",
    "/ideas//idea_01",
    "/ideas/idea_01/",
    "/ideas/idea_01/more",
    "/nights/",
    "/settings/",
    "/Ideas",
    "/IDEAS",
    "/index.html",
    "/favicon.ico",
    "/today",
    "/%2e%2e",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/..",
    "/../settings",
    "/./ideas",
    "/ideas/..",
    "/ideas/.",
    "/ideas/%2e%2e",
    "/ideas/..%2fsettings",
    "/ideas/%00",
    "/%00",
    "/ideas%00",
    "/%69deas",
    "/ideas%2fidea_01",
    "/ideas;x=1",
    "/assets",
    "/assets/",
    "/assets/app.css/",
    "/assets/app.CSS",
    "/assets/app.css.map",
    "/assets/app.ts",
    "/assets/../src/server/guard.ts",
    "/assets/%2e%2e/package.json",
    "/assets//app.css",
    "/public/app.css",
    "/shots",
    "/shots/",
    "/shots/idea_01",
    "/shots/idea_01/",
    "/shots/idea_01/phone",
    "/shots/idea_01/phone.jpg",
    "/shots/idea_01/phone_png",
    "/shots/idea_01/phonexpng",
    "/shots/idea_01/phone.png.png",
    "/shots/idea_01/xphone.png",
    "/shots/idea_01/phone.png/",
    "/shots/idea_01/tablet.png",
    "/shots/idea_01/PHONE.png",
    "/shots//phone.png",
    "/shots/../phone.png",
    "/shots/idea_01/../phone.png",
    "/shots/idea_01-desktop.png",
  ])("answers 404 for %s, which is on no list", (url) => {
    expect(ask(good({ url }))).toEqual(refused(404, "address"));
  });

  it.each([
    ["starts with a dash", "-idea"],
    ["starts with an underscore", "_idea"],
    ["has a dot", "idea.01"],
    ["is two dots", ".."],
    ["has an encoded space", "idea%2001"],
    ["has a plus", "idea+01"],
    ["has a tilde", "~idea"],
    ["has a colon", "idea:01"],
    ["has an at sign", "idea@01"],
    ["is 81 characters long", "a".repeat(81)],
  ])("answers 404 for an idea id that %s, on the idea page and on a screenshot", (_what, id) => {
    expect(ask(good({ url: `/ideas/${id}` }))).toEqual(refused(404, "address"));
    expect(ask(good({ url: `/shots/${id}/phone.png` }))).toEqual(refused(404, "address"));
  });

  it("ignores what comes after the question mark, apart from the key", () => {
    expect(ask(good({ url: "/ideas?sort=new&page=2" }))).toEqual(passes({ kind: "ideas" }));
    expect(ask(good({ url: "/assets/app.css?v=3" }))).toEqual(passes({ kind: "asset", name: "app.css" }));
    expect(ask(good({ url: "/?" }))).toEqual(passes({ kind: "today" }));
    expect(ask(good({ url: "/ideas?/../settings" }))).toEqual(passes({ kind: "ideas" }));
  });
});

describe("check 6: the key", () => {
  it.each(ROUTES.filter(([, route]) => route.kind !== "asset"))("answers 401 for %s without the cookie", (url) => {
    expect(ask(stranger({ url }))).toEqual(refused(401, "key"));
  });

  it.each(ROUTES.filter(([, route]) => route.kind === "asset"))("serves %s without the cookie: it holds no data", (url, route) => {
    expect(ask(stranger({ url }))).toEqual(passes(route));
  });

  it.each([
    ["a wrong key", `${keyCookieName(PORT)}=${OTHER_KEY}`],
    ["an empty key", `${keyCookieName(PORT)}=`],
    ["the key cut short", `${keyCookieName(PORT)}=${KEY.slice(0, -1)}`],
    ["the key with one more character", `${keyCookieName(PORT)}=${KEY}x`],
    ["the key in other capitals", `${keyCookieName(PORT)}=${KEY.toUpperCase()}`],
    ["the key in quotes", `${keyCookieName(PORT)}="${KEY}"`],
    ["the key under another port's name", `${keyCookieName(PORT + 1)}=${KEY}`],
    ["the key under a longer name", `${keyCookieName(PORT)}0=${KEY}`],
    ["the key under a name with something in front", `x${keyCookieName(PORT)}=${KEY}`],
    ["the key under the name in capitals", `${keyCookieName(PORT).toUpperCase()}=${KEY}`],
    ["the key under the name without a port", `overnight_dashboard=${KEY}`],
    ["the key as the value of another cookie", `session=${keyCookieName(PORT)}=${KEY}`],
    ["the key with no name", KEY],
    ["the name with no key", keyCookieName(PORT)],
    ["an empty Cookie header", ""],
  ])("answers 401 for a cookie that holds %s", (_what, cookie) => {
    expect(ask(good({ headers: { cookie } }))).toEqual(refused(401, "key"));
  });

  it.each([
    ["alone", COOKIE],
    ["among others", `theme=dark; ${COOKIE}; other=1`],
    ["without the space after the semicolon", `theme=dark;${COOKIE};other=1`],
    ["with spaces around it", `theme=dark;   ${keyCookieName(PORT)} = ${KEY}  ; other=1`],
    ["after a planted cookie of the same name", `${keyCookieName(PORT)}=${OTHER_KEY}; ${COOKIE}`],
    ["before a planted cookie of the same name", `${COOKIE}; ${keyCookieName(PORT)}=${OTHER_KEY}`],
    ["beside the cookie of a dashboard on another port", `${keyCookieName(PORT + 1)}=${OTHER_KEY}; ${COOKIE}`],
  ])("lets through the right cookie %s", (_what, cookie) => {
    expect(ask(good({ headers: { cookie } }))).toEqual(passes({ kind: "today" }));
  });

  it.each(PAGES)("the key link to %s hands out the cookie and goes to the plain address", (url, route) => {
    expect(ask(stranger({ url: `${url}?key=${KEY}` }))).toEqual(passes(route, url));
    expect(ask(good({ url: `${url}?key=${KEY}` }))).toEqual(passes(route, url));
    expect(ask(stranger({ url: `${url}?key=${KEY}`, method: "HEAD" }))).toEqual(passes(route, url));
  });

  it("builds the plain address from the route, and copies nothing else from the link", () => {
    expect(ask(stranger({ url: `/ideas/idea_01?next=//evil.example&key=${KEY}&more=1` }))).toEqual(passes({ kind: "idea", id: "idea_01" }, "/ideas/idea_01"));
    expect(ask(stranger({ url: `/?a=1&key=${KEY}` }))).toEqual(passes({ kind: "today" }, "/"));
  });

  it.each([
    ["a wrong key", `?key=${OTHER_KEY}`],
    ["an empty key", "?key="],
    ["the word key alone", "?key"],
    ["the key cut short", `?key=${KEY.slice(0, -1)}`],
    ["the key with a full stop after it", `?key=${KEY}.`],
    ["the key with one letter written as %41", `?key=${KEY.replace("A", "%41")}`],
    ["the key under another name", `?Key=${KEY}`],
    ["the key under a longer name", `?mykey=${KEY}`],
    ["a wrong key first and the right one second", `?key=${OTHER_KEY}&key=${KEY}`],
    ["the key after a second question mark", `?a=1?key=${KEY}`],
  ])("answers 401 for a link with %s", (_what, query) => {
    expect(ask(stranger({ url: `/${query}` }))).toEqual(refused(401, "key"));
  });

  it("serves the page, with no new cookie, when the link's key is stale but the cookie is right", () => {
    expect(ask(good({ url: `/?key=${OTHER_KEY}` }))).toEqual(passes({ kind: "today" }));
  });

  it("the key in the link opens pages only: not a screenshot, and it changes nothing for the three files", () => {
    expect(ask(stranger({ url: `/shots/idea_01/phone.png?key=${KEY}` }))).toEqual(refused(401, "key"));
    expect(ask(good({ url: `/shots/idea_01/phone.png?key=${KEY}` }))).toEqual(passes({ kind: "shot", id: "idea_01", which: "phone" }));
    expect(ask(stranger({ url: `/assets/app.css?key=${KEY}` }))).toEqual(passes({ kind: "asset", name: "app.css" }));
  });

  it("refuses a key of any length without throwing", () => {
    for (const offered of ["", "a", "a".repeat(31), "a".repeat(33), "a".repeat(1500)]) {
      expect(ask(stranger({ url: `/?key=${offered}` }))).toEqual(refused(401, "key"));
      expect(ask(good({ headers: { cookie: `${keyCookieName(PORT)}=${offered}` } }))).toEqual(refused(401, "key"));
    }
  });

  it.each([
    ["an empty key", ""],
    ["a short key", "short-key"],
    ["a key of 31 characters", "a".repeat(31)],
    ["a key with a semicolon", `${"a".repeat(31)};`],
    ["a key with a full stop", `${"a".repeat(16)}.${"a".repeat(16)}`],
    ["a key with an equals sign", `${"a".repeat(31)}=`],
  ])("opens nothing when the dashboard itself was given %s", (_what, badKey) => {
    expect(ask(stranger({ url: `/?key=${badKey}` }), badKey)).toEqual(refused(401, "key"));
    expect(ask(stranger({ url: "/?key=" }), badKey)).toEqual(refused(401, "key"));
    expect(ask(good({ headers: { cookie: `${keyCookieName(PORT)}=${badKey}` } }), badKey)).toEqual(refused(401, "key"));
    expect(ask(stranger({ url: "/assets/app.css" }), badKey)).toEqual(passes({ kind: "asset", name: "app.css" }));
  });
});

describe("the order of the checks", () => {
  const ORDER: GateCheck[] = ["method", "host", "cross-site", "origin", "address", "key"];
  const STATUS: Record<GateCheck, number> = { method: 405, host: 403, "cross-site": 403, origin: 403, address: 404, key: 401 };
  /** One way to fail each check, and that check only. */
  const BREAK: Record<GateCheck, (r: Req) => Req> = {
    method: (r) => ({ ...r, method: "POST" }),
    host: (r) => ({ ...r, headers: { ...r.headers, host: "evil.example" } }),
    "cross-site": (r) => ({ ...r, headers: { ...r.headers, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } }),
    origin: (r) => ({ ...r, headers: { ...r.headers, origin: "http://evil.example" } }),
    address: (r) => ({ ...r, url: "/no-such-page" }),
    key: (r) => ({ ...r, headers: { ...r.headers, cookie: undefined } }),
  };

  it.each(ORDER)("a request that fails only the %s check is refused by that check", (check) => {
    expect(ask(BREAK[check](good()))).toEqual({ ok: false, status: STATUS[check], check });
  });

  const pairs: Array<[GateCheck, GateCheck]> = [];
  for (const [index, earlier] of ORDER.entries()) for (const later of ORDER.slice(index + 1)) pairs.push([earlier, later]);

  it.each(pairs)("%s is checked before %s", (earlier, later) => {
    const expected = { ok: false, status: STATUS[earlier], check: earlier };
    expect(ask(BREAK[later](BREAK[earlier](good())))).toEqual(expected);
    expect(ask(BREAK[earlier](BREAK[later](good())))).toEqual(expected);
  });

  it("checks all fifteen pairs", () => {
    expect(pairs).toHaveLength(15);
  });

  it("a request that fails every check is refused for its method", () => {
    const everything = ORDER.reduce((r, check) => BREAK[check](r), good());
    expect(ask(everything)).toEqual(refused(405, "method"));
  });

  it("inside the address check: too long comes before unreadable, and unreadable before unknown", () => {
    expect(ask(good({ url: `/a b${"a".repeat(2000)}` }))).toEqual(refused(414, "address"));
    expect(ask(good({ url: "/no such page" }))).toEqual(refused(400, "address"));
    expect(ask(good({ url: "/no-such-page" }))).toEqual(refused(404, "address"));
  });

  it("an address that is too long, unreadable or unknown is told so before the key is asked for", () => {
    expect(ask(stranger({ url: `/${"a".repeat(2000)}` }))).toEqual(refused(414, "address"));
    expect(ask(stranger({ url: "/a b" }))).toEqual(refused(400, "address"));
    expect(ask(stranger({ url: "/no-such-page" }))).toEqual(refused(404, "address"));
    expect(ask(stranger({ url: `/no-such-page?key=${KEY}` }))).toEqual(refused(404, "address"));
  });

  it("a stranger from the wrong place learns nothing about the address: always 403", () => {
    for (const url of ["/", "/ideas/idea_01", "/assets/app.css", "/no-such-page", "/a b", `/${"a".repeat(2000)}`, `/?key=${KEY}`]) {
      expect(ask(BREAK.host(stranger({ url })))).toEqual(refused(403, "host"));
      expect(ask(BREAK["cross-site"](stranger({ url })))).toEqual(refused(403, "cross-site"));
      expect(ask(BREAK.origin(stranger({ url })))).toEqual(refused(403, "origin"));
    }
  });

  it("the right key does not open a door an earlier check closed", () => {
    for (const check of ["method", "host", "cross-site", "origin"] as const) {
      expect(ask(BREAK[check](good({ url: `/?key=${KEY}` })))).toEqual({ ok: false, status: STATUS[check], check });
    }
  });
});

describe("checkRequest is pure", () => {
  function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null) {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  }

  it("changes nothing it is given and answers the same every time", () => {
    const requests = [good(), stranger(), stranger({ url: `/ideas/idea_01?key=${KEY}` }), good({ url: "/shots/idea_01/phone.png", headers: LINK_CLICK }), good({ method: "POST" })];
    for (const r of requests) {
      const before = JSON.stringify(r);
      const frozen = deepFreeze(structuredClone(r));
      const first = ask(frozen);
      expect(ask(frozen)).toEqual(first);
      expect(ask(r)).toEqual(first);
      expect(JSON.stringify(r)).toBe(before);
    }
  });

  it("hands out a new route each time, so changing one answer cannot change the next", () => {
    const first = ask(good({ url: "/ideas" }));
    if (!first.ok) throw new Error("expected the request to pass");
    (first.route as { kind: string }).kind = "settings";
    expect(ask(good({ url: "/ideas" }))).toEqual(passes({ kind: "ideas" }));
  });

  it("never throws, whatever it is handed", () => {
    const odd = ["", " ", "\u0000", "%", "%%%", "?", "??", "&", "=", ";", ";;=;", "/".repeat(3000), "\ud800", "key=", "=key", "__proto__", "constructor", "/__proto__", "/constructor", "/ideas/__proto__", "/ideas/constructor"];
    const names = ["host", "cookie", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];
    for (const value of odd) {
      expect(() => ask(good({ url: value }))).not.toThrow();
      expect(() => ask(good({ url: `/?${value}` }))).not.toThrow();
      expect(() => ask(good({ method: value }))).not.toThrow();
      for (const name of names) expect(() => ask(good({ headers: { [name]: value } }))).not.toThrow();
      for (const name of names) expect(() => ask(good({ headers: { [name]: [value, value] } as unknown as IncomingHttpHeaders }))).not.toThrow();
    }
  });

  it("takes an idea id that is also the name of something every object has", () => {
    expect(ask(good({ url: "/ideas/constructor" }))).toEqual(passes({ kind: "idea", id: "constructor" }));
    expect(ask(good({ url: "/constructor" }))).toEqual(refused(404, "address"));
    expect(ask(good({ url: "/__proto__" }))).toEqual(refused(404, "address"));
  });
});

describe("the security headers", () => {
  it("are exactly these seven", () => {
    expect(SECURITY_HEADERS).toEqual({
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
    });
  });

  it("cannot be changed by another part of the program", () => {
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
  });

  it("never allow anything inline, anything from elsewhere, or another site to read an answer", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"] ?? "";
    expect(csp).not.toMatch(/unsafe|\*|https?:|data:|blob:/);
    expect(Object.keys(SECURITY_HEADERS).filter((name) => /^access-control/i.test(name))).toEqual([]);
  });
});

describe("the key and its cookie", () => {
  it("names the cookie after the port, so two dashboards on one Mac do not share one", () => {
    expect(keyCookieName(4321)).toBe("overnight_dashboard_4321");
    expect(keyCookieName(4322)).toBe("overnight_dashboard_4322");
  });

  it("writes the cookie so that scripts cannot read it and other sites' own requests never carry it", () => {
    expect(keyCookie(4321, KEY)).toBe(`overnight_dashboard_4321=${KEY}; HttpOnly; SameSite=Lax; Path=/`);
  });

  it("will not write a cookie for a key that is not fit to be one", () => {
    for (const bad of ["", "short", `${"a".repeat(31)};`, `${"a".repeat(32)}; Domain=evil.example`, `${"a".repeat(32)}\r\nSet-Cookie: x=1`]) {
      expect(() => keyCookie(4321, bad)).toThrow(TypeError);
    }
  });

  it("takes a key of 32 to 128 letters, digits, - and _, and nothing else", () => {
    expect(isUsableKey(KEY)).toBe(true);
    expect(isUsableKey("a".repeat(32))).toBe(true);
    expect(isUsableKey("a".repeat(128))).toBe(true);
    expect(isUsableKey("a".repeat(31))).toBe(false);
    expect(isUsableKey("a".repeat(129))).toBe(false);
    expect(isUsableKey("")).toBe(false);
    for (const character of [";", " ", "=", ",", '"', "+", "/", ".", "%", "\n", "é"]) {
      expect(isUsableKey(`${"a".repeat(31)}${character}`)).toBe(false);
      expect(isUsableKey(`${"a".repeat(32)}${character}`)).toBe(false);
    }
  });

  it("takes the kind of key the server makes: 24 random bytes in base64url", () => {
    for (let round = 0; round < 50; round += 1) {
      const made = randomBytes(24).toString("base64url");
      expect(made).toHaveLength(32);
      expect(isUsableKey(made)).toBe(true);
    }
  });
});
