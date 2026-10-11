// Synthetic test data: the files served and the hosts named in this file are made up.
// These tests use this machine's own loopback address only; nothing leaves the computer.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findFreePort } from "../src/free-port.ts";
import { startStaticServer } from "../src/harness/static-server.ts";
import { startRegistryProxy } from "../src/registry-proxy.ts";
import { tempDir, writeTree } from "./helpers.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Send raw bytes to a local port and collect everything that comes back until the other side closes. */
function exchange(port: number, send: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("no answer")));
    socket.on("data", (chunk) => (received += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => resolve(received));
    socket.on("connect", () => socket.write(send));
  });
}

describe("the static server", () => {
  async function serve() {
    const root = tempDir();
    const site = path.join(root, "site");
    writeTree(site, { "index.html": "<h1>made-up app</h1>\n", "assets/app.js": "console.log(1)\n", "assets/data.bin": "xyz" });
    writeFileSync(path.join(root, "outside.txt"), "made-up private text\n");
    symlinkSync(path.join(root, "outside.txt"), path.join(site, "leak.txt"));
    mkdirSync(path.join(site, "empty"));
    const server = await startStaticServer(site, 0);
    closers.push(server.close);
    const get = (urlPath: string, method = "GET") => fetch(`http://127.0.0.1:${server.port}${urlPath}`, { method });
    return { server, get };
  }

  it("serves files with their types, and index.html for a folder", async () => {
    const { get } = await serve();
    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(await index.text()).toBe("<h1>made-up app</h1>\n");
    const script = await get("/assets/app.js?v=2");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("console.log(1)\n");
    expect((await get("/assets/data.bin")).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("answers 404 for what is not there and 405 for anything but reading", async () => {
    const { get } = await serve();
    expect((await get("/missing.js")).status).toBe(404);
    expect((await get("/empty/")).status).toBe(404);
    expect((await get("/", "POST")).status).toBe(405);
    expect((await get("/", "HEAD")).status).toBe(200);
  });

  it("never serves a file outside its folder: not through .., not through a link", async () => {
    const { server, get } = await serve();
    expect((await get("/leak.txt")).status).toBe(403);
    // fetch() tidies ".." away, so send the request line by hand.
    const raw = await exchange(server.port, "GET /../outside.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(raw.startsWith("HTTP/1.1 403") || raw.startsWith("HTTP/1.1 404")).toBe(true);
    expect(raw).not.toContain("made-up private text");
    const encoded = await exchange(server.port, "GET /%2e%2e/outside.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(encoded).not.toContain("made-up private text");
  });

  it("listens on this machine's loopback address only, and refuses a port that is taken", async () => {
    const { server } = await serve();
    await expect(startStaticServer(tempDir(), server.port)).rejects.toThrow();
  });
});

describe("findFreePort", () => {
  it("gives a port that can be bound straight away", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1023);
    const server = await startStaticServer(tempDir(), port);
    closers.push(server.close);
    expect(server.port).toBe(port);
  });
});

describe("the registry-only proxy", () => {
  /** A made-up "registry": a local server that says hello and echoes. Stands in for the one allowed destination. */
  async function fakeUpstream(): Promise<{ server: Server; port: number; connections: () => number }> {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.write("hello from the made-up registry\n");
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(resolve)));
    return { server, port: (server.address() as AddressInfo).port, connections: () => connections };
  }

  async function start() {
    const upstream = await fakeUpstream();
    const sockets: Socket[] = [];
    const proxy = await startRegistryProxy({
      connectUpstream: () => {
        const socket = connect({ host: "127.0.0.1", port: upstream.port });
        sockets.push(socket);
        return socket;
      },
    });
    let closed: Promise<{ allowed: number; refused: number }> | null = null;
    const close = () => (closed ??= proxy.close());
    closers.push(close);
    return { proxy, upstream, close };
  }

  it("lets CONNECT registry.npmjs.org:443 through and relays bytes both ways", async () => {
    const { proxy, upstream, close } = await start();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port });
      let received = "";
      socket.setTimeout(5_000, () => socket.destroy(new Error("no answer")));
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        if (received.includes("hello from the made-up registry\n") && !received.includes("ping")) socket.write("ping");
        if (received.endsWith("ping")) socket.end();
      });
      socket.on("close", () => resolve(received));
      socket.on("connect", () => socket.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"));
    });
    expect(answer).toBe("HTTP/1.1 200 Connection Established\r\n\r\nhello from the made-up registry\nping");
    expect(upstream.connections()).toBe(1);
    expect(await close()).toEqual({ allowed: 1, refused: 0 });
  });

  it("refuses every other destination, without ever opening a connection for it", async () => {
    const { proxy, upstream, close } = await start();
    for (const target of ["example.com:443", "api.github.com:443", "registry.npmjs.org:80", "registry.npmjs.org.evil.example:443", "127.0.0.1:22", "localhost:5476"]) {
      const answer = await exchange(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      expect(answer.startsWith("HTTP/1.1 403 Forbidden"), target).toBe(true);
    }
    expect(upstream.connections()).toBe(0);
    expect(await close()).toEqual({ allowed: 0, refused: 6 });
  });

  it("refuses plain-HTTP proxying", async () => {
    const { proxy, upstream, close } = await start();
    const answer = await exchange(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true);
    expect(upstream.connections()).toBe(0);
    expect(await close()).toEqual({ allowed: 0, refused: 1 });
  });

  // The proxy runs inside our own process, and its clients are sandboxed code we do not trust. A
  // socket error with no listener is an uncaught exception: it would end the whole deliver run.
  describe("cannot be crashed by its clients", () => {
    /** Collects anything that would have taken the process down while `work` runs. */
    async function uncaughtDuring(work: () => Promise<void>): Promise<unknown[]> {
      const caught: unknown[] = [];
      const onError = (error: unknown) => caught.push(error);
      const before = process.listeners("uncaughtException");
      // vitest has its own listener; ours must be the only one, or a crash would fail the run instead of this test.
      process.removeAllListeners("uncaughtException");
      process.on("uncaughtException", onError);
      try {
        await work();
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        process.off("uncaughtException", onError);
        for (const listener of before) process.on("uncaughtException", listener);
      }
      return caught;
    }
    /** Connect, send `first`, wait for the first bytes back (or the close), then slam the connection shut. */
    function sendThenReset(port: number, first: string, waitForAnswer = true): Promise<void> {
      return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const slam = () => {
          socket.resetAndDestroy();
          resolve();
        };
        socket.on("error", () => {});
        socket.once("connect", () => {
          socket.write(first);
          if (!waitForAnswer) setTimeout(slam, 50);
        });
        if (waitForAnswer) socket.once("data", slam);
        socket.once("close", () => resolve());
      });
    }

    it("a refused CONNECT whose client then drops the connection abruptly leaves the process alive and counts one refusal", async () => {
      const { proxy, upstream, close } = await start();
      const caught = await uncaughtDuring(() => sendThenReset(proxy.port, "CONNECT elsewhere.invalid:443 HTTP/1.1\r\nHost: elsewhere.invalid:443\r\n\r\n"));
      expect(caught).toEqual([]);
      expect(upstream.connections()).toBe(0);
      // Still serving: the next client gets its answer.
      expect((await exchange(proxy.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")).startsWith("HTTP/1.1 403")).toBe(true);
      expect(await close()).toEqual({ allowed: 0, refused: 2 });
    });

    it("an allowed CONNECT whose client drops abruptly, mid-stream, leaves the process alive", async () => {
      const { proxy, close } = await start();
      const caught = await uncaughtDuring(() => sendThenReset(proxy.port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"));
      expect(caught).toEqual([]);
      expect(await close()).toEqual({ allowed: 1, refused: 0 });
    });

    it("bytes that are not HTTP at all, and a request cut off half-way, leave the process alive", async () => {
      const { proxy, close } = await start();
      const caught = await uncaughtDuring(async () => {
        await sendThenReset(proxy.port, "\u0000\u0001 this is not http \r\n\r\n", false);
        await sendThenReset(proxy.port, "CONNECT registry.npmjs.org:443 HT", false);
        await sendThenReset(proxy.port, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
      });
      expect(caught).toEqual([]);
      const counts = await close();
      expect(counts.allowed).toBe(0);
    });

    it("an upstream that cannot be reached is answered with 502, not with a crash", async () => {
      let answer = "";
      const caught = await uncaughtDuring(async () => {
        // Port 1 on this machine: nothing listens there, so the connection is refused at once.
        const proxy = await startRegistryProxy({ connectUpstream: () => connect({ host: "127.0.0.1", port: 1 }) });
        closers.push(() => proxy.close());
        answer = await exchange(proxy.port, "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
      });
      expect(caught).toEqual([]);
      expect(answer.startsWith("HTTP/1.1 502")).toBe(true);
    });

    it("close() answers even while clients are still connected, and can be called twice", async () => {
      const upstream = await fakeUpstream();
      const proxy = await startRegistryProxy({ connectUpstream: () => connect({ host: "127.0.0.1", port: upstream.port }) });
      const client = connect({ host: "127.0.0.1", port: proxy.port });
      client.on("error", () => {});
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n");
      await new Promise<void>((resolve) => client.once("data", () => resolve()));
      expect(await proxy.close()).toEqual({ allowed: 1, refused: 0 });
      expect(await proxy.close()).toEqual({ allowed: 1, refused: 0 });
      client.destroy();
    });
  });
});

describe("the static server: clients that misbehave", () => {
  it("keeps serving after a client sends rubbish or hangs up half-way through a file", async () => {
    const root = tempDir();
    writeTree(root, { "index.html": "<h1>made-up app</h1>\n", "big.bin": "x".repeat(4 * 1024 * 1024) });
    const server = await startStaticServer(root, 0);
    closers.push(server.close);
    for (const first of ["\u0000 not http\r\n\r\n", "GET /big.bin HTTP/1.1\r\nHost: x\r\n\r\n"]) {
      await new Promise<void>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: server.port });
        socket.on("error", () => {});
        socket.once("connect", () => socket.write(first));
        const slam = () => {
          socket.resetAndDestroy();
          resolve();
        };
        socket.once("data", slam);
        socket.once("close", () => resolve());
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const index = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await index.text()).toBe("<h1>made-up app</h1>\n");
  });
});
