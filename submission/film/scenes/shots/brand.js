// 86 to 160: the wordmark, how it works, the proof, the end card.
import { ramp, clamp, smooth, inOutSine, inOutCubic, outCubic, outExpo, inCubic, lerp, mix3 } from "../ease.js";
import { superText, label, text, font, measure, roundRect, wrap } from "../ui.js";
import { phoneScreen, phoneParams, appUrl, PW, PH } from "./phone.js";
import { hearParams, hearScreen, askBeatParams, askBeatScreen, morningBeatParams, morningBeatScreen, endParams, endScreen } from "./wrist.js";
import { panelBeat } from "./night.js";
import { SW, SH } from "../watchui.js";

const span = (t, a, b, fi, fo) => Math.min(fi > 0 ? smooth((t - a) / fi) : t >= a ? 1 : 0, fo > 0 ? 1 - smooth((t - (b - fo)) / fo) : t < b ? 1 : 0);
const TAGLINE = "Say it at lunch. Use it at breakfast.";
const ILLUSTRATION = "Illustration";
const BUILD = "Real build, started by hand on Oct 21 at 10:22 p.m., sped up";
const APP = "Real app, in an illustrated phone";

/**
 * The crescent mark (the dashboard's logo): a disc with a round bite out of its upper right. Traced
 * as one outline: the disc's edge outside the bite, then the bite's edge inside the disc.
 */
function crescent(g, cx, cy, r) {
  const bx = r * 0.52, by = -r * 0.42, rb = r * 0.8;
  const d = Math.hypot(bx, by);
  const a = (r * r - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r * r - a * a));
  const ux = bx / d, uy = by / d;
  const p1 = [a * ux - h * uy, a * uy + h * ux], p2 = [a * ux + h * uy, a * uy - h * ux];
  const norm = (x) => { while (x < 0) x += Math.PI * 2; while (x >= Math.PI * 2) x -= Math.PI * 2; return x; };
  // The disc's arc from p1 to p2 the long way round (away from the bite).
  const t1 = Math.atan2(p1[1], p1[0]), t2 = Math.atan2(p2[1], p2[0]);
  const tb = Math.atan2(by, bx);
  const pts = [];
  let span = norm(t2 - t1);
  const ccwHitsBite = norm(tb - t1) < span;
  if (ccwHitsBite) span = span - Math.PI * 2; // go the other way
  for (let i = 0; i <= 64; i++) { const t = t1 + span * i / 64; pts.push([Math.cos(t) * r, Math.sin(t) * r]); }
  // The bite's arc from p2 back to p1, the side that faces the disc's centre.
  const f2 = Math.atan2(p2[1] - by, p2[0] - bx), f1 = Math.atan2(p1[1] - by, p1[0] - bx);
  const toC = Math.atan2(-by, -bx);
  let s2 = norm(f1 - f2);
  if (!(norm(toC - f2) < s2)) s2 = s2 - Math.PI * 2;
  for (let i = 1; i < 64; i++) { const f = f2 + s2 * i / 64; pts.push([bx + Math.cos(f) * rb, by + Math.sin(f) * rb]); }
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(cx + x, cy + y) : g.moveTo(cx + x, cy + y)));
  g.closePath();
  g.fill();
}

/** The wordmark's layout: the crescent, a gap, then "Overnight", centred as one. */
function wordmarkLayout(g, size, y) {
  const wWord = measure(g, "Overnight", size, 700, -0.045);
  const r = size * 0.36, gap = size * 0.2;
  const total = r * 2 + gap + wWord;
  const x0 = 960 - total / 2;
  return { cx: x0 + r, cy: y - size * 0.34, r, wx: x0 + 2 * r + gap, wWord, total };
}

function wordmarkMask(size, y) {
  return (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, 1920, 1080);
    const L = wordmarkLayout(g, size, y);
    g.fillStyle = "#fff";
    g.font = font(size, 700);
    g.letterSpacing = `${-0.045 * size}px`;
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    g.fillText("Overnight", L.wx, y);
    // No blue in the mark: the light shader tints it amber.
    g.fillStyle = "rgb(255,255,0)";
    crescent(g, L.cx, L.cy, L.r);
  };
}

