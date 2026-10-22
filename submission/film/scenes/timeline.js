// The edit: which shots are on screen at time t, and everything they need. 1920x1080, 30 fps, 160 s.
import { ramp, clamp, smooth, inOutSine, inOutCubic, outCubic, inCubic, lerp } from "./ease.js";
import { superText, label, quote, rollingClock } from "./ui.js";
import { askParams, askScreen, nightPushParams, nightScreen, morningParams, morningScreen } from "./shots/wrist.js";
import { skyNightParams, sunriseParams, panelPlan } from "./shots/night.js";
import { phoneScreen, phoneParams, appUrl, beeScreen, tickParams, PW, PH } from "./shots/phone.js";
import { drawMan, MAN_W, MAN_H } from "./shots/silhouette.js";
import { brandPlan, labelsAfter86 } from "./shots/brand.js";
import { SW, SH } from "./watchui.js";
import { shieldMotif } from "./shots/motifs.js";

export const FILM_LENGTH = 160;

export const LABEL_ILLUSTRATION = "Illustration";
export const LABEL_BUILD = "Real build, started by hand on Oct 21 at 10:22 p.m., sped up";
export const LABEL_APP = "Real app, in an illustrated phone";
const LABEL_TYPED = "Idea typed in for this film; the build and the app are real.";
const LABEL_MORNING = "The morning to-do's exact words. For this film's build, nothing was sent to the wrist.";

/** Weight of a layer that fades in over [a, a+fi] and out over [b-fo, b]. */
export const span = (t, a, b, fi, fo) => Math.min(fi > 0 ? smooth((t - a) / fi) : t >= a ? 1 : 0, fo > 0 ? 1 - smooth((t - (b - fo)) / fo) : t < b ? 1 : 0);

/**
 * Puts the shots on screen at one moment together. Where two shots overlap (a dissolve), their looks
 * (exposure, depth of field, bloom ...) blend by how much of each is on screen, so nothing jumps.
 */
export function merge(plans) {
  const out = { layers: [], canvases: {}, needs: [], uis: [], look: {} };
  const looks = [];
  for (const p of plans.flat()) {
    if (!p) continue;
    out.layers.push(...(p.layers || []));
    Object.assign(out.canvases, p.canvases || {});
    out.needs.push(...(p.needs || []));
    if (p.ui) out.uis.push(p.ui);
    if (p.look) {
      const w = p.lookWeight ?? Math.max(0.0001, ...(p.layers || []).map((l) => l.weight || 0), p.layers && p.layers.length ? 0 : 1);
      looks.push([p.look, w]);
    }
  }
  const keys = new Set(looks.flatMap(([l]) => Object.keys(l)));
  for (const k of keys) {
    let tot = 0, acc = null;
    for (const [l, w] of looks) {
      if (!(k in l)) continue;
      const v = l[k];
      if (Array.isArray(v)) acc = (acc || v.map(() => 0)).map((a, i) => a + v[i] * w);
      else acc = (acc || 0) + v * w;
      tot += w;
    }
    out.look[k] = Array.isArray(acc) ? acc.map((a) => a / tot) : acc / tot;
  }
  out.ui = (g, io) => out.uis.forEach((f) => f(g, io));
  return out;
}

// ---- 0 to 3.4: black, grain, a slow light leak, the first line.
function opening(t) {
  if (t >= 3.6) return null;
  return {
    layers: [{
      world: "atmos", weight: 1 - ramp(t, 2.8, 3.6), params: (ts) => ({
        uGlowPos: [0.86 - ts * 0.03, 0.72],
        uGlowCol: [0.045, 0.02, 0.008],
        uGlowCol2: [0.004, 0.003, 0.004],
        uGlowAmt: smooth(ts / 2.2),
        uGlowSize: 0.55,
        uNebula: 0,
        uMotes: 0.9 * smooth(ts / 1.2),
        uCamX: ts * 0.02,
        uFloorLine: 0,
        uBase: [0.0008, 0.0008, 0.0012],
      }),
    }],
    look: { leak: 0.2 * smooth(t / 2.0), leakPos: [1.18 - t * 0.06, 0.78], leakColor: [1.0, 0.42, 0.16], grain: 0.05, exposure: 1 },
    ui: (g) => superText(g, "Every day, ideas are said out loud.", { t, inAt: 0.35, outAt: 3.05, size: 60, weight: 500, y: 560, tracking: -0.02, stagger: 0.1 }),
  };
}

