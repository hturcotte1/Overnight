// A tiny static file server for the smoke tests. It runs INSIDE the deliver sandbox, so it uses
// Node built-ins only and imports nothing from the rest of the repo.
// It binds 127.0.0.1 only and never serves a file (or follows a link) outside its root.
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface StaticServer {
  port: number;
  close(): Promise<void>;
}

/** Serve `rootDir` on 127.0.0.1:`port` (0 picks a free one). Rejects if the port cannot be bound. */
export function startStaticServer(rootDir: string, port: number): Promise<StaticServer> {
  const root = realpathSync(rootDir);
  const inside = (file: string) => file === root || file.startsWith(root + path.sep);

  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.normalize(path.join(root, pathname));
    // Never serve anything outside the root, whatever the URL says.
    if (pathname.includes("\u0000") || !inside(file)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = path.join(file, "index.html");
      // realpath follows links: refuse any that leave the root.
      const real = realpathSync(file);
      if (!inside(real)) {
        res.writeHead(403).end();
        return;
      }
      const stat = statSync(real);
      if (!stat.isFile()) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(real).toLowerCase()] ?? "application/octet-stream",
        "content-length": stat.size,
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = createReadStream(real);
      // A file that cannot be read after all, or a browser that hangs up half-way, must not
      // end this server: an "error" event without a listener would.
      stream.on("error", () => res.destroy());
      res.on("error", () => stream.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  // A request that is not HTTP at all, or a socket that fails: drop it, keep serving.
  server.on("clientError", (_error, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", () => {});
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
