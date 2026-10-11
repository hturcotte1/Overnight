// A forward proxy that lets exactly one destination through: registry.npmjs.org:443.
//
// The macOS sandbox cannot limit network by host name (M2 deliver experiment), so sandboxed npm
// is allowed one local port and this proxy, which runs in our own process OUTSIDE the sandbox,
// decides where that port leads. It only relays encrypted bytes (HTTP CONNECT), so it never sees
// what npm asks for, and it keeps counts only.
//
// Its clients are sandboxed npm and whatever install scripts the app's packages run: code we do
// not trust, talking to a socket inside our own process. So every socket here has an "error"
// listener from the moment it exists (a socket error with no listener is an uncaught exception,
// which would end the whole morning's deliver), every handler is wrapped, and close() always
// resolves.
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";

const ALLOWED_TARGET = "registry.npmjs.org:443";
const UPSTREAM_IDLE_MS = 30_000;
/** A refused client gets this long to read its 403 and hang up before we do it for it. */
const REFUSED_LINGER_MS = 5_000;
/** close() resolves after this long even if the server never reports that it closed. */
const CLOSE_LIMIT_MS = 2_000;

export interface RegistryProxy {
  port: number;
  /** Stop the proxy and say how many connections it let through and how many it refused. Never rejects. */
  close(): Promise<{ allowed: number; refused: number }>;
}

export interface RegistryProxyOptions {
  /** Opens the one allowed connection. Tests pass a fake so nothing leaves the machine. */
  connectUpstream?: () => Socket;
}

function destroyQuietly(socket: Socket): void {
  try {
    socket.destroy();
  } catch {
    // Already gone.
  }
}

export function startRegistryProxy(options: RegistryProxyOptions = {}): Promise<RegistryProxy> {
  const connectUpstream = options.connectUpstream ?? (() => connect({ host: "registry.npmjs.org", port: 443 }));
  const sockets = new Set<Socket>();
  let allowed = 0;
  let refused = 0;

  // Plain-HTTP proxying (GET http://...) is never allowed.
  const server = createServer((_req, res) => {
    refused += 1;
    try {
      res.on("error", () => {});
      res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("overnight registry proxy: only CONNECT registry.npmjs.org:443\n");
    } catch {
      destroyQuietly(res.socket as Socket);
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    // From the first moment: the HTTP server takes its own listeners OFF the socket when a
    // CONNECT arrives, and a client that then drops the connection would otherwise crash us.
    socket.on("error", () => destroyQuietly(socket));
    socket.once("close", () => sockets.delete(socket));
  });
  // A request that is not HTTP at all, or is cut off half-way.
  server.on("clientError", (_error, socket) => destroyQuietly(socket as Socket));

  server.on("connect", (req, clientSocket, head) => {
    const client = clientSocket as Socket;
    client.on("error", () => destroyQuietly(client));
    try {
      if (String(req.url ?? "").toLowerCase() !== ALLOWED_TARGET) {
        refused += 1;
        client.setTimeout(REFUSED_LINGER_MS, () => destroyQuietly(client));
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      const upstream = connectUpstream();
      sockets.add(upstream);
      const closeBoth = () => {
        sockets.delete(upstream);
        destroyQuietly(upstream);
        destroyQuietly(client);
      };
      // `on`, not `once`: a socket can report more than one error on its way down.
      upstream.on("error", () => {
        try {
          if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        } catch {
          // The client is gone as well.
        }
        closeBoth();
      });
      client.on("error", closeBoth);
      upstream.setTimeout(UPSTREAM_IDLE_MS, closeBoth);
      upstream.once("connect", () => {
        try {
          allowed += 1;
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        } catch {
          closeBoth();
        }
      });
      upstream.once("close", closeBoth);
      client.once("close", closeBoth);
    } catch {
      destroyQuietly(client);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: nothing else on the network can use this proxy.
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      // From here on a server error has nobody to reject to, and must not be an uncaught exception.
      server.on("error", () => {});
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            const finish = () => {
              clearTimeout(limit);
              done({ allowed, refused });
            };
            const limit = setTimeout(finish, CLOSE_LIMIT_MS);
            try {
              server.close(finish);
            } catch {
              finish();
            }
            for (const socket of sockets) destroyQuietly(socket);
          }),
      });
    });
  });
}
