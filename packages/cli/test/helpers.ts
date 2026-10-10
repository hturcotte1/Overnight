// Shared test set-up. Everything here is made up for the tests. None of it is Bee data.
import { dataPaths, parseConfig, Store } from "@overnight/core";
import type { Config, Idea, IdeaState, NewIdea } from "@overnight/core";
import type { Context } from "../src/context.ts";

export const BOISE = "America/Boise";

/** Noon in Boise on Oct 9, 2026 (UTC-6). The local day runs from 06:00Z to 06:00Z. */
export const NOON = "2026-10-09T18:00:00.000Z";
export const at = (seconds: number) => new Date(Date.parse(NOON) + seconds * 1000).toISOString();
export const fixedNow = (iso: string = NOON) => () => new Date(iso);

/** Settings parsed from fake values. The folder is only a name here: nothing is created. */
export function testConfig(env: Record<string, string> = {}): Config {
  // Tests exercise the live behaviour unless they pause on purpose. (The product default is paused.)
  return parseConfig({ OVERNIGHT_DATA_DIR: "/tmp/overnight-cli-test", PAUSED: "false", ...env });
}

/** An in-memory database with the settings and paths a command expects. */
export function testContext(env: Record<string, string> = {}): Context {
  const config = testConfig(env);
  return { config, paths: dataPaths(config.dataDir), store: new Store(":memory:") };
}

/**
 * Intl puts a narrow no-break space before "AM"/"PM". Swap it for a plain one so the
 * expected lines in the tests can be typed normally.
 */
export const plain = (text: string) => text.replaceAll("\u202f", " ");

/** Collects what a command prints, one entry per line. */
export function capture(): { lines: string[]; write: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(plain(line)), text: () => lines.join("\n") };
}

export const SAMPLE_IDEAS = {
  turns: { title: "Whose turn to pay", pitch: "Tap who paid; see whose turn is next.", quote: "someone should build a tiny app for whose turn it is" },
  plants: { title: "Plant watering tracker", pitch: "One tap per plant; shows which are thirsty.", quote: "I wish there was an app that told me which plant is dry" },
  chores: { title: "Chore wheel", pitch: "Spin a wheel to share out the week's chores.", quote: "it would be cool if a wheel just picked who does dishes" },
} as const;

export function addIdea(store: Store, sample: Pick<NewIdea, "title" | "pitch" | "quote">, createdAt: string): Idea {
  const { key } = store.resolveConversation({ uuid: `u-${sample.title}` }, createdAt);
  return store.createIdea({ ...sample, confidence: 0.9, conversationKey: key, detectorRunId: null }, createdAt);
}

/** Walk an idea forward one allowed step at a time, the way the listener would. */
export function moveIdea(store: Store, idea: Idea, steps: IdeaState[], startAt: string): Idea {
  let current = idea;
  let when = Date.parse(startAt);
  for (const state of steps) {
    const now = new Date(when).toISOString();
    const patch = state === "asked" ? { todoId: Math.floor(when / 1000), askedAt: now } : state === "approved" || state === "rejected" ? { answeredAt: now } : {};
    current = store.transitionIdea(current.id, state, patch, now);
    when += 60_000;
  }
  return current;
}
