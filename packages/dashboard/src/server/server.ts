// The web server. It knows nothing about Overnight's data: it is handed a `Site` (types.ts)
// and serves it, to this Mac only, and only to requests the gate lets through (guard.ts).
//
// What it promises, whatever the Site does:
//   - it listens on 127.0.0.1 and on nothing else;
//   - every answer, errors included, carries the security headers;
//   - it never reads a request's body and never sends an Access-Control header;
//   - a page leaves only through `sendHtml`, which takes nothing but a SafeHtml;
//   - when the Site throws, the browser gets a plain "could not make this page" and the log
//     gets the kind of error, never its message (a message can hold a path or a person's words).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SafeHtml } from "../render/html.ts";
import type { AssetName, Site } from "../types.ts";
import { checkRequest, isUsableKey, keyCookie, SECURITY_HEADERS } from "./guard.ts";

/** One of the dashboard's own three files, ready to send. */
export interface Asset {
  type: string;
  body: Buffer;
}

const ASSET_TYPES: Readonly<Record<AssetName, string>> = {
  "app.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "icon.svg": "image/svg+xml",
};

const ASSET_NAMES: readonly AssetName[] = ["app.css", "app.js", "icon.svg"];

/** packages/dashboard/public, worked out from where this file lives. */
const PUBLIC_FOLDER = new URL("../../public/", import.meta.url);

/**
 * Read the stylesheet, the script and the icon, once. They are served from memory after that,
 * so no request ever makes the server open a file. `folder` is for tests.
 */
export function loadAssets(folder: URL = PUBLIC_FOLDER): ReadonlyMap<AssetName, Asset> {
  const assets = new Map<AssetName, Asset>();
  for (const name of ASSET_NAMES) {
    let body: Buffer;
    try {
      body = readFileSync(new URL(name, folder));
    } catch {
      throw new Error(`The dashboard's own file public/${name} could not be read.`);
    }
    assets.set(name, { type: ASSET_TYPES[name], body });
  }
  return assets;
}

/** How long the server waits for a slow or silent connection, and how much it will take in. */
export interface Limits {
  /** A whole request must arrive within this. */
  requestMs: number;
  /** Its headers must arrive within this. */
  headersMs: number;
  /** An idle connection is kept open about this long. */
  keepAliveMs: number;
  /** A request with more headers than this is refused. */
  maxHeaders: number;
  /** How often the three waits above are checked. Node's own default is 30 s, which would make a 5 s limit a 35 s one. */
  checkEveryMs: number;
}

export const LIMITS: Readonly<Limits> = Object.freeze({ requestMs: 10_000, headersMs: 5_000, keepAliveMs: 5_000, maxHeaders: 50, checkEveryMs: 1_000 });

/**
 * The address in the links the dashboard hands out. The number, not the name "localhost":
 * that name also means the IPv6 address ::1, where this server does not listen and any other
 * program may. A browser given "localhost" tries ::1 first, so a key link written with the name
 * would hand the key to whatever program had taken that port there (tried on Oct 11 with curl
 * and with Chromium: both went to the other program). A request that does arrive here with the
 * name in its Host header is still answered.
 */
const LINK_HOST = "127.0.0.1";

/** The answers that are a plain sentence of our own. They also close the connection: nothing a real page load makes gets one. */
const REFUSALS: Readonly<Record<400 | 403 | 405 | 414, string>> = {
  400: "The dashboard could not read that address.",
  403: "The dashboard answers only on this Mac, at its own address.",
  405: "The dashboard only reads. It answers GET and HEAD requests and nothing else.",
  414: "That address is too long for the dashboard.",
};

type HeaderMap = Record<string, string>;

export interface DashboardOptions {
  site: Site;
  /** 0 picks any free port (tests). */
  port: number;
  /** Left out, a new random key is made. Every start gets its own. */
  key?: string;
  /** Left out, the three files in public/ are read. */
  assets?: ReadonlyMap<AssetName, Asset>;
  /** Where the one-line notes about failed pages go. Left out: standard output. */
  log?: (line: string) => void;
  /** For tests, so a time limit can be tried without waiting ten seconds. */
  limits?: Partial<Limits>;
}

