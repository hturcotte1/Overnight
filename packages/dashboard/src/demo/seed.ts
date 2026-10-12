// SYNTHETIC data: every title, pitch, quote and line here is made up. None of it is Bee data.
//
// The demo's data: one invented scene, written into an empty folder through the real Store, so
// the dashboard can be shown, tested and filmed without a word anyone really said.
//
// The scene is told from a clock that reads 1:02 AM at `now`. Day 0 is the day of `now`; day 1
// is the day before (the page's "today" started at 7:00 AM on day 1); and so on back to day 5.
//   - Tonight: "Chore Wheel" has been building with Kiro Crew for 72 seconds. "Lunch Turns" is
//     approved and next. "Recipe Doubler" was built by hand in the evening, was stopped, and
//     waits for its second try. "Plant Watering Days" is asked and not answered yet.
//   - Last night: "Packing Checklist" was built and delivered. "Bale Yield Calculator" could not
//     be built, and the wearer was told.
//   - The night before: "Reading Log" was built by the second builder and delivered. "Game Night
//     Scores" was built but did not pass the morning check.
//   - Earlier: one idea not approved, one never answered, one heard and never asked, and two
//     rehearsal ideas whose runs were stopped half-way (one built, one published).
// All eleven states an idea can be in appear, and every change of state is one the real state
// machine allows, at a time the real programs could have made it.
//
// This file and its neighbours in src/demo are the only part of the dashboard that writes, and
// ./folder.ts decides where: an empty folder it is handed, never ~/.overnight.
import { BUILD_STOPPED_REASON, Store } from "@overnight/core";
import type { Config, Idea, IdeaState } from "@overnight/core";
import { slugFor } from "@overnight/builder";
import { REHEARSAL_CONVERSATION_KEY } from "../log-messages.ts";
import { backendLabel } from "../render/format.ts";
import type { Backend } from "../types.ts";
import { DEMO_MARKER_FILE, DEMO_MARKER_TEXT, emptyDemoFolder, plainFileOrMissing, writeInside } from "./folder.ts";
import { ACCENTS, checkDemoFolders, DEMO_FILES_MADE_ANEW, demoBuildNotes, openDemoLogs, passedChecks, reportFor, sealWorkspace, setWorkspaceAside, writeBriefs, writeBuildStatus, writeReport, writeScreenshots, writeWorkspaceFile } from "./night-files.ts";
import type { DemoLogs, HandRun, Measured, WorkspaceFile } from "./night-files.ts";
import type { Rgb } from "./png.ts";

// ---------- the cast ----------

interface Words {
  title: string;
  pitch: string;
  /** What was "said". Empty for a rehearsal idea: nobody said it. */
  quote: string;
  /** The state the scene leaves the idea in. */
  state: IdeaState;
}

const CAST = {
  practiceDiceRoller: { state: "published", title: "Practice Dice Roller", pitch: "Roll one to six dice with a tap and see the total.", quote: "" },
  practiceTallyCounter: { state: "built", title: "Practice Tally Counter", pitch: "Count things with one big plus button, with an undo and a reset.", quote: "" },
  coinFlipDecider: { state: "rejected", title: "Coin Flip Decider", pitch: "Type two choices and flip a coin to pick one of them.", quote: "let's just flip a coin for it, there should be a button for that" },
  readingLog: { state: "delivered", title: "Reading Log", pitch: "Write down each book you finish with the date and one line about it, and count them up by month.", quote: "we could keep a little log of the books we read this year" },
  gameNightScores: { state: "publish_failed", title: "Game Night Scores", pitch: "Add the players, tap to give points each round, and see who is ahead.", quote: "can something keep score on game night so nobody argues" },
  stretchBreakBell: { state: "expired", title: "Stretch Break Bell", pitch: "Pick how often you want a nudge to stand up and stretch, and it rings a soft bell.", quote: "something should remind me to get up and stretch now and then" },
  packingChecklist: { state: "delivered", title: "Packing Checklist", pitch: "Make a packing list for a trip, tick things off as they go in the bag, and use the list again next time.", quote: "what if there was a little list we could tick off while we pack" },
  baleYieldCalculator: { state: "build_failed", title: "Bale Yield Calculator", pitch: "Type in a field's size and how many bales came off it, and see bales per acre next to last year's number.", quote: "somebody should make a calculator for how many bales we get per acre" },
  carpoolTextAlerts: { state: "heard", title: "Carpool Text Alerts", pitch: "Sends a text to everyone in the carpool when the driver is five minutes away.", quote: "it should just text everyone when the carpool is nearly there" },
  recipeDoubler: { state: "build_failed", title: "Recipe Doubler", pitch: "Paste a recipe's ingredients and pick double or half. It works out the new amounts.", quote: "I wish I could just double this recipe without doing the sums" },
  choreWheel: { state: "building", title: "Chore Wheel", pitch: "Spin a wheel to share out the week's chores. Add names and chores, spin, and see who does what.", quote: "it would be cool if a wheel just picked who does the dishes" },
  lunchTurns: { state: "approved", title: "Lunch Turns", pitch: "Keep track of whose turn it is to pick lunch. Tap a name when they have chosen, and it shows who is next.", quote: "we should have a thing that says whose turn it is to pick lunch" },
  plantWateringDays: { state: "asked", title: "Plant Watering Days", pitch: "List your plants and how often each one wants water. It shows which ones are due today.", quote: "I never remember which plant I watered last, something should just tell me" },
} as const satisfies Record<string, Words>;

export type DemoIdeaKey = keyof typeof CAST;
/** The demo's ideas by name, in the order they are heard. An idea's number in the sentinels is its place here, from 1. */
export const DEMO_IDEA_KEYS = Object.keys(CAST) as DemoIdeaKey[];
/** The state the scene leaves each idea in. Between them, all eleven. */
export const DEMO_STATES: Readonly<Record<DemoIdeaKey, IdeaState>> = Object.fromEntries(DEMO_IDEA_KEYS.map((key) => [key, CAST[key].state])) as Record<DemoIdeaKey, IdeaState>;

/** The local time the scene is drawn for: tonight's build began 72 seconds before it. */
export const DEMO_CLOCK = "01:02";
/** The same moment with its seconds, as the scene's own times are written. */
const DEMO_CLOCK_SECONDS = `${DEMO_CLOCK}:00`;

// ---------- sentinels and hostile text (for the tests) ----------

/** With `sentinels`, every quote starts with this and the idea's number. */
export const QUOTE_SENTINEL = "QUOTE-SENTINEL-";
/** With `sentinels`, every heard line starts with this and a number of its own. */
export const LINE_SENTINEL = "LINE-SENTINEL-";
/** With `sentinels`, the title of every idea nobody has approved starts with this and the idea's number. */
export const TITLE_SENTINEL = "TITLE-SENTINEL-";
/** With `sentinels`, the pitch of every idea nobody has approved starts with this and the idea's number. */
export const PITCH_SENTINEL = "PITCH-SENTINEL-";
/** With `sentinels`, every build notes file holds this. */
export const NOTES_SENTINEL = "NOTES-SENTINEL";