// ---- 86 to 96: "Overnight", revealed in light.
function wordmark(t) {
  if (t < 85.95 || t > 96.0) return null;
  const hit = 86.5;
  const back = t < hit ? 0.3 * ramp(t, 86.0, hit) : lerp(2.2, 0.55, outCubic(clamp((t - hit) / 3.4)));
  const flare = Math.exp(-Math.pow((t - hit) / 0.35, 2)) * 1.0 + 0.12 * ramp(t, 86.1, hit) * (1 - ramp(t, 88, 90));
  return {
    layers: [{
      world: "rays", weight: span(t, 85.95, 96.0, 0.3, 1.0), params: (ts) => ({
        uMask: "mask",
        uLight: [lerp(0.44, 0.56, clamp((ts - 86) / 10)), 0.47],
        uBack: back,
        uRayAmt: lerp(0.55, 0.32, clamp((ts - hit) / 6)),
        uFill: smooth(clamp((ts - 87.3) / 1.8)),
        uEdge: 1 - smooth(clamp((ts - 87.8) / 1.5)) * 0.7,
        uFlare: flare,
        uSweep: lerp(0.1, 0.95, inOutSine(clamp((ts - 88.0) / 2.0))),
        uWarm: [1.0, 0.62, 0.3],
        uCool: [0.45, 0.55, 1.0],
        uBgGlow: 1,
      }),
    }],
    canvases: { mask: { w: 1920, h: 1080, mip: true, draw: wordmarkMask(240, 590) } },
    look: { exposure: 1.0, bloom: 0.45, threshold: 1.35, streak: 0.32, streakTint: [0.7, 0.8, 1.0], vignette: 0.6, maxCoc: 0 },
    ui: (g) => {
      superText(g, TAGLINE, { t, inAt: 89.6, outAt: 95.6, size: 54, weight: 500, y: 740, tracking: -0.01, color: "236,232,255", stagger: 0.12 });
    },
  };
}

// ---- 96 to 128: how it works. Six beats on the score's bar lines (90 BPM: a bar every 16/3 s from 96).
const B0 = 96.0, BEAT = 16 / 3;
const Bt = (i) => B0 + i * BEAT;
const BEATS = [
  { title: "Bee hears it", sub: "the live stream from the wearable", short: "Hears", col: [128, 144, 255], label: ILLUSTRATION },
  { title: "Kiro spots the idea", sub: "Kiro CLI, running with no tools", short: "Spots", col: [141, 134, 255], label: ILLUSTRATION },
  { title: "Your wrist asks", sub: "a Bee to-do: build it tonight?", short: "Asks", col: [157, 125, 255], label: ILLUSTRATION },
  { title: "Kiro Crew builds it overnight", sub: "inside Overnight's own sandbox", short: "Builds", col: [176, 120, 245], label: "Real build, sped up" },
  { title: "Overnight tests and publishes it", sub: "GitHub Pages", short: "Publishes", col: [255, 154, 102], label: APP },
  { title: "The link is on your wrist at 7", sub: "a Bee to-do, and a Bee fact", short: "Delivers", col: [255, 197, 74], label: ILLUSTRATION },
];

/** The beat's picture: a plan with one world layer. */
function beatPicture(i, t, w) {
  const t0 = Bt(i);
  if (i === 0) {
    return { layers: [{ world: "wrist", weight: w, params: (ts) => hearParams(ts, t0) }], canvases: { watch: { w: SW, h: SH, draw: hearScreen(t, t0) } }, look: { maxCoc: 24, bloom: 0.55, threshold: 1.7, streak: 0.2, vignette: 0.72 } };
  }
  if (i === 1) {
    return { layers: [{ world: "plate", weight: w, still: true, params: () => ({ uPlate: "spot", uGain: 1.0, uCoc: 0 }) }], canvases: { spot: { w: 1920, h: 1080, mip: false, draw: (g) => drawSpot(g, t - t0) } }, look: { maxCoc: 0, bloom: 0.5, threshold: 0.8, streak: 0.18, vignette: 0.6 } };
  }
  if (i === 2) {
    return { layers: [{ world: "wrist", weight: w, params: (ts) => askBeatParams(ts, t0) }], canvases: { watch: { w: SW, h: SH, draw: askBeatScreen(t, t0) } }, look: { maxCoc: 26, bloom: 0.55, threshold: 1.7, streak: 0.22, vignette: 0.72 } };
  }
  if (i === 3) {
    const f = lerp(88, 116, clamp((t - t0 + 0.4) / 6.1));
    const opt = { px: 900, py: 330, vdir: [-0.3, 0.1, 0.95], dist: 92, shell: 0.85, drift: [80, 0], shift: [-17, -12] };
    const pb = panelBeat(t, t0, f, opt);
    return { layers: [{ world: "panel", weight: w, params: (ts) => panelBeat(ts, t0, lerp(88, 116, clamp((ts - t0 + 0.4) / 6.1)), opt).params }], canvases: { dash: { ...pb.canvas, mip: true } }, needs: pb.needs, look: { maxCoc: 16, bloom: 0.32, threshold: 1.25, streak: 0.07, vignette: 0.75 } };
  }
  if (i === 4) {
    const s = 9.0 + Math.max(0, t - t0 + 0.4);
    const scr = phoneScreen("app", s, "Game Night Scores");
    return {
      layers: [{ world: "phone", weight: w, params: (ts) => beatPhone(ts, t0) }],
      canvases: { phone: { w: PW, h: PH, draw: scr.draw } },
      needs: scr.needs,
      look: { maxCoc: 14, bloom: 0.55, threshold: 1.1, streak: 0.2, vignette: 0.7 },
    };
  }
  return { layers: [{ world: "wrist", weight: w, params: (ts) => morningBeatParams(ts, t0, appUrl()) }], canvases: { watch: { w: SW, h: SH, draw: morningBeatScreen(t, t0, appUrl()) } }, look: { maxCoc: 26, bloom: 0.62, threshold: 1.7, streak: 0.4, streakTint: [1.0, 0.75, 0.5], vignette: 0.65, grade: [1.04, 1.0, 0.96] } };
}