export interface Dashboard {
  /**
   * Start answering. `url` is the plain address, `keyUrl` the link that opens the dashboard.
   * Rejects with Node's own error when the port cannot be had: its `code` is "EADDRINUSE"
   * when another program (or another dashboard) already has it.
   */
  listen(): Promise<{ port: number; url: string; keyUrl: string }>;
  /** Stop answering and drop every open connection. Safe to call twice, or before `listen`. */
  close(): Promise<void>;
}

export function createDashboard(o: DashboardOptions): Dashboard {
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65_535) throw new RangeError("The dashboard's port must be a whole number from 0 to 65535.");
  if (o.key !== undefined && !isUsableKey(o.key)) throw new TypeError("The dashboard's key must be 32 to 128 letters, digits, - or _.");
  const site = o.site;
  const key = o.key ?? randomBytes(24).toString("base64url");
  const assets = o.assets ?? loadAssets();
  const log = o.log ?? ((line: string) => console.log(line));
  /** A log that cannot be written to must not take the answer down with it. */
  const note = (line: string): void => {
    try {
      log(line);
    } catch {
      // Nothing to do: the line is lost, the request is still answered.
    }
  };
  const limits: Limits = { ...LIMITS, ...o.limits };
  /** The port really listened on. Known once `listen` has finished; no request can arrive before. */
  let port: number | null = null;
  let started = false;

  // ---------- Sending ----------

  /** The one place an answer is written, so that no answer can go out without the security headers. */
  function send(res: ServerResponse, status: number, headers: HeaderMap, body: Buffer | null): void {
    const all: HeaderMap = { ...headers, ...SECURITY_HEADERS };
    if (body !== null) all["Content-Length"] = String(body.length);
    res.writeHead(status, all);
    // A HEAD request gets the same headers as a GET and no body: Node leaves the body out itself.
    res.end(body ?? undefined);
  }

  /** The only way a page leaves. A string, however harmless it looks, is refused. */
  function sendHtml(res: ServerResponse, status: number, page: SafeHtml, headers: HeaderMap = {}): void {
    if (!SafeHtml.isReal(page)) throw new TypeError("sendHtml only sends a page made by the html`` template.");
    send(res, status, { ...headers, "Content-Type": "text/html; charset=utf-8" }, Buffer.from(page.text, "utf8"));
  }

  /** A sentence of our own, as plain text. */
  function sendWords(res: ServerResponse, status: number, words: string, headers: HeaderMap = {}): void {
    send(res, status, { ...headers, "Content-Type": "text/plain; charset=utf-8" }, Buffer.from(`${words}\n`, "utf8"));
  }

  // ---------- Answering ----------

  /** Answers one request. `doing` is kept up to date for the log, should the Site throw. */
  function answer(req: IncomingMessage, res: ServerResponse, doing: { what: string }): void {
    if (port === null) throw new Error("a request arrived before the server was listening");
    const verdict = checkRequest(req, port, key);
    if (!verdict.ok) {
      if (verdict.status === 401) return sendHtml(res, 401, site.problem("needs-key"));
      if (verdict.status === 404) return sendHtml(res, 404, site.problem("not-found"));
      const headers: HeaderMap = verdict.status === 405 ? { Allow: "GET, HEAD", Connection: "close" } : { Connection: "close" };
      return sendWords(res, verdict.status, REFUSALS[verdict.status], headers);
    }
    if (verdict.setKeyThenGoTo !== null) {
      // The key link: hand out the cookie and send the browser on to the plain address.
      return send(res, 303, { Location: verdict.setKeyThenGoTo, "Set-Cookie": keyCookie(port, key), "Content-Length": "0" }, null);
    }
    const route = verdict.route;
    if (route.kind === "asset") {
      doing.what = "sending one of its own files";
      const asset = assets.get(route.name);
      if (asset === undefined) return sendHtml(res, 404, site.problem("not-found"));
      return send(res, 200, { "Content-Type": asset.type }, asset.body);
    }
    if (route.kind === "shot") {
      doing.what = "reading a screenshot";
      const png = site.shot(route.id, route.which);
      if (png === null) return sendHtml(res, 404, site.problem("not-found"));
      if (!Buffer.isBuffer(png)) throw new TypeError("the Site gave a screenshot that is not a Buffer");
      return send(res, 200, { "Content-Type": "image/png" }, png);
    }
    doing.what = `making the ${route.kind} page`;
    const page = site.page(route);
    if (page.status !== 200 && page.status !== 404) throw new TypeError("the Site gave a status that is not 200 or 404");
    // Only a page that is there has a version to compare. The script asks again every few
    // seconds with the version it has; when nothing changed it gets 304 and no page.
    const etag = page.status === 200 && isUsableEtag(page.etag) ? page.etag : null;
    if (etag !== null && sameEtag(req.headers["if-none-match"], etag)) return send(res, 304, { ETag: etag }, null);
    sendHtml(res, page.status, page.html, etag === null ? {} : { ETag: etag });
  }

  /** Every request comes through here, so nothing the Site throws can reach Node or the browser. */
  function handle(req: IncomingMessage, res: ServerResponse): void {
    const doing = { what: "checking the request" };
    try {
      answer(req, res, doing);
    } catch (error) {
      note(`dashboard: failed while ${doing.what} (${kindOfError(error)})`);
      try {
        if (!res.headersSent) sendHtml(res, 500, site.problem("error"));
      } catch {
        // Even the error page could not be made. Say it in our own plain words.
        sendWords(res, 500, "The dashboard could not make this page.");
      }
      // It failed after the headers had gone, so there is no answer left to give: hang up.
      if (!res.writableEnded) res.destroy();
    }
  }

  // ---------- The server ----------

  const server = createServer({
    requestTimeout: limits.requestMs,
    headersTimeout: limits.headersMs,
    keepAliveTimeout: limits.keepAliveMs,
    connectionsCheckingInterval: limits.checkEveryMs,
    // A header sent twice is joined with a comma instead of the second one being dropped, so a
    // request with two Host headers matches neither of our addresses and is refused.
    joinDuplicateHeaders: true,
    // A request with no Host header is refused by the gate like any other wrong Host. Left to
    // itself Node would answer it first, without our headers.
    requireHostHeader: false,
  });
  server.maxHeadersCount = limits.maxHeaders;
  server.on("request", handle);
  // "Expect:" requests would otherwise be answered by Node itself (100 or 417), without our
  // headers. They are requests like any other: the gate decides, and no body is waited for.
  server.on("checkContinue", handle);
  server.on("checkExpectation", handle);
  // What Node refuses before it becomes a request (not HTTP at all, too many or too large
  // headers, too slow) is answered here, so that these carry the security headers too.
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (error.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    const lines = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.end(`HTTP/1.1 ${status}\r\n${lines.join("")}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        if (started) {
          reject(new Error("This dashboard was already started."));
          return;
        }
        started = true;
        server.once("error", reject);
        // 127.0.0.1 and nothing else: not the network, and not every address of this Mac.
        server.listen(o.port, "127.0.0.1", () => {
          server.off("error", reject);
          // After this an error on the listening socket must not stop the program.
          server.on("error", (error) => note(`dashboard: the server reported an error (${kindOfError(error)})`));
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("The dashboard could not tell which port it is listening on."));
            return;
          }
          port = address.port;
          resolve({ port, url: `http://${LINK_HOST}:${port}/`, keyUrl: `http://${LINK_HOST}:${port}/?key=${key}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        // The callback also runs when the server was never started; either way it is closed.
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

// ---------- Small pure helpers ----------

/** A version mark fit to be a header: a quoted run of plain visible characters. */
function isUsableEtag(etag: unknown): etag is string {
  return typeof etag === "string" && /^"[\x21\x23-\x7e]{1,200}"$/.test(etag);
}

/** Does If-None-Match name this version? It can hold several, and a `W/` in front does not matter here. */
function sameEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

/** What kind of error it was: its class, and its code if it has a plain one. Never its message. */
function kindOfError(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "not an Error";
    const name = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : "Error";
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? `${name} ${code}` : name;
  } catch {
    return "Error";
  }
}