/** With `hostile`, every piece of free text ends with all of these. No page may let one of them through as markup. */
export const HOSTILE_STRINGS: readonly string[] = ["<xss-probe>", '" data-xss-probe="1', "'><img src=x onerror=1>", "</script>", "‮desrever‬", "W".repeat(300)];
const HOSTILE_TEXT = HOSTILE_STRINGS.join(" ");
/** With `hostile`, the links of the three published ideas: not a web address, a web address with markup in it, and data. */
export const HOSTILE_LINKS = {
  packingChecklist: "javascript:alert(1)",
  readingLog: `https://example.invalid/overnight-apps/"onmouseover="alert(1)"<xss-probe>'><img/src=x/onerror=1>`,
  practiceDiceRoller: "data:text/html,<script>alert(1)</script>",
} as const satisfies Partial<Record<DemoIdeaKey, string>>;

/** The states in which filming hides an idea's title and pitch: nobody has said yes to it. */
const NOT_APPROVED: readonly IdeaState[] = ["heard", "asked", "rejected", "expired"];

/** How the scene's words are changed for a test. With neither option, nothing is changed. */
interface Dress {
  title(key: DemoIdeaKey): string;
  pitch(key: DemoIdeaKey): string;
  quote(key: DemoIdeaKey): string;
  /** One heard line. */
  line(text: string): string;
  /** Any other free text: a note, a reason, a builder's name, a folder name. */
  text(text: string): string;
  /** A build notes file. */
  notes(text: string): string;
  /** The link of a published idea. */
  link(key: DemoIdeaKey, link: string): string;
}

function dressFor(options: { hostile?: boolean; sentinels?: boolean }): Dress {
  const hostile = options.hostile === true;
  const sentinels = options.sentinels === true;
  const end = (text: string): string => (hostile ? `${text} ${HOSTILE_TEXT}`.trimStart() : text);
  const numberOf = (key: DemoIdeaKey): number => DEMO_IDEA_KEYS.indexOf(key) + 1;
  const hidden = (key: DemoIdeaKey): boolean => NOT_APPROVED.includes(CAST[key].state);
  let lines = 0;
  return {
    title: (key) => end(sentinels && hidden(key) ? `${TITLE_SENTINEL}${numberOf(key)} ${CAST[key].title}` : CAST[key].title),
    pitch: (key) => end(sentinels && hidden(key) ? `${PITCH_SENTINEL}${numberOf(key)} ${CAST[key].pitch}` : CAST[key].pitch),
    // An idea nobody said (a rehearsal) has no quote, and gets no sentinel: there is nothing to hide.
    quote: (key) => end(sentinels && CAST[key].quote !== "" ? `${QUOTE_SENTINEL}${numberOf(key)} ${CAST[key].quote}` : CAST[key].quote),
    line: (text) => {
      lines += 1;
      return end(sentinels ? `${LINE_SENTINEL}${lines} ${text}` : text);
    },
    text: end,
    notes: (text) => end(sentinels ? `${text}\n${NOTES_SENTINEL}\n` : text),
    link: (key, link) => (hostile ? ((HOSTILE_LINKS as Partial<Record<DemoIdeaKey, string>>)[key] ?? HOSTILE_LINKS.packingChecklist) : link),
  };
}

// ---------- the lines "heard" ----------

/** Invented small talk. A conversation's lines are picked from here by counting, so a seed is the same every time. */
const SMALL_TALK: readonly string[] = [
  "did anyone feed the dog yet",
  "okay",
  "the forecast says rain after lunch, so bring the washing in before you go",
  "we are almost out of milk again",
  "sure",
  "I think the game starts at seven",
  "can you pass the salt",
  "careful, that pan is still hot",
  "who left the porch light on all night",
  "hm, maybe",
  "the bus was late again this morning, it did not come until twenty past",
  "let us take the long way home",
  "I will get the door",
  "homework first, then the tablet",
  "this soup wants more pepper",
  "yes",
  "the tractor needs a new belt before we start on the hay",
  "remember to water the tomatoes",
  "what time is practice tomorrow",
  "that sounds good to me",
  "I put the keys on the hook by the back door",
  "is there any more coffee",
  "no way",
  "the fence on the north side wants fixing before the calves go out there",
  "we could go to the lake on Saturday if the weather holds",
  "turn that down a little, please",
  "nice one",
  "the library books are due back on Thursday",
  "whose boots are these",
  "I will start the dishwasher when everyone has finished",
  "right",
  "there is a parcel on the step",
  "save me a piece of that",
  "it is your turn to pick the film",
  "wait for me",
  "the hens have stopped laying again, it must be the cold",
];

/** A conversation too short to be worth checking: under six words in all. */
const TOO_FEW_WORDS: readonly string[] = ["okay", "yes", "one sec"];

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

// ---------- telling the scene ----------

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A line reaches Overnight a moment after it was spoken. */
const HEARD_AFTER_MS = 1300;

