// Settings: every setting in plain words, whether asking and building are on, and which mode
// this dashboard is in. The page changes nothing: settings live in the .env file.
import type { RenderContext, Snapshot, View } from "../types.ts";
import { count, live } from "./components.ts";
import { backendLabel, clockTime, homeTilde, plural } from "./format.ts";
import { html } from "./html.ts";
import type { SafeHtml } from "./html.ts";

type Config = RenderContext["config"];

interface Row {
  label: string;
  /** The setting's name in the .env file. */
  env: string;
  value: string;
  note?: string;
}

/** "23:00" as "11:00 PM". The settings are checked when they are read, so this is always a time of day; anything else is given back as it is. */
function clockWords(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (match === null) return hhmm;
  const hour = Number(match[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * One row per setting. It is a Record over every name in Config, so a setting added to core
 * without words here fails the typecheck.
 */
function settingRows(s: Snapshot, c: RenderContext): Record<keyof Config, Row> {
  const config = c.config;
  const other = config.buildBackend === "kiro-crew" ? "kiro-cli" : "kiro-crew";
  return {
    dataDir: { label: "Data folder", env: "OVERNIGHT_DATA_DIR", value: homeTilde(config.dataDir, c.home), note: "Everything Overnight saves is kept here, outside the repo." },
    timeZone: { label: "Time zone", env: "TZ", value: config.timeZone, note: "Every time on these pages is in this zone." },
    pausedByDefault: {
      label: "Asking and building",
      env: "PAUSED",
      value: s.paused ? "Paused (quiet mode)" : "On",
      note: `This is what the database says now. The .env file starts it as ${config.pausedByDefault ? "paused" : "on"}.`,
    },
    maxAsksPerDay: { label: "Asks on the wrist", env: "MAX_ASKS_PER_DAY", value: `At most ${count(config.maxAsksPerDay)} a day` },
    askCutoff: {
      label: "Quiet hours",
      env: "ASK_CUTOFF",
      value: `${clockWords(config.askCutoff)} to ${clockWords(config.deliverTime)}`,
      note: "Nothing buzzes the wrist in these hours.",
    },
    buildTime: { label: "Builds start at", env: "BUILD_TIME", value: clockWords(config.buildTime) },
    maxBuildsPerNight: { label: "Builds a night", env: "MAX_BUILDS_PER_NIGHT", value: `At most ${count(config.maxBuildsPerNight)}` },
    buildTimeoutMin: { label: "Time limit for one build", env: "BUILD_TIMEOUT_MIN", value: plural(config.buildTimeoutMin, "minute") },
    maxBuildCreditsPerMonth: {
      label: "Kiro credits a month",
      env: "MAX_BUILD_CREDITS_PER_MONTH",
      value: `At most ${count(config.maxBuildCreditsPerMonth)}`,
      note: config.maxBuildCreditsPerMonth === 0 ? "At 0, nothing is ever built." : "Once this many are counted for the month, nothing more is built until the next one.",
    },
    buildBackend: { label: "Builder", env: "BUILD_BACKEND", value: `${backendLabel(config.buildBackend)} first`, note: `If it fails, ${backendLabel(other)} gets one try.` },
    buildSandbox: {
      label: "Where Kiro Crew runs",
      env: "BUILD_SANDBOX",
      value: config.buildSandbox === "overnight" ? "Inside Overnight's own sandbox" : "Inside Kiro Crew's own sandbox",
    },
    deliverTime: {
      label: "Morning delivery",
      env: "DELIVER_TIME",
      value: clockWords(config.deliverTime),
      note: `Checking and publishing start earlier, at ${clockTime(s.nextDeliverAt, config.timeZone)}.`,
    },
    githubPagesRepo: { label: "Apps are published to", env: "GITHUB_PAGES_REPO", value: `The GitHub Pages repo ${config.githubPagesRepo}`, note: "Published apps are public." },
    writeBeeFacts: { label: "Bee remembers each delivered app", env: "WRITE_BEE_FACTS", value: config.writeBeeFacts ? "Yes" : "No" },
  };
}

/** The order the rows are shown in: where and when first, then asking, building, and the morning. */
const ORDER: ReadonlyArray<keyof Config> = [
  "dataDir",
  "timeZone",
  "pausedByDefault",
  "maxAsksPerDay",
  "askCutoff",
  "buildTime",
  "maxBuildsPerNight",
  "buildTimeoutMin",
  "maxBuildCreditsPerMonth",
  "buildBackend",
  "buildSandbox",
  "deliverTime",
  "githubPagesRepo",
  "writeBeeFacts",
];

function settingItem(row: Row): SafeHtml {
  return html`<div class="setting"><dt>${row.label}<small>${row.env}</small></dt><dd>${row.value}${row.note === undefined ? null : html`<small>${row.note}</small>`}</dd></div>`;
}

function plainItem(label: string, value: string, note?: string): SafeHtml {
  return html`<div class="setting"><dt>${label}</dt><dd>${value}${note === undefined ? null : html`<small>${note}</small>`}</dd></div>`;
}

/** The dashboard's own mode: which data, where it answers, and whether what was said is shown. */
function dashboardItems(s: Snapshot, c: RenderContext, mode: { demo: boolean; port: number }): SafeHtml[] {
  const letThrough = Array.from(c.filming.showQuoteFor);
  const items = [
    plainItem("Data", mode.demo ? "Invented data (demo)" : "Real data", mode.demo ? "Every title, quote and number on these pages is made up." : undefined),
    plainItem("Address", `http://127.0.0.1:${mode.port}`, "It answers only on this Mac, and only when opened from its own link."),
    plainItem(
      "What was said",
      c.filming.on ? "Hidden (filming mode)" : "Each idea's short quote is shown",
      c.filming.on ? "Ideas nobody has approved and the build agent's notes are hidden too." : "Start the dashboard with --filming to hide it.",
    ),
  ];
  if (c.filming.on && letThrough.length > 0) items.push(plainItem("Quotes let through", letThrough.join(", ")));
  items.push(plainItem("The lines Bee heard", "Never shown, in any mode", "Today shows counts, times and bars only."));
  if (s.unreadableRows > 0) items.push(plainItem("Rows left out", plural(s.unreadableRows, "saved row"), "They did not have the shape this page expects, so they are not shown."));
  return items;
}

export function renderSettings(s: Snapshot, c: RenderContext, mode: { demo: boolean; port: number }): View {
  const rows = settingRows(s, c);
  const body = html`<div class="card settings-card"><h2 class="block-title">Overnight</h2><dl class="settings">${ORDER.map((key) => settingItem(rows[key]))}</dl></div>
<div class="card settings-card"><h2 class="block-title">This dashboard</h2><dl class="settings">${dashboardItems(s, c, mode)}</dl></div>
<p class="closing">This page changes nothing. Settings live in the .env file at the top of the repo.</p>`;
  return { title: "Settings", main: html`<h1 class="page-title">Settings</h1>
${live("settings", body)}` };
}