/** Beat 5's phone: on the right, turning the other way from the 72 s shot. */
function beatPhone(t, t0) {
  const p = phoneParams(t, { start: t0 - 0.4, end: t0 + 6.0, side: 1, hero: 1 });
  const u = clamp((t - t0 + 0.4) / 6.4);
  p.uRot = [lerp(0.1, -0.22, inOutSine(u)), -0.05, 0.02];
  p.uCamTgt = [lerp(-6.6, -7.2, u), 15.6, 0];
  p.uCamPos = [p.uCamTgt[0] + 2.5, 17.5, lerp(32, 29, inOutSine(u))];
  p.uFocus = Math.hypot(p.uCamPos[0], p.uCamPos[1] - 16, p.uCamPos[2]);
  return p;
}

/**
 * Beat 2's picture: abstract lines of a live stream drift up (no words: nothing anyone said), and one of
 * them is picked out and becomes the idea, as a card. An illustration.
 */
function drawSpot(g, s) {
  g.fillStyle = "#03040a";
  g.fillRect(0, 0, 1920, 1080);
  const glow = g.createRadialGradient(1240, 520, 20, 1240, 520, 900);
  glow.addColorStop(0, "rgba(70,62,170,0.36)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 1920, 1080);
  // Two layers of the stream: far (small, slow, soft) and near (larger, faster).
  const layerOf = (depth, n, speed, blur, alpha, h) => {
    g.save();
    g.filter = blur > 0.3 ? `blur(${blur}px)` : "none";
    for (let i = 0; i < n; i++) {
      const r1 = Math.abs(Math.sin(i * 12.9898 + depth * 7.1)) % 1;
      const r2 = Math.abs(Math.sin(i * 78.233 + depth * 3.3)) % 1;
      const x = 820 + r1 * 900 - depth * 120;
      const y = ((i * 97 + depth * 41) % 1300) - 110 - s * speed;
      const yy = ((y % 1300) + 1300) % 1300 - 110;
      const w = 160 + r2 * 360;
      const a = alpha * (0.5 + 0.5 * r2) * Math.min(1, yy / 200 + 0.2, (1080 - yy) / 200 + 0.2);
      g.fillStyle = `rgba(170,180,255,${Math.max(0, a)})`;
      roundRect(g, x, yy, w, h, h / 2);
      g.fill();
    }
    g.restore();
  };
  layerOf(0, 34, 26, 4, 0.16, 12);
  layerOf(1, 22, 60, 1.2, 0.26, 16);
  // The idea: a card that rises out of the stream and lights up as it is recognised.
  const k = outCubic(clamp((s - 0.7) / 1.3));
  const lit = smooth(clamp((s - 1.6) / 0.8));
  const cx = 1250, cy = 540 + (1 - k) * 90;
  const cw = 760, ch = 300;
  g.save();
  g.globalAlpha = k;
  const halo = g.createRadialGradient(cx, cy, 40, cx, cy, 560);
  halo.addColorStop(0, `rgba(141,134,255,${0.32 * lit})`);
  halo.addColorStop(1, "rgba(141,134,255,0)");
  g.fillStyle = halo;
  g.fillRect(cx - 600, cy - 600, 1200, 1200);
  const cg = g.createLinearGradient(0, cy - ch / 2, 0, cy + ch / 2);
  cg.addColorStop(0, "rgba(28,28,46,0.96)");
  cg.addColorStop(1, "rgba(18,18,30,0.96)");
  g.fillStyle = cg;
  roundRect(g, cx - cw / 2, cy - ch / 2, cw, ch, 34);
  g.fill();
  g.strokeStyle = `rgba(170,165,255,${0.25 + 0.6 * lit})`;
  g.lineWidth = 2.5;
  roundRect(g, cx - cw / 2 + 1, cy - ch / 2 + 1, cw - 2, ch - 2, 33);
  g.stroke();
  // The scan line that reads the card.
  const sx = cx - cw / 2 + cw * clamp((s - 1.1) / 1.1);
  if (s > 1.1 && s < 2.4) {
    const sg = g.createLinearGradient(sx - 60, 0, sx + 4, 0);
    sg.addColorStop(0, "rgba(160,160,255,0)");
    sg.addColorStop(1, "rgba(200,200,255,0.5)");
    g.save();
    roundRect(g, cx - cw / 2, cy - ch / 2, cw, ch, 34);
    g.clip();
    g.fillStyle = sg;
    g.fillRect(sx - 60, cy - ch / 2, 64, ch);
    g.restore();
  }
  const x0 = cx - cw / 2 + 52;
  g.fillStyle = `rgba(141,134,255,${0.9})`;
  roundRect(g, x0, cy - ch / 2 + 44, 108, 40, 20);
  g.fill();
  g.fillStyle = "#0b0b18";
  g.font = font(22, 800);
  g.letterSpacing = "2px";
  g.fillText("IDEA", x0 + 26, cy - ch / 2 + 72);
  g.letterSpacing = "0px";
  g.fillStyle = "#fff";
  g.font = font(60, 700);
  g.fillText("Game Night Scores", x0, cy - ch / 2 + 156);
  g.fillStyle = "rgba(205,208,235,0.92)";
  g.font = font(27, 500);
  const lines = wrap(g, "Keep score for a board game night on one phone: add players, tap to add points, and see who is winning.", cw - 104);
  lines.forEach((l, j) => g.fillText(l, x0, cy - ch / 2 + 204 + j * 36));
  g.restore();
}

function flow(t) {
  if (t < 95.7 || t > 128.1) return null;
  const plans = [];
  for (let i = 0; i < BEATS.length; i++) {
    const a = i === 0 ? Bt(0) - 0.1 : Bt(i) - 0.35, b = Bt(i + 1) + 0.35;
    if (t < a || t > b) continue;
    let w = span(t, a, b, i === 0 ? 0.55 : 0.7, i === 5 ? 0 : 0.7);
    if (i === 5) w *= 1 - smooth((t - 127.2) / 0.7);
    plans.push(beatPicture(i, t, w));
  }
  plans.push({ ui: (g) => drawFlow(g, t) });
  return plans;
}

function drawFlow(g, t) {
  const all = ramp(t, 96.0, 96.6) * (1 - ramp(t, 127.2, 127.8));
  if (all <= 0) return;
  // Shade the lower left so the words read on any picture.
  g.save();
  g.globalAlpha = all;
  const sh = g.createLinearGradient(0, 1080, 900, 420);
  sh.addColorStop(0, "rgba(0,0,0,0.72)");
  sh.addColorStop(0.55, "rgba(0,0,0,0.32)");
  sh.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = sh;
  g.fillRect(0, 0, 1920, 1080);
  g.restore();
  const i = Math.max(0, Math.min(5, Math.floor((t - B0) / BEAT)));
  BEATS.forEach((b, j) => {
    const a = Bt(j), e = Bt(j + 1);
    if (t < a - 0.1 || t > e + 0.1) return;
    const col = b.col.join(",");
    superText(g, String(j + 1).padStart(2, "0") + "  /  06", { t, inAt: a + 0.08, outAt: e - 0.15, size: 26, weight: 600, x: 150, y: 684, align: "left", tracking: 0.12, color: col, stagger: 0.04, rise: 8 });
    superText(g, b.title, { t, inAt: a + 0.18, outAt: e - 0.15, size: 88, weight: 700, x: 146, y: 790, align: "left", tracking: -0.035, stagger: 0.07 });
    superText(g, b.sub, { t, inAt: a + 0.45, outAt: e - 0.15, size: 38, weight: 500, x: 150, y: 848, align: "left", tracking: -0.01, color: b.col.map((v) => Math.round(v * 0.55 + 115)).join(","), stagger: 0.04, rise: 10 });
  });
  // The rail: all six steps, lit up to where we are, drifting so the frame is never held.
  const y = 968, gap = 214;
  const drift = 26 * Math.sin((t - B0) * 0.21);
  const x0 = 1920 - 150 - 5 * gap + drift;
  const prog = clamp((t - B0) / BEAT, 0, 6);
  g.save();
  g.globalAlpha = all;
  g.strokeStyle = "rgba(255,255,255,0.16)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(x0 + 5 * gap, y);
  g.stroke();
  const litTo = x0 + gap * clamp(prog - 0.15, 0, 5);
  const lg = g.createLinearGradient(x0, 0, x0 + 5 * gap, 0);
  BEATS.forEach((b, j) => lg.addColorStop(j / 5, `rgba(${b.col.join(",")},0.95)`));
  g.strokeStyle = lg;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(x0, y);
  g.lineTo(litTo, y);
  g.stroke();
  BEATS.forEach((b, j) => {
    const x = x0 + j * gap;
    const on = prog >= j ? 1 : 0;
    const here = j === i ? 1 : 0;
    const pulse = here ? Math.exp(-Math.max(0, t - Bt(j)) * 2.2) : 0;
    if (on) {
      const halo = g.createRadialGradient(x, y, 0, x, y, 34 + 30 * pulse);
      halo.addColorStop(0, `rgba(${b.col.join(",")},${0.55 * (0.5 + 0.5 * here) + 0.4 * pulse})`);
      halo.addColorStop(1, `rgba(${b.col.join(",")},0)`);
      g.fillStyle = halo;
      g.fillRect(x - 70, y - 70, 140, 140);
    }
    g.fillStyle = on ? `rgba(${b.col.join(",")},1)` : "rgba(40,44,70,1)";
    g.beginPath();
    g.arc(x, y, here ? 11 : 8, 0, Math.PI * 2);
    g.fill();
    if (on) {
      g.fillStyle = "rgba(255,255,255,0.95)";
      g.beginPath();
      g.arc(x, y, here ? 4.5 : 3, 0, Math.PI * 2);
      g.fill();
    }
    text(g, b.short, x, y + 44, { size: 21, weight: here ? 700 : 500, align: "center", color: here ? "rgba(255,255,255,0.98)" : on ? "rgba(220,224,245,0.72)" : "rgba(180,186,215,0.42)" });
  });
  g.restore();
  // The chip for the publish beat: the live-after figure, as Overnight records it.
  const a4 = Bt(4);
  if (t > a4 + 1.0 && t < Bt(5)) {
    const k = outCubic(clamp((t - a4 - 1.0) / 0.6)) * (1 - ramp(t, Bt(5) - 0.4, Bt(5)));
    g.save();
    g.globalAlpha = k;
    const x = 150, yy = 556 + (1 - k) * 14;
    g.fillStyle = "rgba(14,26,20,0.86)";
    roundRect(g, x, yy, 360, 64, 32);
    g.fill();
    g.strokeStyle = "rgba(79,211,154,0.7)";
    g.lineWidth = 2;
    roundRect(g, x + 1, yy + 1, 358, 62, 31);
    g.stroke();
    g.fillStyle = "rgb(79,211,154)";
    g.beginPath();
    g.arc(x + 36, yy + 32, 13, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#0b1a12";
    g.lineWidth = 3.5;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(x + 30, yy + 32);
    g.lineTo(x + 35, yy + 37);
    g.lineTo(x + 43, yy + 27);
    g.stroke();
    text(g, "Live after 26 s", x + 64, yy + 42, { size: 28, weight: 700, color: "rgba(235,255,245,1)" });
    g.restore();
  }
}

// ---- 128 to 150: it already works.
const NIGHT = [
  { when: "Oct 10, morning", what: "Said out loud near the watch. Spotted, asked on the wrist, ticked in the Bee app." },
  { when: "That night", what: "Kiro Crew built Plant Watering Tracker in 2 min 40 s, for 4.59 Kiro credits." },
  { when: "7:30 a.m.", what: "Tested and published. Live 26 s later." },
  { when: "7:32 a.m.", what: "The watch buzzed, with the link." },
];

function proof(t) {
  if (t < 127.9 || t > 150.0) return null;
  const plans = [];
  plans.push({
    layers: [{
      world: "atmos", weight: span(t, 128.0, 150.0, 0.5, 0.6), params: () => ({
        uGlowPos: t < 141.4 ? [0.72, 0.5] : [0.5, 0.52],
        uGlowCol: t < 141.4 ? [0.12, 0.14, 0.3] : [0.2, 0.15, 0.1],
        uGlowCol2: [0.015, 0.02, 0.05],
        uGlowAmt: 0.9 + 0.4 * Math.exp(-Math.max(0, t - 128.0) * 1.5),
        uGlowSize: 0.42,
        uNebula: 0.6,
        uMotes: 0.7,
        uCamX: t * 0.004,
        uFloorLine: 0,
        uBase: [0.003, 0.0035, 0.007],
      }),
    }],
    look: { exposure: 1.0, bloom: 0.45, threshold: 1.1, uiGlow: 0.45, streak: 0.12, vignette: 0.6, maxCoc: 10 },
    ui: (g) => drawProof(g, t),
  });
  // The real Plant Watering Tracker, 131.2 to 141.8.
  if (t > 131.2 && t < 141.8) {
    const s = Math.max(0, t - 132.0);
    const scr = phoneScreen("plant", s, "Plant Watering Tracker");
    plans.push({
      layers: [{ world: "phone", weight: span(t, 131.2, 141.8, 0.8, 0.7), params: (ts) => plantPhone(ts) }],
      canvases: { phone: { w: PW, h: PH, draw: scr.draw } },
      needs: scr.needs,
    });
  }
  return plans;
}

function plantPhone(t) {
  const p = phoneParams(t, { start: 131.2, end: 141.8, side: -1, hero: 1 });
  const k = clamp((t - 131.2) / 10.6);
  const tgt = [-11.0, 16.0, 0];
  const dist = lerp(44, 40, inOutSine(k)) + (1 - outCubic(clamp((t - 131.2) / 1.8))) * 8;
  p.uCamTgt = tgt;
  p.uCamPos = [tgt[0] + 1.5, tgt[1] + dist * 0.09, dist];
  p.uRot = [lerp(-0.3, -0.12, inOutSine(k)), -0.05, -0.02];
  p.uFocus = Math.hypot(p.uCamPos[0], p.uCamPos[1] - 16, p.uCamPos[2]);
  p.uScreenAvg = [0.5, 0.55, 0.5];
  p.uScreenGain = 0.62;
  p.uAperture = 6;
  return p;
}

function drawProof(g, t) {
  superText(g, "It already works.", { t, inAt: 128.15, outAt: 131.4, size: 124, weight: 700, y: 580, tracking: -0.035, stagger: 0.12 });
  // The first real night, as a lit timeline.
  if (t > 131.3 && t < 141.6) {
    const out = ramp(t, 140.8, 141.5);
    const a0 = ramp(t, 131.4, 132.0) * (1 - out);
    g.save();
    g.globalAlpha = a0;
    text(g, "THE FIRST REAL NIGHT", 150, 190, { size: 24, weight: 600, tracking: 0.26, color: "rgba(255,200,110,1)" });
    text(g, "Oct 10 to 11, with live Bee data", 150, 262, { size: 54, weight: 700, tracking: -0.025, color: "rgba(255,255,255,1)" });
    g.restore();
    const x = 166, y0 = 372, step = 152;
    const grow = outCubic(clamp((t - 131.9) / 6.0));
    g.save();
    g.globalAlpha = 1 - out;
    const lg = g.createLinearGradient(0, y0, 0, y0 + step * 3);
    lg.addColorStop(0, "rgba(128,144,255,0.9)");
    lg.addColorStop(1, "rgba(255,197,74,0.9)");
    g.strokeStyle = lg;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x, y0 + step * 3 * grow);
    g.stroke();
    g.restore();
    NIGHT.forEach((e, i) => {
      const at = 132.2 + i * 1.6;
      const k = outCubic(clamp((t - at) / 0.8));
      if (k <= 0) return;
      const y = y0 + i * step;
      const col = i < 2 ? "150,165,255" : "255,200,110";
      g.save();
      g.globalAlpha = 1 - out;
      const glow = g.createRadialGradient(x, y, 0, x, y, 26);
      glow.addColorStop(0, `rgba(${col},${0.8 * k})`);
      glow.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = glow;
      g.fillRect(x - 26, y - 26, 52, 52);
      g.fillStyle = `rgba(255,255,255,${k})`;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
      g.restore();
      superText(g, e.when, { t, inAt: at, outAt: 141.5, size: 30, weight: 700, x: x + 40, y: y + 10, align: "left", tracking: 0, color: col, stagger: 0.03, rise: 8, outDur: 0.7 });
      g.save();
      g.font = font(34, 500);
      const lines = wrap(g, e.what, 960);
      g.restore();
      lines.forEach((ln, j) => superText(g, ln, { t, inAt: at + 0.15 + j * 0.12, outAt: 141.5, size: 34, weight: 500, x: x + 40, y: y + 56 + j * 44, align: "left", tracking: -0.01, color: "236,238,248", stagger: 0.025, rise: 8, outDur: 0.7 }));
    });
    superText(g, "hturcotte1.github.io/overnight-apps/plant-watering-tracker/", { t, inAt: 137.6, outAt: 141.5, size: 24, weight: 500, x: x + 40, y: y0 + step * 3 + 104, align: "left", tracking: 0, color: "160,175,240", stagger: 0.01, rise: 6, outDur: 0.7 });
  }
  if (t > 141.4) drawNumbers(g, t);
}

/** The numbers: each gets its own moment, large, then takes its place in a row. */
function drawNumbers(g, t) {
  const cols = [
    { n: 9, fmt: (v) => String(v), label: "real Kiro Crew builds", x: 360 },
    { n: 13, fmt: () => "13 of 13", label: "preflight checks pass", x: 960 }, // never counts up: "12 of 13" would read as a failed check
    { n: 3588, fmt: (v) => v.toLocaleString("en-US"), label: "automated tests", x: 1560 },
  ];
  const out = ramp(t, 149.15, 149.65);
  if (out >= 1) return;
  cols.forEach((c, i) => {
    const at = 141.6 + i * 2.6;
    const k = outCubic(clamp((t - at) / 0.7));
    if (k <= 0) return;
    const move = inOutCubic(clamp((t - at - 1.9) / 0.6));
    const count = outExpo(clamp((t - at) / 1.6));
    const v = Math.round(c.n * count);
    const x = c.x, y = lerp(590, 560, move);
    const size = lerp(i === 1 ? 168 : 200, 140, move);
    const lit = Math.exp(-Math.max(0, t - at) * 1.6) * (1 - move);
    g.save();
    g.globalAlpha = k * (1 - out);
    // Its moment of light: a glow behind it that fades as it takes its place.
    const halo = g.createRadialGradient(x, y - size * 0.32, 10, x, y - size * 0.32, 520);
    halo.addColorStop(0, `rgba(255,214,150,${0.3 * lit + 0.05})`);
    halo.addColorStop(1, "rgba(255,214,150,0)");
    g.fillStyle = halo;
    g.fillRect(x - 540, y - 560, 1080, 1080);
    g.filter = k < 1 ? `blur(${((1 - k) * 10).toFixed(1)}px)` : "none";
    text(g, c.fmt(v), x, y + (1 - k) * 20, { size, weight: 700, align: "center", tracking: -0.04, color: "rgba(255,255,255,1)" });
    g.filter = "none";
    text(g, c.label, x, y + lerp(92, 80, move) + (1 - k) * 20, { size: lerp(42, 34, move), weight: 500, align: "center", color: "rgba(206,212,244,1)" });
    // The builds as nine small lights, the checks as thirteen, while the number has the frame.
    if (move < 1 && i < 2) {
      const m = c.n, dot = i === 0 ? 30 : 22, gap = i === 0 ? 18 : 12;
      const w = m * dot + (m - 1) * gap;
      for (let d = 0; d < m; d++) {
        const on = smooth(clamp((t - at - 0.2 - d * (i === 0 ? 0.11 : 0.07)) / 0.2));
        const dx = c.x - w / 2 + d * (dot + gap);
        g.globalAlpha = k * (1 - move) * (1 - out) * (0.25 + 0.75 * on);
        g.fillStyle = on > 0.5 ? (i === 0 ? "rgba(176,160,255,1)" : "rgba(79,211,154,1)") : "rgba(80,86,120,1)";
        roundRect(g, dx, 760, dot, dot, i === 0 ? 8 : dot / 2);
        g.fill();
      }
    }
    g.restore();
  });
  const lineA = ramp(t, 147.9, 148.6) * (1 - out);
  if (lineA > 0) {
    g.save();
    g.strokeStyle = `rgba(255,255,255,${0.15 * lineA})`;
    g.lineWidth = 1.5;
    [660, 1260].forEach((x) => {
      g.beginPath();
      g.moveTo(x, 430);
      g.lineTo(x, 660);
      g.stroke();
    });
    g.restore();
  }
}

// ---- 150 to 160: the end card. Breakfast light on the wrist, out of focus; the wordmark over it.
function endCard(t) {
  if (t < 150.3) return null;
  const hit = 150.5;
  const fade = 1 - smooth(clamp((t - 158.2) / 1.0));
  const flash = t < hit ? 0 : 2.4 * Math.exp(-(t - hit) * 2.6);
  return {
    layers: [{ world: "wrist", weight: span(t, 150.3, 160, 0.25, 0), params: (ts) => endParams(ts) }],
    canvases: { watch: { w: SW, h: SH, draw: endScreen(t, appUrl()) } },
    look: { exposure: (0.5 + flash) * ramp(t, 150.3, 150.55), maxCoc: 28, bloom: 0.6, threshold: 1.0, uiGlow: 0.5, streak: 0.3, streakTint: [1.0, 0.75, 0.5], vignette: 0.75, grade: [1.04, 1.0, 0.95], fade },
    ui: (g) => drawEnd(g, t),
  };
}

function drawEnd(g, t) {
  const a = ramp(t, 150.5, 151.1);
  if (a <= 0) return;
  // A dark wash in the centre so the words sit on the light, not in it.
  g.save();
  const wash = g.createRadialGradient(960, 520, 50, 960, 520, 900);
  wash.addColorStop(0, `rgba(6,5,8,${0.55 * a})`);
  wash.addColorStop(1, "rgba(6,5,8,0)");
  g.fillStyle = wash;
  g.fillRect(0, 0, 1920, 1080);
  g.restore();
  const size = 168, y = 520;
  const L = wordmarkLayout(g, size, y);
  const k = outCubic(clamp((t - 150.5) / 1.2));
  g.save();
  g.globalAlpha = a;
  g.filter = k < 1 ? `blur(${((1 - k) * 12).toFixed(1)}px)` : "none";
  // The mark, amber; the word, white with a band of light sweeping across it.
  const mg = g.createLinearGradient(L.cx - L.r, L.cy - L.r, L.cx + L.r, L.cy + L.r);
  mg.addColorStop(0, "rgba(255,200,90,1)");
  mg.addColorStop(1, "rgba(255,150,40,1)");
  g.fillStyle = mg;
  crescent(g, L.cx, L.cy + (1 - k) * 10, L.r);
  const sweep = lerp(-0.3, 1.3, inOutSine(clamp((t - 151.0) / 1.8)));
  const sx = L.wx + L.wWord * sweep;
  const wg = g.createLinearGradient(sx - 260, 0, sx + 260, 0);
  wg.addColorStop(0, "rgba(246,244,252,1)");
  wg.addColorStop(0.5, "rgba(255,236,200,1)");
  wg.addColorStop(1, "rgba(246,244,252,1)");
  g.fillStyle = wg;
  g.font = font(size, 700);
  g.letterSpacing = `${-0.045 * size}px`;
  g.textAlign = "left";
  g.fillText("Overnight", L.wx, y + (1 - k) * 10);
  g.restore();
  superText(g, TAGLINE, { t, inAt: 151.5, size: 46, weight: 500, y: 626, tracking: -0.01, color: "240,234,250", stagger: 0.1 });
  superText(g, "github.com/hturcotte1/Overnight", { t, inAt: 152.4, size: 34, weight: 600, y: 748, tracking: 0, color: "255,214,160", stagger: 0.02 });
  superText(g, "Built with Bee and Kiro", { t, inAt: 153.0, size: 28, weight: 500, y: 806, tracking: 0.02, color: "214,206,220", stagger: 0.06 });
}

/** The honesty labels for this half, read by the timeline: [from, to, text, corner]. */
export function labelsAfter86() {
  const out = BEATS.map((b, i) => [Bt(i), Math.min(127.6, Bt(i + 1)), b.label, "left"]);
  out.push([131.2, 141.8, APP, "right"]);
  out.push([150.5, 158.9, ILLUSTRATION, "left"]);
  return out;
}

export function brandPlan(t) {
  return [wordmark(t), flow(t), proof(t), endCard(t)].flat().filter(Boolean);
}
