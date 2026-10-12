// The real Bee, Kiro, listener, builder and deliver parts, loaded only when a command needs them.
// `status`, `ideas`, `queue`, `pause` and `resume` read the database and nothing else, so they
// should start fast and keep working even if one of these packages cannot load.
import path from "node:path";
import { createLogger, silentLogger } from "@overnight/core";
import type { LoginState } from "@overnight/core";
import type { BuildFactories } from "./commands/build.ts";
import type { DeliverFactories, DeliverSteps } from "./commands/deliver.ts";
import type { ListenFactories } from "./commands/listen.ts";
import type { PreflightProbes } from "./commands/preflight.ts";
import type { Context } from "./context.ts";
import { realPreflightProbes as probesFrom } from "./preflight-probes.ts";
import { buildLockFile, deliverLockFile, lockHeld } from "./single-instance.ts";

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

/**
 * For `build` and `build-now`. This is the one place the command line meets @overnight/builder:
 * if a name or a shape there changes, the typecheck fails here.
 */
export async function realBuildFactories(): Promise<BuildFactories> {
  const builder = await import("@overnight/builder");
  type Backend = ReturnType<typeof builder.createKiroCliBackend>;
  const factories: BuildFactories<Backend> = {
    createKiroCrewBackend: builder.createKiroCrewBackend,
    createKiroCliBackend: builder.createKiroCliBackend,
    runBuildNight: builder.runBuildNight,
    buildOne: builder.buildOne,
    createKiroSignInRenewal: builder.createKiroSignInRenewal,
  };
  return factories;
}

/**
 * @overnight/deliver's two entry points, and nothing of Bee. The one place the command line meets
 * @overnight/deliver. `rehearse run` uses this directly, with a stand-in for Bee: this function
 * must never load @overnight/bee.
 */
export async function realDeliverSteps(): Promise<DeliverSteps> {
  const delivery = await import("@overnight/deliver");
  return {
    runDeliver: delivery.runDeliver,
    deliverOne: delivery.deliverOne,
  };
}

/** For `deliver` and `build-now`: the deliver step, and the real Bee gateway to hand to it. */
export async function realDeliverFactories(): Promise<DeliverFactories> {
  const [bee, steps] = await Promise.all([import("@overnight/bee"), realDeliverSteps()]);
  return { createBee: bee.createBeeGateway, ...steps };
}

/**
 * For `preflight`. The questions are asked of this Mac by preflight-probes.ts; this hands it the
 * parts that belong to other packages: Bee's login check, where kiro-cli is, and the builder's
 * own knowledge of Kiro Crew (its folder, the settings each sandbox mode needs, where the skill
 * is installed, and its sandbox check).
 */
export async function realPreflightProbes(context: Pick<Context, "config" | "paths">): Promise<PreflightProbes> {
  const [detector, builder] = await Promise.all([import("@overnight/detector"), import("@overnight/builder")]);
  return probesFrom({
    beeLoginState: realBeeLoginState,
    findKiroBinary: detector.findKiroBinary,
    crewHome: () => builder.defaultCrewHome(),
    crewSettingsProblem: builder.crewSettingsProblem,
    installedSkillFile: builder.installedSkillFile,
    buildSkillFile: builder.BUILD_SKILL_FILE,
    // The same check the nightly build makes before its first Kiro Crew build, through the same
    // code, with the same settings and data folder. Its own lines go to the build log, under the
    // name "preflight", and never to the screen: preflight prints one line of its own about it.
    sandboxProbe: (signal) =>
      builder.runStandaloneSandboxProbe({
        config: context.config,
        paths: context.paths,
        logger: createLogger({ name: "preflight", file: path.join(context.paths.logs, "build.log"), write: () => {} }),
        signal,
      }),
    // Every build holds the build lock for as long as it runs, and every deliver the deliver lock.
    buildRunning: () => lockHeld(buildLockFile(context.paths)),
    nightJobRunning: (job) => lockHeld(job === "build" ? buildLockFile(context.paths) : deliverLockFile(context.paths)),
    gatewayProfileFile: builder.CREW_GATEWAY_SANDBOX_PROFILE,
    // Where scripts/install-agents.sh puts the gateway job's copy (its installed_profile_of).
    installedGatewayProfileFile: path.join(context.paths.root, "sandbox", "crew-gateway.sb"),
  });
}
