// The shell around every page: the name, the four tabs, the clock, the pills that say which mode
// the dashboard is in, the banner for a database that could not be read, and the footer.
//
// What the script (public/app.js) reads from here:
//   <body data-now data-time-zone data-poll-ms>   the server's clock (maybe a pretend one), its zone, how often to look
//   #pills, #clock, #banners                      live regions, kept fresh like the ones inside <main>
//   #notice                                       hidden; the script shows it when the dashboard stops answering
import type { Chrome, View } from "../types.ts";
import { live, MOON_ICON, NOTHING } from "./components.ts";
import { clockTime } from "./format.ts";
import { html } from "./html.ts";
import type { SafeHtml } from "./html.ts";

const TABS: ReadonlyArray<{ key: Chrome["current"]; href: string; label: string }> = [
  { key: "today", href: "/", label: "Today" },
  { key: "ideas", href: "/ideas", label: "Ideas" },
  { key: "nights", href: "/nights", label: "Nights" },
  { key: "settings", href: "/settings", label: "Settings" },
];

function tabs(current: Chrome["current"]): SafeHtml {
  return html`<nav class="nav" aria-label="Views">${TABS.map((tab) => (tab.key === current ? html`<a href="${tab.href}" aria-current="page">${tab.label}</a>` : html`<a href="${tab.href}">${tab.label}</a>`))}</nav>`;
}

function listeningPill(listener: boolean | null): SafeHtml {
  if (listener === true) return html`<span class="pill pill--live" data-pill="listening">Listening</span>`;
  if (listener === false) return html`<span class="pill pill--off" data-pill="listening">Not listening</span>`;
  return html`<span class="pill pill--unknown" data-pill="listening">Listening: cannot tell</span>`;
}

/**
 * The pills. A page with data on it always says which mode it is in: filming, or showing what
 * was said. A page with no data on it (it needs its link, nothing at this address) says nothing
 * about listening or quotes, because it shows neither; the two warnings, FILMING and DEMO DATA,
 * stay on every page.
 */
function pills(chrome: Chrome): SafeHtml {
  const withData = chrome.current !== "none";
  const listening = withData ? listeningPill(chrome.running.listener) : null;
  const paused = withData && chrome.paused ? html`<span class="pill pill--paused" data-pill="paused">Quiet mode</span>` : null;
  const filming = chrome.filming ? html`<span class="pill pill--film" data-pill="filming">FILMING: what was said is hidden</span>` : null;
  const shows = withData && !chrome.filming ? html`<span class="pill" data-pill="private">Shows what was said</span>` : null;
  const demo = chrome.demo ? html`<span class="pill pill--demo" data-pill="demo">DEMO DATA: invented</span>` : null;
  return html`${listening}${paused}${filming}${shows}${demo}`;
}

/** The banner for a look at the database that failed. "missing" and "empty" are not failures: the page says "Nothing saved yet". */
function banners(chrome: Chrome): SafeHtml {
  if (chrome.problem !== "busy" && chrome.problem !== "unreadable") return NOTHING;
  const showing = chrome.staleSince === null ? "" : ` Showing what was read at ${clockTime(chrome.staleSince, chrome.timeZone)}.`;
  // "Just now" is for a database that was only busy for a moment. One that cannot be read may never be.
  const could = chrome.problem === "busy" ? "Could not read the database just now." : "Could not read the database.";
  return html`<p class="banner" role="status">${could}${showing} Trying again.</p>`;
}

/** The whole page: a view inside the shell. */
export function renderDocument(view: View, chrome: Chrome): SafeHtml {
  const withData = chrome.current !== "none";
  const title = `${chrome.demo ? "DEMO · " : ""}${view.title} · Overnight`;
  const clock = html`<span data-clock="wall">${clockTime(new Date(chrome.nowMs), chrome.timeZone)}</span>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/app.js"></script>
</head>
<body data-now="${chrome.nowMs}" data-time-zone="${chrome.timeZone}" data-poll-ms="${chrome.pollMs}">
<div class="wrap">
<header class="top">
<a class="brand" href="/">${MOON_ICON}Overnight</a>
${withData ? tabs(chrome.current) : null}
${live("clock", clock, "clock")}
${live("pills", pills(chrome), "pills")}
</header>
${live("banners", banners(chrome))}
<div id="notice" class="banner banner--stopped" role="status" hidden></div>
<main id="main">
${view.main}
</main>
<footer class="foot">This page only reads. It answers only on this Mac.</footer>
</div>
</body>
</html>
`;
}
