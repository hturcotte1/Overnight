// The real footage, by time. render.mjs scans submission/film/capture/ and hands the page an index:
// { folders: { <name>: [url, ...] }, meta: <capture/meta.json or null> }.
// Until the real frames exist, the scenes draw placeholders.
import { clamp } from "./ease.js";
import { font, roundRect } from "./ui.js";

let INDEX = { folders: {}, meta: null, taps: {} };
export function setCaptureIndex(index) {
  INDEX = { folders: {}, meta: null, taps: {}, ...(index || {}) };
  return Object.fromEntries(Object.entries(INDEX.folders).map(([k, v]) => [k, v.length]));
}
export function captureMeta() {
  return INDEX.meta;
}
export function tapsFor(name) {
  return INDEX.taps[name] || null;
}
export function frames(name) {
  return INDEX.folders[name] || [];
}
/** The first folder of these names that has frames. */
export function firstFrames(...names) {
  for (const n of names) if (frames(n).length) return frames(n);
  return [];
}
/** A timelapse spread evenly over u in [0, 1]: the two frames either side and how far between them. */
export function timelapseAt(list, u) {
  if (!list.length) return null;
  const x = clamp(u) * (list.length - 1);
  const i = Math.floor(x);
  return { a: list[i], b: list[Math.min(list.length - 1, i + 1)], k: x - i, index: i };
}
/** Real-time footage at fps: the frame for s seconds in (held on the last one). */
export function realtimeAt(list, s, fps = 30) {
  if (!list.length) return null;
  return list[Math.max(0, Math.min(list.length - 1, Math.floor(s * fps + 1e-6)))];
}

/** A stand-in for the dashboard until the capture arrives: the dashboard's colours, no real content. */
export function placeholderDashboard(g, w, h, u) {
  g.fillStyle = "#0a0e1c";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#121830";
  roundRect(g, 40, 40, w - 80, 110, 18);
  g.fill();
  g.fillStyle = "#e9ecf8";
  g.font = font(44, 700);
  g.fillText("Overnight", 80, 110);
  g.fillStyle = "#94a0c0";
  g.font = font(26, 500);
  g.fillText("PLACEHOLDER: the real dashboard footage is not captured yet", 380, 108);
  const steps = ["Heard", "Asked", "Approved", "Built", "Tested", "Published", "Delivered"];
  steps.forEach((s, i) => {
    const y = 210 + i * 108;
    const done = u * 7 > i;
    g.fillStyle = "#121830";
    roundRect(g, 40, y, w - 80, 88, 16);
    g.fill();
    g.fillStyle = done ? "#4fd39a" : "#2b3560";
    g.beginPath();
    g.arc(96, y + 44, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#e9ecf8";
    g.font = font(30, 600);
    g.fillText(s, 140, y + 54);
    g.fillStyle = "#2b3560";
    roundRect(g, 420, y + 34, w - 520, 20, 10);
    g.fill();
    g.fillStyle = "#8090ff";
    roundRect(g, 420, y + 34, (w - 520) * clamp(u * 7 - i), 20, 10);
    g.fill();
  });
}

/** A stand-in phone app screen. */
export function placeholderApp(g, w, h, s, title = "Game Night Scores") {
  g.fillStyle = "#f6f3ec";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#1a1e2b";
  g.font = font(64, 800);
  g.fillText(title, 50, 170);
  g.font = font(30, 500);
  g.fillStyle = "#5f667c";
  g.fillText("PLACEHOLDER: app footage not captured yet", 50, 230);
  for (let i = 0; i < 4; i++) {
    const y = 300 + i * 190;
    g.fillStyle = "#fff";
    roundRect(g, 40, y, w - 80, 160, 28);
    g.fill();
    g.fillStyle = "#1a1e2b";
    g.font = font(44, 700);
    g.fillText(`Player ${i + 1}`, 80, y + 95);
    g.font = font(72, 800);
    g.textAlign = "right";
    g.fillText(String(Math.floor((s * (i + 1) * 1.3) % 40)), w - 80, y + 105);
    g.textAlign = "left";
  }
}
