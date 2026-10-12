/* global document, window, fetch, DOMParser, setTimeout, setInterval */
// Overnight dashboard: keeps the page in front of you fresh. It changes nothing anywhere.
//
// Every few seconds it asks for this same page again and moves in the parts that changed: the
// regions marked data-live, compared by their data-rev fingerprint. Between looks it keeps the
// clocks ticking. It writes to the page only with textContent, classList, hidden and open, and by
// moving in parts the server made, so no text ever becomes markup here.

const STOPPED = "The dashboard has stopped or was restarted. Open its new link.";
const body = document.body;
const notice = document.getElementById("notice");

// The server's clock may be a pretend one (the demo). Every time on the page goes by it.
let offsetMs = Number(body.dataset.now) - Date.now();
let pollMs = Number(body.dataset.pollMs) || 5000;
let etag = "";
let looking = false;

function wallFormat() {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: body.dataset.timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
}
const wall = wallFormat();

/** "1:02 AM", put together from its pieces so the space before AM is a plain one, as the server writes it. */
function wallTime(ms) {
  const pieces = {};
  for (const part of wall.formatToParts(new Date(ms))) pieces[part.type] = part.value;
  return `${pieces.hour}:${pieces.minute} ${pieces.dayPeriod}`;
}

const two = (n) => String(n).padStart(2, "0");

/** "1:12", and "1:02:07" past the hour. */
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** "12 s ago", "5 min ago", "2 h ago", "3 d ago". */
function ago(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function show(element, text) {
  if (element.textContent !== text) element.textContent = text;
  element.classList.add("on");
}

/** Sets every clock on the page. A time that cannot be read keeps the words the server wrote. */
function tick() {
  const now = Date.now() + offsetMs;
  for (const element of document.querySelectorAll("[data-since]")) {
    const since = Date.parse(element.dataset.since);
    if (!Number.isNaN(since)) show(element, element.dataset.clock === "ago" ? ago(now - since) : elapsed(now - since));
  }
  for (const element of document.querySelectorAll('[data-clock="wall"]')) show(element, wallTime(now));
}

const liveIds = (root) => Array.from(root.querySelectorAll("[data-live]"), (element) => element.id).join(" ");
const ideaOf = (element) => (element.closest("[data-idea]") || body).dataset.idea || "";
/** A name for a step or a tick that stays the same from one look to the next. */
const markName = (element) => `${ideaOf(element)}/${element.dataset.step || `tick:${element.dataset.check}`}`;

/** Moves the changed parts of a newly fetched page into this one. */
function swap(next) {
  const open = Array.from(document.querySelectorAll("details[open][id]"), (element) => element.id);
  const before = new Map();
  for (const element of document.querySelectorAll("[data-step], [data-check]")) before.set(markName(element), element.dataset.status);
  const ideasBefore = new Set(Array.from(document.querySelectorAll("[data-idea]"), ideaOf));

  // A page whose set of live parts changed (nothing saved yet, then something) gets its whole middle replaced.
  const main = document.querySelector("main");
  const nextMain = next.querySelector("main");
  if (main && nextMain && liveIds(main) !== liveIds(nextMain)) main.replaceWith(document.adoptNode(nextMain));
  for (const fresh of Array.from(next.querySelectorAll("[data-live]"))) {
    const old = document.getElementById(fresh.id);
    if (old && old.dataset.rev !== fresh.dataset.rev) old.replaceWith(document.adoptNode(fresh));
  }

  for (const id of open) {
    const element = document.getElementById(id);
    if (element && element.tagName === "DETAILS") element.open = true;
  }
  // A step or a tick that changed pops. So does a tick that is new for an idea already on screen.
  for (const element of document.querySelectorAll("[data-step], [data-check]")) {
    const was = before.get(markName(element));
    const changed = was === undefined ? element.dataset.check !== undefined && ideasBefore.has(ideaOf(element)) : was !== element.dataset.status;
    if (changed) element.classList.add("pop");
  }
}

function stopped(isStopped) {
  if (!notice) return;
  if (isStopped) notice.textContent = STOPPED;
  notice.hidden = !isStopped;
}

/** Asks for this page again. Gives the answer's status, and its text and tag when it is a new page; null when nothing answered. */
async function ask() {
  try {
    const response = await fetch(window.location.href, { headers: etag ? { "If-None-Match": etag } : {}, cache: "no-store" });
    const fresh = response.status === 200;
    return { status: response.status, tag: fresh ? response.headers.get("ETag") || "" : etag, text: fresh ? await response.text() : "" };
  } catch {
    return null;
  }
}

/** One look: ask for this page again, and take in what changed. */
async function look() {
  if (looking || document.hidden) return;
  looking = true;
  try {
    const answer = await ask();
    // No answer, or the key is no longer good: the dashboard was stopped or started again.
    if (answer === null || answer.status === 401) return stopped(true);
    if (answer.status !== 200 && answer.status !== 304) return;
    stopped(false);
    if (answer.status === 304) return;
    const next = new DOMParser().parseFromString(answer.text, "text/html");
    const serverNow = Number(next.body.dataset.now);
    if (!Number.isNaN(serverNow)) offsetMs = serverNow - Date.now();
    pollMs = Number(next.body.dataset.pollMs) || pollMs;
    etag = answer.tag;
    swap(next);
    tick();
  } finally {
    looking = false;
  }
}

async function loop() {
  try {
    await look();
  } finally {
    setTimeout(loop, pollMs);
  }
}

tick();
setInterval(tick, 1000);
// A page with nothing live in its middle (it needs its link, or there is nothing at this address) is not asked for again.
if (document.querySelector("main [data-live]")) {
  setTimeout(loop, pollMs);
  document.addEventListener("visibilitychange", look);
}