// ---- 2.6 to 7.9: the man, in profile, rim-lit. The camera pushes toward his wrist.
function man(t) {
  if (t < 2.6 || t > 7.7) return null;
  // A slow drift, then the push into the watch (it lands where the next shot has the watch).
  const zoom = 1 + 0.1 * inOutSine(clamp((t - 2.6) / 3.0)) + 2.7 * inOutCubic(clamp((t - 5.0) / 2.8));
  const aim = inOutSine(clamp((t - 5.0) / 2.0));
  return {
    layers: [{ world: "plate", weight: span(t, 2.6, 7.65, 1.0, 0.8), still: true, params: () => ({ uPlate: "man", uGain: 1.0, uCoc: 22 * inCubic(clamp((t - 6.0) / 1.4)) }) }],
    canvases: { man: { w: MAN_W, h: MAN_H, mip: false, draw: (g) => drawMan(g, { t, zoom, aim, light: ramp(t, 2.6, 3.8) }) } },
    look: { leak: 0.14 * (1 - ramp(t, 2.6, 5.0)), leakPos: [1.02, 0.72], leakColor: [1.0, 0.42, 0.16], maxCoc: 20, bloom: 0.5, threshold: 0.75, streak: 0.12, vignette: 0.7, grain: 0.045 },
  };
}

// ---- 6.8 to 19.8: the wrist; the screen wakes, the ask arrives (13.5).
function ask(t) {
  if (t < 6.8 || t > 19.8) return null;
  return {
    layers: [{ world: "wrist", weight: span(t, 6.75, 19.8, 0.85, 0), params: (ts) => askParams(ts) }],
    canvases: { watch: { w: SW, h: SH, draw: askScreen(t) } },
    look: { exposure: 1, maxCoc: 26, bloom: 0.55, threshold: 1.7, streak: 0.22, vignette: 0.7, grain: 0.04 },
  };
}

// ---- 19.8 to 26: the to-do in the Bee app on the phone, ticked. "One tap."
function tick(t) {
  if (t < 19.8 || t >= 26.0) return null;
  return {
    layers: [{ world: "phone", weight: span(t, 19.8, 26.0, 0, 0.1), params: (ts) => tickParams(ts) }],
    canvases: { bee: { w: PW, h: PH, draw: beeScreen(t) } },
    look: { exposure: 1.0 * smooth((t - 19.8) / 0.25 + 0.4), maxCoc: 22, bloom: 0.5, threshold: 1.4, streak: 0.18, vignette: 0.7, grain: 0.04 },
    ui: (g) => {
      superText(g, "Approved.", { t, inAt: 21.35, outAt: 25.7, size: 40, weight: 600, x: 200, y: 468, align: "left", tracking: -0.01, color: "79,211,154", stagger: 0.02 });
      superText(g, "One tap.", { t, inAt: 21.7, outAt: 25.7, size: 112, weight: 700, x: 194, y: 590, align: "left", tracking: -0.035 });
    },
  };
}

// ---- 26 to 28.3: night has fallen; the camera dives into the watch's 12:59.
function nightPush(t) {
  if (t < 26.0 || t > 28.3) return null;
  return {
    layers: [{ world: "wrist", weight: span(t, 26.0, 28.3, 0, 0.7), params: (ts) => nightPushParams(ts) }],
    canvases: { watch: { w: SW, h: SH, draw: nightScreen(t) } },
    look: { exposure: (0.35 + 0.65 * smooth((t - 26.0) / 0.5)) * (1 + 1.4 * ramp(t, 27.2, 28.1)), maxCoc: 26, bloom: 0.7 + 0.6 * ramp(t, 27.0, 28.0), threshold: 1.5, streak: 0.22, vignette: 0.7, grain: 0.04 },
  };
}

