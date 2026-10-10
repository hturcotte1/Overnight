// The real Bee, Kiro and listener parts, loaded only when a command needs them.
// `status`, `ideas`, `queue`, `pause` and `resume` read the database and nothing else, so they
// should start fast and keep working even if one of these packages cannot load.
import { silentLogger } from "@overnight/core";
import type { LoginState } from "@overnight/core";
import type { ListenFactories } from "./commands/listen.ts";

export async function realListenFactories(): Promise<ListenFactories> {
  const [bee, detector, listener] = await Promise.all([import("@overnight/bee"), import("@overnight/detector"), import("@overnight/listener")]);
  return {
    createBee: bee.createBeeGateway,
    createDetector: detector.createKiroDetector,
    createListener: listener.createListener,
  };
}

/** For `status --check`. Quiet on purpose: log lines on standard output would break --json. */
export async function realBeeLoginState(): Promise<LoginState> {
  const { createBeeGateway } = await import("@overnight/bee");
  return createBeeGateway({ logger: silentLogger }).loginState();
}
