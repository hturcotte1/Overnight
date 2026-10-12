// The request gate. Every request passes through `checkRequest` before anything is looked up
// or sent, and nothing else in the dashboard decides who may read a page.
//
// Why it is strict: the dashboard shows short quotes of what people said, and it listens on a
// port that every program on this Mac can reach, and that any web page open in a browser on
// this Mac can aim a request at. So a request is answered only when all six checks pass, and
// they are always made in this order:
//
//   1. method      GET or HEAD, nothing else                                 405
//   2. host        the Host header is our own address, to the letter         403
//   3. cross-site  another site may only send a person here by a link        403
//   4. origin      an Origin header, if there is one, must be our own        403
//   5. address     short, plain, and on the fixed list of routes             414, 400, 404
//   6. key         the key of this start, in the cookie or in the link       401
//
// The order matters: a request from somewhere it should not come from (1 to 4) is refused the
// same way whatever it asked for, so the answer tells it nothing about which pages exist.
//
// `checkRequest` is pure: it reads the three things it is given, changes nothing and keeps
// nothing. The web server acts on its verdict (server.ts).
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { IDEA_ID } from "../types.ts";
import type { AssetName, PageRoute, Route } from "../types.ts";

/**
 * The headers on every answer, errors included.
 * The first line lets a page load only its own stylesheet, script and pictures: no inline
 * script, no `style=`, no frames, no forms, nothing from anywhere else. Pages are built so
 * that they never need more (render/html.ts); this is the second fence behind that one.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
});

/** Which of the six checks refused a request. */
export type GateCheck = "method" | "host" | "cross-site" | "origin" | "address" | "key";

/**
 * What the gate decided.
 * `setKeyThenGoTo`: the request was the key link. Answer 303 to this path with the key cookie,
 * and send no page yet.
 * `check` names the check that refused. It is for tests and for reading the code; it is never
 * sent to the browser.
 */
export type Verdict =
  | { ok: true; route: Route; setKeyThenGoTo: string | null }
  | { ok: false; status: 400 | 401 | 403 | 404 | 405 | 414; check: GateCheck };

/** The longest address the gate reads. */
const MAX_URL_CHARS = 2000;

/** What a key looks like: 24 random bytes written in base64url are 32 of these characters. */
const USABLE_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * Is this fit to be a start's key? An empty or short key would open the dashboard to a guess,
 * and a key with a `;` in it would break the cookie, so neither is ever accepted.
 */
export function isUsableKey(key: string): boolean {
  return USABLE_KEY.test(key);
}

/**
 * The key cookie's name. Browsers do not keep cookies apart by port, so two dashboards on one
 * Mac (the real one and a demo) would overwrite each other's cookie if they shared a name.
 */
export function keyCookieName(port: number): string {
  return `overnight_dashboard_${port}`;
}

/**
 * The Set-Cookie line that goes with the key link.
 *   HttpOnly       the page's own script cannot read the key
 *   SameSite=Lax   sent when a person follows a link here, never with another site's own
 *                  requests (pictures, frames, background requests)
 * No end date: the browser drops it when it closes, and the key dies when the dashboard stops.
 */
export function keyCookie(port: number, key: string): string {
  if (!isUsableKey(key)) throw new TypeError("That is not a usable dashboard key.");
  return `${keyCookieName(port)}=${key}; HttpOnly; SameSite=Lax; Path=/`;
}

/** The whole gate. See the top of this file for the six checks and why they come in this order. */
export function checkRequest(r: { method?: string; url?: string; headers: IncomingHttpHeaders }, port: number, key: string): Verdict {
  // 1. The dashboard only reads, so it only answers the two methods that only read.
  if (r.method !== "GET" && r.method !== "HEAD") return refuse(405, "method");

  // 2. Our own address and nothing else. A web page that points a name of its own at 127.0.0.1
  //    arrives with that name in Host, and stops here.
  const host = r.headers.host;
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return refuse(403, "host");

  // The address is read once, here, but judged at check 5. Check 3 needs to know one thing
  // about it first: whether it is a page.
  const address = readAddress(r.url);
  const route = address.ok ? address.route : null;

  // 3. Browsers say where a request comes from. From our own pages, or typed or pasted by a
  //    person ("none"), it is welcome. From anywhere else only one thing is: a person following
  //    a link to a page, in a tab of its own. That lets the key link be clicked on a web page,
  //    and keeps out every picture, frame, script and background request another site could
  //    aim here. A program that is not a browser sends no such header; the key stops it.
  const from = r.headers["sec-fetch-site"];
  if (from !== undefined && from !== "same-origin" && from !== "none") {
    const followsALink = r.headers["sec-fetch-mode"] === "navigate" && r.headers["sec-fetch-dest"] === "document";
    if (!followsALink || route === null || !isPage(route)) return refuse(403, "cross-site");
  }

  // 4. A browser that names the sending page's origin must name ours.
  const origin = r.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return refuse(403, "origin");

  // 5. The address itself: not too long, readable, and on the list.
  if (!address.ok) return refuse(address.status, "address");
  if (route === null) return refuse(404, "address");

  // 6. The key.
  //    In the link, on a page: hand out the cookie and send the browser to the plain address,
  //    so the key leaves the address bar. The plain address is built from the route, never
  //    copied from the request.
  if (address.offeredKey !== null && isPage(route) && sameKey(address.offeredKey, key)) {
    return { ok: true, route, setKeyThenGoTo: pathOf(route) };
  }
  //    The stylesheet, the script and the icon hold no data and need no key: the page that
  //    says "open the dashboard from its link" uses them too.
  if (route.kind === "asset") return { ok: true, route, setKeyThenGoTo: null };
  if (cookieHoldsKey(r.headers.cookie, keyCookieName(port), key)) return { ok: true, route, setKeyThenGoTo: null };
  return refuse(401, "key");
}