// ---- 27.3 to 34.2: the night sky; the time turns to 1:00 A.M. "While you sleep,"
function sky(t) {
  if (t < 27.3 || t > 34.4) return null;
  return {
    layers: [{ world: "sky", weight: span(t, 27.3, 34.4, 0.9, 0.5), params: (ts) => skyNightParams(ts) }],
    look: { exposure: 1.0 + 1.8 * ramp(t, 33.5, 34.2, inCubic), maxCoc: 0, bloom: 0.7, streak: 0.35, vignette: 0.6 },
    ui: (g) => {
      // The clock arrives large (the watch's 12:59, past the lens), settles, and rolls to 1:00.
      const a = ramp(t, 27.55, 27.95) * (1 - ramp(t, 30.3, 30.9));
      const size = 250 + 420 * (1 - outCubic(clamp((t - 27.5) / 1.5)));
      rollingClock(g, "12:59", "1:00", ramp(t, 28.9, 29.7, (x) => x), { y: 540 + size * 0.24, size, weight: 200, alpha: a, suffix: "A.M." });
    },
  };
}

// "While you sleep," carries across the cut into the build: "While you sleep, / Kiro Crew builds it."
function whileYouSleep(t) {
  if (t < 30.7 || t > 38.8) return null;
  return {
    ui: (g) => {
      superText(g, "While you sleep,", { t, inAt: 30.8, outAt: 38.6, size: 72, weight: 700, x: 150, y: 516, align: "left", tracking: -0.035, color: "214,220,245" });
      superText(g, "Kiro Crew", { t, inAt: 34.45, outAt: 38.6, size: 72, weight: 700, x: 150, y: 604, align: "left", tracking: -0.035, color: "190,200,255" });
      superText(g, "builds it.", { t, inAt: 34.7, outAt: 38.6, size: 72, weight: 700, x: 150, y: 684, align: "left", tracking: -0.035, color: "190,200,255" });
    },
  };
}

// ---- 34 to 58.4: the real build on a hero panel; the sandbox; the close-ups; the rail lighting up.
function panel(t) {
  if (t < 34.0 || t > 58.5) return null;
  const pp = panelPlan(t);
  const insert = pp.name.startsWith("insert");
  return {
    layers: [{ world: "panel", weight: span(t, 34.0, 58.5, 0, 0.9), params: (ts) => panelPlan(Math.max(34, Math.min(58.5, ts)), t).params }],
    canvases: { dash: { ...pp.canvas, mip: true } },
    needs: pp.needs,
    look: {
      exposure: 1.0 + 2.2 * Math.exp(-(t - 34) * 6) + 1.2 * ramp(t, 57.3, 58.3, inCubic),
      maxCoc: insert ? 24 : 16,
      bloom: 0.32,
      threshold: 1.25,
      streak: 0.07,
      vignette: insert ? 0.8 : 0.7,
    },
    ui: (g) => {
      shieldMotif(g, t, 38.9, 45.7);
    },
  };
}

// ---- 58 to 64.4: sunrise; the time turns to 7:00 A.M.
function sunrise(t) {
  if (t < 57.8 || t > 64.5) return null;
  return {
    layers: [{ world: "sky", weight: span(t, 57.8, 64.5, 0.9, 0.9), params: (ts) => sunriseParams(ts) }],
    look: {
      exposure: 1.0,
      bloom: 0.8,
      streak: 0.45,
      streakTint: [1.0, 0.7, 0.45],
      vignette: 0.55,
      leak: 0.55 * Math.sin(Math.PI * clamp((t - 57.9) / 2.4)),
      leakPos: [lerp(-0.3, 1.4, clamp((t - 57.9) / 2.4)), 0.55],
      leakColor: [1.0, 0.55, 0.2],
    },
    ui: (g) => {
      const a = ramp(t, 60.2, 60.8) * (1 - ramp(t, 63.4, 64.1));
      rollingClock(g, "6:59", "7:00", ramp(t, 61.0, 61.8, (x) => x), { y: 400, size: 250, weight: 200, alpha: a, suffix: "A.M." });
    },
  };
}