function plus(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

/** "12:41:07" as milliseconds into its day. */
function clockMs(clock: string): number {
  const match = /^(\d\d):(\d\d):(\d\d)$/.exec(clock);
  if (match === null) throw new Error(`"${clock}" is not a time like 12:41:07.`);
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * SECOND_MS;
}

interface Scene {
  /** The folder being filled, with its links followed. */
  root: string;
  store: Store;
  logs: DemoLogs;
  config: Config;
  dress: Dress;
  /** Told with hostile text: two log lines carry markup as well. */
  hostile: boolean;
  /** The moment the scene's clock reads `clock` on the day `daysBack` days before the day of `now`. */
  at(daysBack: number, clock: string, plusMs?: number): Date;
  /** Put a change on the scene's time line. Everything is written in the order it "happened", as in a real database. */
  then(when: Date, change: () => void): void;
  ids: Partial<Record<DemoIdeaKey, string>>;
  /** The folder name each built idea is published under, as the builder made it. */
  slugs: Partial<Record<DemoIdeaKey, string>>;
  /** What each idea's morning check measured, kept for the next version of its report. */
  measured: Partial<Record<DemoIdeaKey, Measured>>;
}

function idOf(s: Scene, key: DemoIdeaKey): string {
  const id = s.ids[key];
  if (id === undefined) throw new Error(`The demo's idea "${key}" is used before it is heard.`);
  return id;
}

function ideaOf(s: Scene, key: DemoIdeaKey): Idea {
  const idea = s.store.getIdea(idOf(s, key));
  if (idea === null) throw new Error(`The demo's idea "${key}" is not in the database.`);
  return idea;
}

type Heard = { idea: DemoIdeaKey; confidence: number; notAsked?: string } | "not an idea" | "too short" | "could not check";

interface Talk {
  day: number;
  from: string;
  to: string;
  lines: number;
  /** When the detector had its answer: a little over two quiet minutes after the last line. */
  detectedAt: string;
  heard: Heard;
}

/** One conversation: its lines, the detector's run over them, and the idea if it found one. */
function talk(s: Scene, number: number, spec: Talk): void {
  const { store, dress } = s;
  const from = s.at(spec.day, spec.from);
  const to = s.at(spec.day, spec.to);
  const detectedAt = s.at(spec.day, spec.detectedAt);
  let conversationKey = "";
  const lineIds: number[] = [];
  let words = 0;

  s.then(from, () => {
    // No real conversation has an id like this one.
    conversationKey = store.resolveConversation({ uuid: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`, startTime: from.toISOString() }, from.toISOString()).key;
  });
  for (let i = 0; i < spec.lines; i += 1) {
    const spokenAt = spec.lines === 1 ? from : plus(from, Math.round(((to.getTime() - from.getTime()) * i) / (spec.lines - 1)));
    let said = spec.heard === "too short" ? (TOO_FEW_WORDS[i % TOO_FEW_WORDS.length] ?? "okay") : (SMALL_TALK[(number * 7 + i * 5) % SMALL_TALK.length] ?? "okay");
    // The quote is one of the conversation's own lines, near its end, as a real quote is.
    if (typeof spec.heard === "object" && i === spec.lines - 3) said = CAST[spec.heard.idea].quote;
    s.then(plus(spokenAt, HEARD_AFTER_MS), () => {
      const text = dress.line(said);
      const saved = store.insertUtterance({ beeUtteranceId: 700_000 + number * 1000 + i, conversationKey, text, spokenAt: spokenAt.toISOString(), receivedAt: plus(spokenAt, HEARD_AFTER_MS).toISOString(), source: "stream" });
      if (saved.id !== null) lineIds.push(saved.id);
      words += wordsIn(text);
    });
  }

  s.then(detectedAt, () => {
    const run = { conversationKey, ranAt: detectedAt.toISOString(), utteranceIds: lineIds, wordCount: words };
    if (spec.heard === "too short") {
      // The two words the listener really records. The dashboard goes by them, so they are never dressed up.
      store.recordDetectorRun({ ...run, outcome: "skipped", reason: "too short" });
      return;
    }
    if (spec.heard === "could not check") {
      store.recordDetectorRun({ ...run, outcome: "failed", reason: dress.text("the detector's answer could not be read (gave up after 3 tries)"), ms: 41_200, attempts: 2 });
      return;
    }
    if (spec.heard === "not an idea") {
      store.recordDetectorRun({
        ...run,
        outcome: "not_idea",
        verdict: { is_idea: false, confidence: 0.08, title: "", pitch: "", quote: "", said_by_wearer_guess: true, likely_media: false, buildable_as_static_web_app: false, reason: dress.text("everyday talk, no app idea") },
        ms: 9_400,
        attempts: 1,
      });
      return;
    }
    const { idea: key, confidence, notAsked } = spec.heard;
    const [title, pitch, quote] = [dress.title(key), dress.pitch(key), dress.quote(key)];
    const detectorRunId = store.recordDetectorRun({
      ...run,
      outcome: "idea",
      verdict: { is_idea: true, confidence, title, pitch, quote, said_by_wearer_guess: true, likely_media: false, buildable_as_static_web_app: notAsked === undefined, reason: dress.text("a small tool somebody wished for out loud") },
      ms: 11_800,
      attempts: 1,
    });
    s.ids[key] = store.createIdea({ title, pitch, quote, confidence, conversationKey, detectorRunId }, detectedAt.toISOString()).id;
    // An idea the listener decides not to ask about stays "heard", with the reason as its note.
    if (notAsked !== undefined) store.setIdeaNote(idOf(s, key), dress.text(notAsked), plus(detectedAt, 200).toISOString());
  });
}

/** The ask goes to the wrist: a to-do in Bee, open until `expires`. */
function asked(s: Scene, key: DemoIdeaKey, when: Date, expires: Date, todoId: number): void {
  s.then(when, () => void s.store.transitionIdea(idOf(s, key), "asked", { todoId, askedAt: when.toISOString(), askExpiresAt: expires.toISOString(), note: null }, when.toISOString()));
}

/** The three ways an ask ends, with the notes the listener really leaves. */
function answered(s: Scene, key: DemoIdeaKey, when: Date, how: "ticked" | "deleted" | "no answer"): void {
  const at = when.toISOString();
  s.then(when, () => {
    if (how === "ticked") s.store.transitionIdea(idOf(s, key), "approved", { answeredAt: at, note: s.dress.text("ticked in Bee") }, at);
    else if (how === "deleted") s.store.transitionIdea(idOf(s, key), "rejected", { answeredAt: at, note: s.dress.text("deleted in Bee") }, at);
    else s.store.transitionIdea(idOf(s, key), "expired", { note: s.dress.text("no answer by the cutoff") }, at);
  });
}

/** The notes `overnight rehearse new` gives an idea (cli, commands/rehearse.ts). A test holds them to the cli's own. */
export const REHEARSAL_NOTES = {
  heard: "rehearsal: an invented idea, never heard by Bee",
  asked: "rehearsal: never asked on the wrist",
  approved: "rehearsal: approved by hand, not on the wrist",
} as const;

/** What `overnight rehearse new` leaves when run at `madeAt`: an idea nobody said, already approved, dated the day before. */
function rehearsalIdea(s: Scene, key: DemoIdeaKey, madeAt: Date): void {
  const heardAt = plus(madeAt, -DAY_MS - 10 * MINUTE_MS);
  const approvedAt = plus(madeAt, -DAY_MS);
  s.then(heardAt, () => {
    const heard = heardAt.toISOString();
    s.ids[key] = s.store.createIdea({ title: s.dress.title(key), pitch: s.dress.pitch(key), quote: s.dress.quote(key), confidence: 1, conversationKey: REHEARSAL_CONVERSATION_KEY, detectorRunId: null, note: s.dress.text(REHEARSAL_NOTES.heard) }, heard).id;
    s.store.transitionIdea(idOf(s, key), "asked", { askedAt: heard, note: s.dress.text(REHEARSAL_NOTES.asked) }, heard);
  });
  s.then(approvedAt, () => void s.store.transitionIdea(idOf(s, key), "approved", { answeredAt: approvedAt.toISOString(), note: s.dress.text(REHEARSAL_NOTES.approved) }, approvedAt.toISOString()));
}

// ---------- a build ----------

/** How one builder's try ended: after how long, and how. */
type Ends = { afterMs: number; ok: true; credits?: number } | { afterMs: number; ok: false; reason: string };

interface BuildStory {
  /** What Kiro's sign-in line says before the first try. */
  minutesLeft: number;
  /** How long the sandbox check took. Null: it ran earlier in the same run, so it is not logged again. */
  sandboxMs: number | null;
  first: Backend;
  /** Left out: the first builder is still at it when the scene stops. */
  firstEnds?: Ends;
  /** The other builder, tried once after the first one failed. */
  second?: { backend: Backend; minutesLeft: number; ends: Ends };
  /** What BUILD_NOTES.md says, if the build got as far as writing it. */
  notes?: readonly string[];
}

/** The reasons the real builders give (builder, kiro-crew.ts and build-status.ts). Invented for these ideas, real in their wording. */
const PAST_TIME_LIMIT = (minutes: number): string => `the build ran past its time limit of ${minutes} minute${minutes === 1 ? "" : "s"}`;
const STOPPED_EARLY = "the builder stopped before it finished";
const REPORTED_FAILED = "the builder reported that the build failed (its notes are in BUILD_NOTES.md in the workspace)";

/** The agent's start line: each builder logs its own. */
function agentStarts(s: Scene, key: DemoIdeaKey, backend: Backend, when: Date): void {
  s.then(when, () => {
    if (backend === "kiro-crew") s.logs.line("crewStarted", when, { ideaId: idOf(s, key), jobId: `demo-job-${DEMO_IDEA_KEYS.indexOf(key) + 1}`, timeoutSecs: s.config.buildTimeoutMin * 60 });
    else s.logs.line("cliStarted", when, { ideaId: idOf(s, key), timeoutMin: s.config.buildTimeoutMin });
  });
}

/** The files a try leaves in the workspace, as far as it got. `until` is when the try ends, or the end of the scene. */
function filesOfTry(s: Scene, key: DemoIdeaKey, agentAt: Date, until: Date, wrote: "everything" | "a start", notes: readonly string[] | undefined): void {
  const length = until.getTime() - agentAt.getTime();
  const file = (when: Date, name: WorkspaceFile) => {
    if (when.getTime() >= until.getTime()) return;
    s.then(when, () => writeWorkspaceFile(s.root, idOf(s, key), name, name === "BUILD_NOTES.md" ? s.dress.notes(demoBuildNotes(ideaOf(s, key).title, notes ?? [])) : ""));
  };
  file(plus(agentAt, 6 * SECOND_MS), "BUILD_STATUS.json");
  file(plus(agentAt, 40 * SECOND_MS), "package.json");
  if (wrote !== "everything") return;
  file(plus(agentAt, Math.round(length * 0.55)), "node_modules");
  file(plus(agentAt, Math.round(length * 0.85)), "dist/index.html");
  if (notes !== undefined) file(plus(agentAt, Math.round(length * 0.93)), "BUILD_NOTES.md");
}

/**
 * One idea's build, as the night builder runs it (builder, night.ts): the idea moves to
 * "building", Kiro's sign-in is looked at, the sandbox is checked, the agent starts, and it ends
 * "built" or "build_failed", after one try on the other builder if the first one failed.
 * Returns when and how it ended, or null if it is still going when the scene stops.
 */
function build(s: Scene, key: DemoIdeaKey, start: Date, story: BuildStory): { at: Date; ok: boolean } | null {
  const { store, logs, dress } = s;
  const stopped = story.firstEnds?.ok === false && story.firstEnds.reason === BUILD_STOPPED_REASON;

  s.then(start, () => {
    const idea = ideaOf(s, key);
    // The folder name comes from the title as it really is, by the builder's own rule.
    const slug = slugFor(CAST[key].title, (taken) => store.findIdeaBySlug(taken) !== null);
    s.slugs[key] = slug;
    writeBriefs(s.root, idea);
    store.transitionIdea(idea.id, "building", { slug: dress.text(slug), buildBackend: dress.text(story.first), buildStartedAt: start.toISOString(), builtAt: null, failureReason: null, note: dress.text(`building with ${backendLabel(story.first)}`) }, start.toISOString());
    logs.line("ideaStart", start, { ideaId: idea.id, backend: story.first });
  });
  const signIn = plus(start, 1200);
  s.then(signIn, () => logs.line("signInReady", signIn, { minutesLeft: story.minutesLeft, waitedSeconds: 0 }));
  let agentAt = plus(signIn, 1100);
  if (story.sandboxMs !== null) {
    const sandboxMs = story.sandboxMs;
    const checked = plus(signIn, 100 + sandboxMs);
    s.then(checked, () => logs.line("sandboxPassed", checked, { ms: sandboxMs }));
    agentAt = plus(checked, 1100);
  }
  agentStarts(s, key, story.first, agentAt);

  const first = story.firstEnds;
  if (first === undefined) {
    filesOfTry(s, key, agentAt, plus(s.at(0, DEMO_CLOCK_SECONDS), 1), "a start", undefined);
    return null;
  }
  const firstEnd = plus(start, first.afterMs);
  filesOfTry(s, key, agentAt, firstEnd, first.ok ? "everything" : "a start", first.ok ? story.notes : undefined);

  /** Recorded as built, then moved out of the build jobs' reach, as the builder does it. */
  const built = (when: Date, backend: Backend, credits: number | undefined): { at: Date; ok: boolean } => {
    s.then(when, () => {
      const seconds = Math.round((when.getTime() - start.getTime()) / SECOND_MS);
      writeBuildStatus(s.root, idOf(s, key), "built");
      store.transitionIdea(idOf(s, key), "built", { builtAt: when.toISOString(), buildBackend: dress.text(backend), failureReason: null, note: dress.text(`built with ${backendLabel(backend)} in ${seconds} s`) }, when.toISOString());
      sealWorkspace(s.root, idOf(s, key));
      logs.line("ideaBuilt", when, { ideaId: idOf(s, key), backend, seconds, credits });
      logs.line("sealed", when, { ideaId: idOf(s, key), filesMadeAnew: DEMO_FILES_MADE_ANEW });
    });
    return { at: when, ok: true };
  };
  const failed = (when: Date, backend: Backend, reason: string): { at: Date; ok: boolean } => {
    s.then(when, () => {
      const seconds = Math.round((when.getTime() - start.getTime()) / SECOND_MS);
      // "The build was stopped" is the one reason the retry rule goes by, so it stays word for word.
      const recorded = stopped ? reason : dress.text(reason);
      store.transitionIdea(idOf(s, key), "build_failed", { failureReason: recorded, note: dress.text("the build failed") }, when.toISOString());
      logs.line("ideaFailed", when, { ideaId: idOf(s, key), backend, seconds, reason: recorded });
    });
    return { at: when, ok: false };
  };

  if (first.ok) return built(firstEnd, story.first, first.credits);
  // Told to stop: that is the whole reason, and the other builder is not tried.
  if (stopped) return failed(firstEnd, story.first, first.reason);
  const firstReason = `${backendLabel(story.first)}: ${first.reason}`;
  const second = story.second;
  if (second === undefined) return failed(firstEnd, story.first, firstReason);

  s.then(firstEnd, () => {
    logs.line("fallback", firstEnd, { ideaId: idOf(s, key), backend: story.first, couldNotStart: false, reason: dress.text(first.reason), next: second.backend });
    // A second try never starts on top of the first one's files.
    setWorkspaceAside(s.root, idOf(s, key), firstEnd);
    writeBriefs(s.root, ideaOf(s, key));
    store.updateIdea(idOf(s, key), { buildBackend: dress.text(second.backend), buildStartedAt: firstEnd.toISOString(), note: dress.text(`building with ${backendLabel(second.backend)}`) }, firstEnd.toISOString());
  });
  const secondSignIn = plus(firstEnd, 1200);
  s.then(secondSignIn, () => logs.line("signInReady", secondSignIn, { minutesLeft: second.minutesLeft, waitedSeconds: 0 }));
  const secondAgentAt = plus(secondSignIn, 1100);
  agentStarts(s, key, second.backend, secondAgentAt);
  const secondEnd = plus(firstEnd, second.ends.afterMs);
  // A builder that says it failed has still written its notes.
  filesOfTry(s, key, secondAgentAt, secondEnd, "everything", story.notes);
  if (second.ends.ok) return built(secondEnd, second.backend, second.ends.credits);
  s.then(plus(secondEnd, -1), () => writeBuildStatus(s.root, idOf(s, key), "failed"));
  return failed(secondEnd, second.backend, `${firstReason}. ${backendLabel(second.backend)}: ${second.ends.reason}`);
}

/**
 * A run of the nightly build job: its own start and end lines around the builds, one after the other.
 * `waiting` is what its "night started" line counts: approved ideas, second tries, and how many of them it will build.
 */
function nightlyBuild(s: Scene, start: Date, waiting: { approved: number; retries: number; building: number }, builds: ReadonlyArray<{ key: DemoIdeaKey; story: BuildStory }>): void {
  const { logs, config } = s;
  s.then(start, () => logs.line("buildRunStart", start, { primary: "kiro-crew", fallback: "kiro-cli", sandboxMode: config.buildSandbox, dataDir: s.root }));
  const opened = plus(start, 300);
  s.then(opened, () => logs.line("nightStart", opened, { approved: waiting.approved, retries: waiting.retries, alreadyStartedToday: 0, limit: config.maxBuildsPerNight, building: waiting.building }));
  let next = plus(start, 400);
  let built = 0;
  let failed = 0;
  for (const { key, story } of builds) {
    const end = build(s, key, next, story);
    // Still building when the scene stops: the run has no end yet.
    if (end === null) return;
    if (end.ok) built += 1;
    else failed += 1;
    next = plus(end.at, SECOND_MS);
  }
  const closed = plus(next, -700);
  s.then(closed, () => logs.line("nightEnd", closed, { built, failed, leftForAnotherNight: 0 }));
  const over = plus(next, -400);
  s.then(over, () => {
    // With `hostile`: a line that starts a build of an idea whose "id" is markup, and a run that says why it skipped
    // something in markup. No page may show either.
    if (s.hostile) logs.line("ideaStart", plus(over, -100), { ideaId: `"><xss-probe>`, backend: "kiro-crew" });
    logs.line("buildRunEnd", over, { built, failed, ...(s.hostile ? { skipped: HOSTILE_TEXT } : {}) });
  });
}

/** A build started by hand, with `overnight build-now` or `overnight rehearse`: the command's own lines around one build. */
function buildByHand(s: Scene, by: HandRun, key: DemoIdeaKey, start: Date, story: BuildStory): { at: Date; ok: boolean } {
  const { logs, config } = s;
  s.then(start, () => logs.line("handRunStart", start, { ideaId: idOf(s, key), primary: "kiro-crew", fallback: "kiro-cli", sandboxMode: config.buildSandbox }, by));
  const end = build(s, key, plus(start, 800), story);
  if (end === null) throw new Error("A build by hand has to end inside the scene.");
  const over = plus(end.at, 300);
  s.then(over, () => logs.line("handRunEnd", over, { ideaId: idOf(s, key), ok: end.ok, backend: story.second?.backend ?? story.first, ms: over.getTime() - start.getTime(), ...(end.ok ? {} : { stoppedBySignal: "SIGINT" }) }, by));
  return { at: over, ok: end.ok };
}

// ---------- a morning ----------

interface Morning {
  /** How long the check in the sandbox took. */
  verifyMs: number;
  sourceFiles: number;
  sourceBytes: number;
  files: number;
  bytes: number;
  /** From the end of the check to the push. */
  pushMs: number;
  /** From the push to the page being seen. */
  liveAfterMs: number;
  accent: Rgb;
  /** The to-do that tells the wearer, and the fact Bee is asked to remember. Left out: the run was stopped before anyone was told. */
  told?: { todoId: number; factId: number };
}

/** Rewrite an idea's report from the database, with what its check measured. */
function saveReport(s: Scene, key: DemoIdeaKey, at: Date): void {
  const measured = s.measured[key];
  if (measured !== undefined) writeReport(s.root, reportFor(ideaOf(s, key), measured, at));
}

/**
 * One built idea's morning (deliver, deliver.ts): checked in the sandbox with two pictures saved,
 * pushed, seen live and recorded as published, then the wearer is told and Bee is given the fact.
 * Returns when it was over.
 */
function checkAndPublish(s: Scene, key: DemoIdeaKey, start: Date, m: Morning): Date {
  const { store, logs, dress } = s;
  const verified = plus(start, m.verifyMs);
  s.then(verified, () => {
    const id = idOf(s, key);
    s.measured[key] = {
      checks: passedChecks({ sourceFiles: m.sourceFiles, sourceBytes: m.sourceBytes, distFiles: m.files, distBytes: m.bytes, totalMs: m.verifyMs }),
      timings: { verifyMs: m.verifyMs, publishMs: null, liveAfterMs: null },
      confirmedLive: null,
      screenshots: writeScreenshots(s.root, id, m.accent),
      startedAt: start.toISOString(),
    };
    logs.line("verified", verified, { ideaId: id, files: m.files, bytes: m.bytes, ms: m.verifyMs, usedRegistry: false });
  });
  const pushed = plus(verified, m.pushMs);
  s.then(pushed, () => logs.line("pushed", pushed, { ideaId: idOf(s, key), files: m.files, bytes: m.bytes }));
  const live = plus(pushed, m.liveAfterMs);
  s.then(live, () => {
    const id = idOf(s, key);
    const measured = s.measured[key];
    if (measured !== undefined) s.measured[key] = { ...measured, timings: { verifyMs: m.verifyMs, publishMs: m.pushMs + m.liveAfterMs, liveAfterMs: m.liveAfterMs }, confirmedLive: true };
    logs.line("live", live, { ideaId: id, liveAfterMs: m.liveAfterMs, looks: Math.max(1, Math.round(m.liveAfterMs / 5000)) });
    store.transitionIdea(id, "published", { publishedUrl: dress.link(key, `https://example.invalid/overnight-apps/${s.slugs[key] ?? "app"}/`), publishedAt: live.toISOString(), failureReason: null }, live.toISOString());
    saveReport(s, key, live);
    logs.other("deliver", live, "info", "published a built app", { ideaId: id, verifyMs: m.verifyMs, publishMs: m.pushMs + m.liveAfterMs, liveAfterMs: m.liveAfterMs });
  });
  const told = m.told;
  if (told === undefined) return live;

  const toldAt = plus(live, 1800);
  s.then(toldAt, () => {
    const idea = ideaOf(s, key);
    store.transitionIdea(idea.id, "delivered", { deliveredAt: toldAt.toISOString(), morningTodoId: told.todoId, note: idea.note }, toldAt.toISOString());
    logs.line("told", toldAt, { ideaId: idea.id, todoId: told.todoId });
  });
  const factAt = plus(toldAt, 1100);
  s.then(factAt, () => {
    store.updateIdea(idOf(s, key), { factId: told.factId }, factAt.toISOString());
    logs.line("fact", factAt, { ideaId: idOf(s, key), factId: told.factId });
    saveReport(s, key, factAt);
  });
  return factAt;
}

/** A built idea that does not pass the morning check: recorded as not published, with the step it failed at. */
function checkFails(s: Scene, key: DemoIdeaKey, start: Date, f: { verifyMs: number; step: string; reason: string; sourceFiles: number; sourceBytes: number; files: number; bytes: number; accent: Rgb }): Date {
  const { store, logs, dress } = s;
  const failedAt = plus(start, f.verifyMs);
  s.then(failedAt, () => {
    const id = idOf(s, key);
    // Everything up to its own test passed, so the two pictures were saved. With `hostile`, the step's name is markup too.
    const { appSmokeOk: _notReached, ...passedSoFar } = passedChecks({ sourceFiles: f.sourceFiles, sourceBytes: f.sourceBytes, distFiles: f.files, distBytes: f.bytes, totalMs: f.verifyMs });
    const step = dress.text(f.step);
    s.measured[key] = { checks: { ...passedSoFar, failedStep: step }, timings: { verifyMs: f.verifyMs, publishMs: null, liveAfterMs: null }, confirmedLive: null, screenshots: writeScreenshots(s.root, id, f.accent), startedAt: start.toISOString() };
    logs.line("notVerified", failedAt, { ideaId: id, step, ms: f.verifyMs });
    const reason = dress.text(f.reason);
    store.transitionIdea(id, "publish_failed", { failureReason: reason, note: reason }, failedAt.toISOString());
    saveReport(s, key, failedAt);
    logs.other("deliver", failedAt, "warn", "a built app was not published", { ideaId: id, failedStep: step });
  });
  return failedAt;
}

/** The wearer is told, once, that an app could not be finished. */
function tellFailure(s: Scene, key: DemoIdeaKey, when: Date, todoId: number): Date {
  s.then(when, () => {
    const idea = ideaOf(s, key);
    s.store.updateIdea(idea.id, { failureNotifiedAt: when.toISOString() }, when.toISOString());
    s.logs.line("toldFailure", when, { ideaId: idea.id, todoId, state: idea.state });
    saveReport(s, key, when);
  });
  return when;
}

function deliverStarts(s: Scene, when: Date): void {
  s.then(when, () => s.logs.line("deliverRunStart", when, { dataDir: s.root, timeZone: s.config.timeZone, deliverTime: s.config.deliverTime }));
}

function deliverEnds(s: Scene, when: Date, counts: { delivered: number; failed: number; notified: number }): void {
  s.then(when, () => {
    s.logs.other("deliver", plus(when, -200), "info", "deliver run finished", { ...counts, notSeenLive: 0, stopped: false });
    s.logs.line("deliverRunEnd", when, counts);
  });
}

// ---------- what the invented apps' notes say ----------

const NOTES: Partial<Record<DemoIdeaKey, readonly string[]>> = {
  packingChecklist: [
    "Must-have features:",
    "1. Add a thing to pack.",
    "2. Tick it off when it is in the bag.",
    '3. "New trip" keeps the list and clears the ticks.',
    '4. "Try an example" fills in a weekend list.',
    "",
    "What I built: one screen in plain TypeScript with Vite. The list is kept in localStorage.",
    "Checks: npm run build passed. tests/smoke.spec.ts passed (it adds a thing and ticks it).",
    "Left out: sharing one list between two phones, because that needs a server.",
  ],
  readingLog: [
    "Must-have features:",
    "1. Add a book with the date it was finished and one line about it.",
    "2. A count of books for each month.",
    '3. "Try an example" adds three made-up books.',
    "",
    "What I built: one screen in plain TypeScript with Vite. The books are kept in localStorage.",
    "Checks: npm run build passed. tests/smoke.spec.ts passed (it adds a book and reads the count).",
    "Left out: book covers, because they would have to be loaded from another site.",
  ],
  gameNightScores: [
    "Must-have features:",
    "1. Add and remove players.",
    "2. Tap a player to give points for the round.",
    "3. The list sorts itself, leader on top.",
    "",
    "What I built: one screen in plain TypeScript with Vite. Scores are kept in localStorage.",
    "Checks: npm run build passed. I could not get tests/smoke.spec.ts to pass every time: now and then it taps before the list has sorted.",
  ],
  baleYieldCalculator: [
    "Must-have features:",
    "1. Type in acres and bales and see bales per acre.",
    "2. Keep last year's number next to this year's.",
    "",
    "What happened: the page builds, but the sum showed nothing when a field was left empty, and I ran out of time working out why.",
    "Status: failed. Nothing here is ready to publish.",
  ],
  practiceDiceRoller: ["Must-have features:", "1. Pick one to six dice.", "2. Tap to roll and see the total.", "", "What I built: one screen in plain TypeScript with Vite.", "Checks: npm run build passed. tests/smoke.spec.ts passed (it rolls two dice)."],
  practiceTallyCounter: ["Must-have features:", "1. A big plus button.", "2. Undo and reset.", "", "What I built: one screen in plain TypeScript with Vite.", "Checks: npm run build passed. tests/smoke.spec.ts passed (it counts to three)."],
};

const [BLUE, GREEN, PURPLE, ORANGE] = ACCENTS as [Rgb, Rgb, Rgb, Rgb];

// ---------- the scene ----------

function tellScene(s: Scene): void {
  const crewBuilt = (minutesLeft: number, sandboxMs: number | null, afterMs: number, credits: number, key: DemoIdeaKey): BuildStory => ({ minutesLeft, sandboxMs, first: "kiro-crew", firstEnds: { afterMs, ok: true, credits }, ...(NOTES[key] === undefined ? {} : { notes: NOTES[key] }) });
  const timeLimitMs = s.config.buildTimeoutMin * MINUTE_MS;

  // Day 4. The first idea Overnight asks about is not wanted.
  talk(s, 1, { day: 4, from: "11:01:10", to: "11:08:40", lines: 24, detectedAt: "11:11:02", heard: { idea: "coinFlipDecider", confidence: 0.74 } });
  asked(s, "coinFlipDecider", s.at(4, "11:11:05"), s.at(4, "23:00:00"), 41_001);
  answered(s, "coinFlipDecider", s.at(4, "11:19:44"), "deleted");

  // Day 4, afternoon. Two rehearsals by hand, each stopped half-way: one after its app was published and before anyone
  // was "told", one as soon as its app was built.
  rehearsalIdea(s, "practiceDiceRoller", s.at(4, "15:04:00"));
  const dice = buildByHand(s, "rehearse", "practiceDiceRoller", s.at(4, "15:05:12"), crewBuilt(55, 6800, 131_000, 2.84, "practiceDiceRoller"));
  const diceMorning = plus(dice.at, 400);
  s.then(diceMorning, () => s.logs.line("handDeliverStart", diceMorning, { ideaId: idOf(s, "practiceDiceRoller") }, "rehearse"));
  const diceOver = plus(checkAndPublish(s, "practiceDiceRoller", plus(diceMorning, 300), { verifyMs: 5800, sourceFiles: 9, sourceBytes: 8_420, files: 4, bytes: 6_114, pushMs: 2400, liveAfterMs: 19_000, accent: ORANGE }), 900);
  s.then(diceOver, () => s.logs.line("handDeliverEnd", diceOver, { ideaId: idOf(s, "practiceDiceRoller"), ok: false, stoppedBySignal: "SIGINT" }, "rehearse"));

  rehearsalIdea(s, "practiceTallyCounter", s.at(4, "15:20:00"));
  const tally = buildByHand(s, "rehearse", "practiceTallyCounter", s.at(4, "15:21:02"), crewBuilt(39, 7200, 118_000, 2.61, "practiceTallyCounter"));
  const tallyMorning = plus(tally.at, 400);
  s.then(tallyMorning, () => s.logs.line("handDeliverStart", tallyMorning, { ideaId: idOf(s, "practiceTallyCounter") }, "rehearse"));
  const tallyOver = plus(tallyMorning, 2400);
  s.then(tallyOver, () => s.logs.line("handDeliverEnd", tallyOver, { ideaId: idOf(s, "practiceTallyCounter"), ok: false, stoppedBySignal: "SIGINT" }, "rehearse"));

  // Day 3. Three asks, the day's limit: two are ticked, one gets no answer by 11 PM.
  talk(s, 2, { day: 3, from: "09:40:20", to: "09:51:50", lines: 33, detectedAt: "09:54:20", heard: { idea: "readingLog", confidence: 0.81 } });
  asked(s, "readingLog", s.at(3, "09:54:23"), s.at(3, "23:00:00"), 41_002);
  answered(s, "readingLog", s.at(3, "10:03:15"), "ticked");
  talk(s, 3, { day: 3, from: "13:15:00", to: "13:29:10", lines: 41, detectedAt: "13:31:40", heard: { idea: "gameNightScores", confidence: 0.86 } });
  asked(s, "gameNightScores", s.at(3, "13:31:44"), s.at(3, "23:00:00"), 41_003);
  answered(s, "gameNightScores", s.at(3, "13:36:02"), "ticked");
  talk(s, 4, { day: 3, from: "20:02:30", to: "20:11:00", lines: 27, detectedAt: "20:13:30", heard: { idea: "stretchBreakBell", confidence: 0.69 } });
  asked(s, "stretchBreakBell", s.at(3, "20:13:33"), s.at(3, "23:00:00"), 41_004);
  answered(s, "stretchBreakBell", s.at(3, "23:00:06"), "no answer");

  // The night before last. Kiro Crew does not finish "Reading Log", so Kiro CLI builds it. "Game Night Scores" builds.
  nightlyBuild(
    s,
    s.at(2, "01:00:31"),
    { approved: 2, retries: 0, building: 2 },
    [
      { key: "readingLog", story: { minutesLeft: 52, sandboxMs: 6900, first: "kiro-crew", firstEnds: { afterMs: 212_000, ok: false, reason: STOPPED_EARLY }, second: { backend: "kiro-cli", minutesLeft: 48, ends: { afterMs: 241_000, ok: true } }, ...(NOTES.readingLog === undefined ? {} : { notes: NOTES.readingLog }) } },
      { key: "gameNightScores", story: crewBuilt(44, null, 168_000, 4.12, "gameNightScores") },
    ],
  );
  // That morning. One app is delivered. The other does not pass its own test, and the wearer is told so.
  let over = s.at(2, "06:30:04");
  deliverStarts(s, over);
  over = checkAndPublish(s, "readingLog", plus(over, 500), { verifyMs: 7400, sourceFiles: 11, sourceBytes: 10_870, files: 4, bytes: 7_318, pushMs: 2600, liveAfterMs: 31_000, accent: GREEN, told: { todoId: 42_001, factId: 43_001 } });
  over = checkFails(s, "gameNightScores", plus(over, 600), { verifyMs: 9200, step: "app-smoke", reason: "The app's own smoke test (tests/smoke.spec.ts) failed.", sourceFiles: 10, sourceBytes: 9_655, files: 3, bytes: 6_702, accent: PURPLE });
  over = tellFailure(s, "gameNightScores", plus(over, 1300), 42_002);
  deliverEnds(s, plus(over, 700), { delivered: 1, failed: 1, notified: 1 });

  // Day 2. Three asks again. The last is made within an hour of the 11 PM cutoff, so it stays open until the next one.
  talk(s, 5, { day: 2, from: "14:02:10", to: "14:10:00", lines: 29, detectedAt: "14:12:05", heard: { idea: "packingChecklist", confidence: 0.88 } });
  asked(s, "packingChecklist", s.at(2, "14:12:08"), s.at(2, "23:00:00"), 41_005);
  answered(s, "packingChecklist", s.at(2, "14:20:40"), "ticked");
  talk(s, 6, { day: 2, from: "17:30:00", to: "17:38:05", lines: 36, detectedAt: "17:40:12", heard: { idea: "baleYieldCalculator", confidence: 0.77 } });
  asked(s, "baleYieldCalculator", s.at(2, "17:40:15"), s.at(2, "23:00:00"), 41_006);
  answered(s, "baleYieldCalculator", s.at(2, "17:52:03"), "ticked");
  talk(s, 7, { day: 2, from: "21:02:00", to: "21:12:10", lines: 22, detectedAt: "21:14:20", heard: { idea: "carpoolTextAlerts", confidence: 0.72, notAsked: "needs more than a static web page" } });
  talk(s, 8, { day: 2, from: "22:28:00", to: "22:36:00", lines: 19, detectedAt: "22:38:10", heard: { idea: "recipeDoubler", confidence: 0.83 } });
  asked(s, "recipeDoubler", s.at(2, "22:38:13"), s.at(1, "23:00:00"), 41_007);

  // Last night. "Packing Checklist" builds in 2 min 40 s. "Bale Yield Calculator" runs out of time, and the second builder gives up.
  nightlyBuild(s, s.at(1, "01:00:44"), { approved: 2, retries: 0, building: 2 }, [
    { key: "packingChecklist", story: crewBuilt(38, 7300, 160_000, 4.59, "packingChecklist") },
    {
      key: "baleYieldCalculator",
      story: { minutesLeft: 35, sandboxMs: null, first: "kiro-crew", firstEnds: { afterMs: timeLimitMs + 5000, ok: false, reason: PAST_TIME_LIMIT(s.config.buildTimeoutMin) }, second: { backend: "kiro-cli", minutesLeft: 51, ends: { afterMs: 818_000, ok: false, reason: REPORTED_FAILED } }, ...(NOTES.baleYieldCalculator === undefined ? {} : { notes: NOTES.baleYieldCalculator }) },
    },
  ]);
  // Yesterday morning. One app delivered, and the wearer told about the one that could not be built.
  over = s.at(1, "06:30:05");
  deliverStarts(s, over);
  over = checkAndPublish(s, "packingChecklist", plus(over, 500), { verifyMs: 6600, sourceFiles: 10, sourceBytes: 9_102, files: 3, bytes: 5_940, pushMs: 2500, liveAfterMs: 26_000, accent: BLUE, told: { todoId: 42_003, factId: 43_002 } });
  over = tellFailure(s, "baleYieldCalculator", plus(over, 1500), 42_004);
  deliverEnds(s, plus(over, 700), { delivered: 1, failed: 0, notified: 1 });

  // Day 1 is the page's "today": it began at 7:00 AM. Six conversations, 214 lines, three asks.
  talk(s, 9, { day: 1, from: "08:02:10", to: "08:10:05", lines: 38, detectedAt: "08:14:40", heard: "could not check" });
  talk(s, 10, { day: 1, from: "10:20:05", to: "10:20:21", lines: 3, detectedAt: "10:22:30", heard: "too short" });
  talk(s, 11, { day: 1, from: "12:30:10", to: "12:38:50", lines: 64, detectedAt: "12:41:07", heard: { idea: "choreWheel", confidence: 0.91 } });
  asked(s, "choreWheel", s.at(1, "12:41:10"), s.at(1, "23:00:00"), 41_008);
  answered(s, "choreWheel", s.at(1, "12:46:18"), "ticked");
  talk(s, 12, { day: 1, from: "14:57:00", to: "15:05:40", lines: 58, detectedAt: "15:08:02", heard: { idea: "lunchTurns", confidence: 0.84 } });
  asked(s, "lunchTurns", s.at(1, "15:08:05"), s.at(1, "23:00:00"), 41_009);
  answered(s, "lunchTurns", s.at(1, "15:15:27"), "ticked");
  // Yesterday's late ask is ticked in the afternoon, and its build is started by hand and then stopped. A build that
  // was stopped is not a failure: it waits, behind the two older approvals, for one more try.
  answered(s, "recipeDoubler", s.at(1, "17:31:09"), "ticked");
  buildByHand(s, "build-now", "recipeDoubler", s.at(1, "18:20:02"), { minutesLeft: 41, sandboxMs: 7000, first: "kiro-crew", firstEnds: { afterMs: 217_000, ok: false, reason: BUILD_STOPPED_REASON } });
  talk(s, 13, { day: 1, from: "19:05:10", to: "19:15:00", lines: 9, detectedAt: "19:17:20", heard: "not an idea" });
  talk(s, 14, { day: 1, from: "22:07:00", to: "22:15:30", lines: 42, detectedAt: "22:17:44", heard: { idea: "plantWateringDays", confidence: 0.79 } });
  // Asked with less than an hour to the cutoff, so the ask is still open at 1:02 AM.
  asked(s, "plantWateringDays", s.at(1, "22:17:47"), s.at(0, "23:00:00"), 41_010);

  // Tonight. The build job starts 47.6 seconds past 1:00 AM. Three ideas wait and two a night are built, oldest
  // approval first: "Chore Wheel", which has been building for 72 seconds, and then "Lunch Turns", which is still
  // only approved when the scene stops. "Recipe Doubler" waits for another night.
  nightlyBuild(s, s.at(0, "01:00:47", 600), { approved: 2, retries: 1, building: 2 }, [{ key: "choreWheel", story: { minutesLeft: 47, sandboxMs: 7100, first: "kiro-crew" } }]);
}

/**
 * Fill `dir` with the demo's invented scene, as it stands at `now` (drawn for a clock that reads
 * 1:02 AM then). `dir` must be an existing, empty folder, and is refused if it is, is inside, or
 * holds Overnight's real data folder: a DemoFolderError says which. Nothing outside `dir` is
 * written, whatever `config.dataDir` says.
 *
 * `hostile` ends every free text with HOSTILE_STRINGS and gives published ideas HOSTILE_LINKS.
 * `sentinels` marks every quote, heard line, build notes file, and the title and pitch of every
 * idea nobody approved, so a test can tell whether one got onto a page.
 *
 * Returns the id of each idea by its name in the scene (the ids are new every time).
 */
export function seedDemoData(dir: string, o: { now: Date; config: Config; hostile?: boolean; sentinels?: boolean }): { ideaIds: Record<DemoIdeaKey, string> } {
  if (!(o.now instanceof Date) || Number.isNaN(o.now.getTime())) throw new TypeError("The demo needs a real time to be told from.");
  const root = emptyDemoFolder(dir);
  const now = o.now;
  const nowClockMs = clockMs(DEMO_CLOCK_SECONDS);
  const at = (daysBack: number, clock: string, plusMs = 0): Date => new Date(now.getTime() - (daysBack * DAY_MS + nowClockMs - clockMs(clock)) + plusMs);

  // The note first: whatever happens next, the folder says what it is.
  writeInside(root, [DEMO_MARKER_FILE], DEMO_MARKER_TEXT);
  checkDemoFolders(root);

  const changes: Array<{ at: number; change: () => void }> = [];
  const store = new Store(plainFileOrMissing(root, "overnight.db"));
  try {
    const start = at(5, "12:00:00");
    store.setValue("dashboard_demo", "true", start.toISOString());
    // As after the first `overnight resume`: asking and building are switched on.
    store.setPaused(false, start.toISOString());
    const logs = openDemoLogs(root);
    logs.mark(start);

    const scene: Scene = {
      root,
      store,
      logs,
      config: o.config,
      dress: dressFor(o),
      hostile: o.hostile === true,
      at,
      then: (when, change) => {
        // The scene is the past. A change dated after `now` would be a mistake in the telling.
        if (when.getTime() > now.getTime()) throw new Error("The demo's scene never writes the future.");
        changes.push({ at: when.getTime(), change });
      },
      ids: {},
      slugs: {},
      measured: {},
    };
    tellScene(scene);
    // Oldest first; changes at the same moment keep the order they were told in.
    changes.sort((a, b) => a.at - b.at);
    for (const { change } of changes) change();

    const ideaIds = Object.fromEntries(DEMO_IDEA_KEYS.map((key) => [key, idOf(scene, key)])) as Record<DemoIdeaKey, string>;
    return { ideaIds };
  } finally {
    store.close();
  }
}