function refuse(status: 400 | 401 | 403 | 404 | 405 | 414, check: GateCheck): Verdict {
  return { ok: false, status, check };
}

// ---------- The address ----------

type Address = { ok: true; route: Route | null; offeredKey: string | null } | { ok: false; status: 400 | 414 };

/**
 * Take a request's address apart without ever decoding it. What a browser sends for one of our
 * own links is a slash and then plain visible characters; anything else is not for us. A path
 * with `%2e%2e` or `%00` in it stays exactly those characters, so it matches no route.
 */
function readAddress(url: string | undefined): Address {
  if (url === undefined) return { ok: false, status: 400 };
  if (url.length > MAX_URL_CHARS) return { ok: false, status: 414 };
  if (!/^\/[\x21-\x7e]*$/.test(url) || url.includes("#") || url.includes("\\")) return { ok: false, status: 400 };
  const mark = url.indexOf("?");
  const path = mark === -1 ? url : url.slice(0, mark);
  const query = mark === -1 ? "" : url.slice(mark + 1);
  return { ok: true, route: routeOf(path), offeredKey: keyIn(query) };
}

/** The `key=` of a link, as written. Anything else after the `?` is ignored. */
function keyIn(query: string): string | null {
  for (const part of query.split("&")) {
    if (part.startsWith("key=")) return part.slice("key=".length);
  }
  return null;
}

/** The pages that are one fixed address each. An idea's page has the idea's id in its address. */
type PlainPage = Exclude<PageRoute["kind"], "idea">;

const PAGE_PATHS: ReadonlyMap<string, PlainPage> = new Map<string, PlainPage>([
  ["/", "today"],
  ["/ideas", "ideas"],
  ["/nights", "nights"],
  ["/settings", "settings"],
]);

const ASSET_PATHS: ReadonlyMap<string, AssetName> = new Map<string, AssetName>([
  ["/assets/app.css", "app.css"],
  ["/assets/app.js", "app.js"],
  ["/assets/icon.svg", "icon.svg"],
]);

/**
 * The fixed list of routes. The only part of an address that is ever passed on is an idea's id,
 * and only when it looks like one (IDEA_ID), so no file path can be built from anything else.
 */
function routeOf(path: string): Route | null {
  const page = PAGE_PATHS.get(path);
  if (page !== undefined) return { kind: page };
  const asset = ASSET_PATHS.get(path);
  if (asset !== undefined) return { kind: "asset", name: asset };
  const idea = /^\/ideas\/([^/]+)$/.exec(path)?.[1];
  if (idea !== undefined) return IDEA_ID.test(idea) ? { kind: "idea", id: idea } : null;
  const shot = /^\/shots\/([^/]+)\/(phone|desktop)\.png$/.exec(path);
  const id = shot?.[1];
  const which = shot?.[2];
  if (id !== undefined && IDEA_ID.test(id) && (which === "phone" || which === "desktop")) return { kind: "shot", id, which };
  return null;
}

function isPage(route: Route): route is PageRoute {
  return route.kind !== "asset" && route.kind !== "shot";
}

/** A page's plain address, built from the route. */
function pathOf(route: PageRoute): string {
  switch (route.kind) {
    case "today":
      return "/";
    case "ideas":
      return "/ideas";
    case "idea":
      return `/ideas/${route.id}`;
    case "nights":
      return "/nights";
    case "settings":
      return "/settings";
  }
}

// ---------- The key ----------

/**
 * Is this the key? Both sides are hashed first, so the comparison takes the same time whatever
 * was offered and however long it was: a wrong guess learns nothing from how fast it was refused.
 */
function sameKey(offered: string, key: string): boolean {
  if (!isUsableKey(key)) return false;
  const a = createHash("sha256").update(offered, "utf8").digest();
  const b = createHash("sha256").update(key, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Does the Cookie header hold our cookie with the key in it? Another local page can plant a
 * cookie under our name (cookies ignore ports), so every cookie of that name is looked at and
 * one right one is enough. A wrong one never counts for anything.
 */
function cookieHoldsKey(header: unknown, name: string, key: string): boolean {
  if (typeof header !== "string") return false;
  let found = false;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals === -1 || part.slice(0, equals).trim() !== name) continue;
    if (sameKey(part.slice(equals + 1).trim(), key)) found = true;
  }
  return found;
}