// ---- 63.6 to 72: back on the wrist, the link arrives at 65; the camera dives toward it.
function morning(t) {
  if (t < 63.6 || t >= 72.0) return null;
  const url = appUrl();
  return {
    layers: [{ world: "wrist", weight: span(t, 63.6, 72.0, 0.8, 0), params: (ts) => morningParams(ts) }],
    canvases: { watch: { w: SW, h: SH, draw: morningScreen(t, url) } },
    look: { exposure: 1.0 + 1.6 * ramp(t, 71.0, 72.0, inCubic), maxCoc: 26, bloom: 0.62 + 0.5 * ramp(t, 70.8, 72.0), threshold: 1.7, streak: 0.4, streakTint: [1.0, 0.75, 0.5], vignette: 0.65, grade: [1.04, 1.0, 0.96] },
  };
}

// ---- 72 to 86: the real app on a phone, lit like a product. "It's live."
function live(t) {
  if (t < 72.0 || t > 86.05) return null;
  const s = Math.max(0, t - 72.0) + 0.3;
  const scr = phoneScreen("app", s, "Game Night Scores");
  return {
    layers: [{ world: "phone", weight: span(t, 72.0, 86.05, 0, 0.75), params: (ts) => phoneParams(ts, { start: 72, end: 86 }) }],
    canvases: { phone: { w: PW, h: PH, draw: scr.draw } },
    needs: scr.needs,
    look: { exposure: 1.0 + 1.4 * Math.exp(-(t - 72) * 4.5), maxCoc: 14, bloom: 0.55, threshold: 1.1, streak: 0.2, vignette: 0.7 },
    ui: (g) => {
      superText(g, "It's live.", { t, inAt: 72.9, outAt: 85.6, size: 124, weight: 700, x: 170, y: 560, align: "left", tracking: -0.035 });
      superText(g, appUrl().replace("https://", ""), { t, inAt: 73.9, outAt: 85.6, size: 30, weight: 500, x: 174, y: 632, align: "left", tracking: 0, color: "170,185,255", stagger: 0.02, rise: 8 });
    },
  };
}

/** The honesty labels: [from, to, text, corner]. Each comes in with its shot and goes with it. */
const LABELS = [
  [2.6, 34.0, LABEL_ILLUSTRATION, "left"],
  [10.0, 26.0, LABEL_TYPED, "right"],
  [34.0, 58.3, LABEL_BUILD, "left"],
  [58.3, 72.0, LABEL_ILLUSTRATION, "left"],
  [64.4, 72.0, LABEL_MORNING, "right"],
  [72.0, 86.0, LABEL_APP, "left"],
];

function labels(t) {
  return {
    ui: (g) => {
      for (const [a, b, s, corner] of [...LABELS, ...labelsAfter86()]) {
        if (t < a || t >= b) continue;
        const fadeIn = a < 3 ? ramp(t, a, a + 0.8) : a === 10.0 || a === 64.4 ? ramp(t, a, a + 0.4) : 1;
        label(g, s, Math.min(fadeIn, 1 - ramp(t, b - 0.12, b)), { corner });
      }
    },
  };
}

export function planAt(t) {
  const plans = [opening(t), man(t), ask(t), tick(t), nightPush(t), sky(t), whileYouSleep(t), panel(t), sunrise(t), morning(t), live(t), brandPlan(t), labels(t)];
  const p = merge(plans);
  // The spoken line belongs to the man: it starts while we see him and ends on the wrist.
  const prev = p.ui;
  p.ui = (g, io) => {
    prev(g, io);
    quote(g, "Someone should make an app for that.", t, 4.3, 9.9);
  };
  return p;
}
