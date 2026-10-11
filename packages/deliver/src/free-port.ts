// Pick a free port on 127.0.0.1 for one run. The sandbox must be told the port before the server
// starts, so we ask the system for an unused one, let go of it, and hand the number on. Should
// something else grab it in between, our server fails to start and the caller picks again.
import { createServer } from "node:net";

const LIMIT_MS = 5_000;

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    let settled = false;
    const settle = (port: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      if (port !== null && port > 0) resolve(port);
      else reject(new Error("The system did not give us a free port."));
    };
    const limit = setTimeout(() => {
      try {
        probe.close();
      } catch {
        // Never opened.
      }
      settle(null);
    }, LIMIT_MS);
    // `on`, not `once`: a second error with no listener would be an uncaught exception.
    probe.on("error", () => settle(null));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => settle(port));
    });
  });
}
