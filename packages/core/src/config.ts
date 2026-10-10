// Every setting, read from the environment (and from `.env` at the repo root if present) and
// checked with zod. A bad value stops the program at start-up with a message that names it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseHhMm } from "./time.ts";

const hhmm = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine((value) => {
      try {
        parseHhMm(value);
        return true;
      } catch {
        return false;
      }
    }, "must be a 24-hour time like 23:00");

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");

const intInRange = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);

// Blank values in .env (KEY=) mean "use the default".
const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const schema = z.object({
  OVERNIGHT_DATA_DIR: z.preprocess(blankToUndefined, z.string().optional()),
  GITHUB_PAGES_REPO: z.preprocess(blankToUndefined, z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a repo name, not a URL").default("overnight-apps")),
  TZ: z.preprocess(
    blankToUndefined,
    z
      .string()
      .default("America/Boise")
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "must be a time zone name like America/Boise"),
  ),
  ASK_CUTOFF: z.preprocess(blankToUndefined, hhmm("23:00")),
  BUILD_TIME: z.preprocess(blankToUndefined, hhmm("01:00")),
  DELIVER_TIME: z.preprocess(blankToUndefined, hhmm("07:00")),
  MAX_ASKS_PER_DAY: z.preprocess(blankToUndefined, intInRange(3, 0, 20)),
  MAX_BUILDS_PER_NIGHT: z.preprocess(blankToUndefined, intInRange(2, 0, 10)),
  BUILD_TIMEOUT_MIN: z.preprocess(blankToUndefined, intInRange(45, 1, 240)),
  WRITE_BEE_FACTS: z.preprocess(blankToUndefined, bool(true)),
  PAUSED: z.preprocess(blankToUndefined, bool(false)),
});

export interface Config {
  dataDir: string;
  githubPagesRepo: string;
  timeZone: string;
  askCutoff: string;
  buildTime: string;
  deliverTime: string;
  maxAsksPerDay: number;
  maxBuildsPerNight: number;
  buildTimeoutMin: number;
  writeBeeFacts: boolean;
  /** The starting value only. `overnight pause` / `resume` store the live value in the database. */
  pausedByDefault: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ConfigError(`Bad setting. ${problems}`);
  }
  const value = parsed.data;
  return {
    dataDir: path.resolve(expandHome(value.OVERNIGHT_DATA_DIR ?? path.join(homedir(), ".overnight"))),
    githubPagesRepo: value.GITHUB_PAGES_REPO,
    timeZone: value.TZ,
    askCutoff: value.ASK_CUTOFF,
    buildTime: value.BUILD_TIME,
    deliverTime: value.DELIVER_TIME,
    maxAsksPerDay: value.MAX_ASKS_PER_DAY,
    maxBuildsPerNight: value.MAX_BUILDS_PER_NIGHT,
    buildTimeoutMin: value.BUILD_TIMEOUT_MIN,
    writeBeeFacts: value.WRITE_BEE_FACTS,
    pausedByDefault: value.PAUSED,
  };
}

/** Read `.env` from `repoRoot` if it exists (values already in the environment win), then parse. */
export function loadConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = path.join(repoRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return parseConfig(env);
}
