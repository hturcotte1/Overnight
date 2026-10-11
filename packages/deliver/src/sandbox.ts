// Builds the sandbox-exec command line and the stripped-down environment for everything that
// runs agent-written code. The rules themselves are in ../sandbox/deliver.sb.
import { realpathSync } from "node:fs";
import path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Every folder the sandbox profile needs to know about. All must be real paths (no symlinks). */
export interface SandboxPlaces {
  home: string;
  /** Overnight's data folder: hidden from the sandbox except for the folders below. */
  dataDir: string;
  /** The one folder the step works on: the clean copy of the app for install and build, an empty folder for the browser steps. Read and write. */
  workspace: string;
  /** Temp files, caches and results, made fresh for this one command. Read and write. */
  runDir: string;
  /** Our checked copy of dist. Read only, so nothing can change it between the test and the publish. */
  siteDir: string;
  /** Our static server and tests (one folder for our contract test, another for the app's own smoke test). Read only. */
  harnessDir: string;
  /** The Node install (holds bin/node and bin/npm). Only node, npm and npx in it can be read or run. */
  nodeDir: string;
  /** The node_modules folder that holds Playwright. Only Playwright's own folders are readable. */
  toolsDir: string;
  /** Playwright's browser cache. Read only. */
  browsersDir: string;
  /** The npm cache this command uses. Read only unless it is inside runDir. */
  npmCache: string;
}

export interface SandboxPorts {
  /** The static server's port, or null when this command needs no network at all. */
  port: number | null;
  /** Our registry-only proxy's port, or null. */
  proxyPort: number | null;
}

/** Port 1 is what the profile is given for "none": nothing listens there. */
const NO_PORT = 1;

const PLACE_PARAMS: ReadonlyArray<[keyof SandboxPlaces, string]> = [
  ["home", "HOME"],
  ["dataDir", "DATA_DIR"],
  ["workspace", "WORKSPACE"],
  ["runDir", "RUN_DIR"],
  ["siteDir", "SITE_DIR"],
  ["harnessDir", "HARNESS_DIR"],
  ["nodeDir", "NODE_DIR"],
  ["toolsDir", "TOOLS_DIR"],
  ["browsersDir", "PW_BROWSERS"],
  ["npmCache", "NPM_CACHE"],
];

export class SandboxSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSetupError";
  }
}

/**
 * The real path of a folder that must exist. The sandbox matches real paths only: a rule written
 * for a symlinked path silently fails to match (seen with ~/.local/node in the M2 experiment).
 */
export function realDir(dir: string, what: string): string {
  try {
    return realpathSync(dir);
  } catch {
    throw new SandboxSetupError(`${what} is missing on this Mac.`);
  }
}

function checkPlace(name: string, value: string): void {
  const hasControlCharacter = [...value].some((char) => char.charCodeAt(0) < 0x20);
  if (!path.isAbsolute(value) || value !== path.normalize(value) || value.endsWith("/") || hasControlCharacter) {
    throw new SandboxSetupError(`The sandbox was given a bad path for ${name}.`);
  }
}

function checkPort(name: string, port: number | null): number {
  if (port === null) return NO_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SandboxSetupError(`The sandbox was given a bad ${name}.`);
  return port;
}

/** `sandbox-exec -D ... -f <profile> <argv...>`. Throws SandboxSetupError rather than build a loose sandbox. */
export function sandboxCommand(
  profileFile: string,
  places: SandboxPlaces,
  ports: SandboxPorts,
  argv: string[],
  sandboxExec: string = SANDBOX_EXEC,
): { command: string; args: string[] } {
  if (argv.length === 0) throw new SandboxSetupError("The sandbox was given nothing to run.");
  const args: string[] = [];
  for (const [key, param] of PLACE_PARAMS) {
    checkPlace(param, places[key]);
    args.push("-D", `${param}=${places[key]}`);
  }
  // What agent code may write must never be, or contain, the data folder or the home folder.
  for (const writable of [places.workspace, places.runDir]) {
    for (const guarded of [places.dataDir, places.home]) {
      if (writable === guarded || guarded.startsWith(writable + path.sep)) throw new SandboxSetupError("The sandbox was asked to make a private folder writable.");
    }
  }
  args.push("-D", `PORT=${checkPort("port", ports.port)}`, "-D", `PROXY_PORT=${checkPort("proxy port", ports.proxyPort)}`);
  args.push("-f", profileFile, ...argv);
  return { command: sandboxExec, args };
}

/**
 * The whole environment of a sandboxed command: nothing of ours is inherited, so no token or
 * setting can leak in through it. `extra` adds what one step needs (a proxy address, the test's
 * folders). HOME is the real home folder's path, which the sandbox does not let the command read:
 * tools only need it to be set. USER and LOGNAME are left out on purpose.
 */
export function sandboxEnv(places: SandboxPlaces, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: places.home,
    PATH: `${path.join(places.nodeDir, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.join(places.runDir, "tmp"),
    NO_COLOR: "1",
    PLAYWRIGHT_BROWSERS_PATH: places.browsersDir,
    npm_config_cache: places.npmCache,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    ...extra,
  };
}
