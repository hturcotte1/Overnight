// 27 to 64: the night sky, the real build on a hero panel, the sunrise.
import { flowKeys, ramp, clamp, norm, add, scale, sub, smooth, inOutSine, inOutCubic, outCubic, inCubic, lerp } from "../ease.js";
import { frames, captureMeta } from "../capture.js";
import { rotate } from "./phone.js";
import { DASH_LAYOUT } from "../data/dash-layout.js";

// ---- The night sky.

/** 27.3 to 34.2: looking up at the stars, drifting down toward the horizon. */
export function skyNightParams(t) {
  return {
    uPitch: lerp(38, 9, inOutSine(clamp((t - 27.2) / 6.8))),
    uYaw: -8 + (t - 27) * 1.3,
    uFov: lerp(50, 44, inOutSine(clamp((t - 27.2) / 6.8))),
    uRoll: 0.02,
    uSunElev: -30,
    uSunAz: 70,
    uDawn: 0,
    uStars: 1.0,
    uCloud: 0.12,
    uRays: 0,
    uExposureSky: 1.0,
  };
}

/** 58 to 64.4: the sun comes up over the ridge. */
export function sunriseParams(t) {
  const k = clamp((t - 58.0) / 6.2);
  return {
    uPitch: lerp(13, 10, inOutSine(k)),
    uYaw: lerp(52, 60, inOutSine(k)),
    uFov: 46,
    uRoll: 0,
    uSunElev: lerp(-4.5, 3.2, inOutSine(k)),
    uSunAz: 64,
    uDawn: smooth(clamp((t - 58.0) / 3.6)),
    uStars: 1.0 - smooth(clamp((t - 58) / 2)),
    uCloud: 0.55,
    uRays: smooth(clamp((t - 59.5) / 3)),
    uExposureSky: lerp(0.5, 0.8, smooth(k)),
  };
}

// ---- The real build.
//
// The film shows only the hero card of the idea's own page (no header: no clock, no listening chip).
// The crop is 1106 px wide from x 407; it starts at y 54 and ends 12 px under the card, whose height
// changes when the app goes live (the "Open the app" button). The panel takes the crop's shape.

export const CROP_X = 407, CROP_W = 1106, CROP_Y = 54, CROP_MAX_H = 556;
export const DASH_W = CROP_W, DASH_H = CROP_MAX_H;
const CM = 62 / CROP_W;     // centimetres per page pixel on the panel
const DISP_X = 31.0;
const TOP = 39.0;           // world height of the display's top edge

function cropHeightOf(i) {
  const L = DASH_LAYOUT[Math.max(0, Math.min(DASH_LAYOUT.length - 1, i - 1))];
  // Frames before the chips appeared are given the usual height (the card grows in its first second).
  const bottom = Math.max(502, L ? L.bottom : 502);
  return Math.min(CROP_MAX_H, bottom + 12 - CROP_Y);
}

/** Film time to captured frame number (1-based, fractional). Anchors are the build's own moments. */
const CLOCK = [
  [34.0, 12],     // building, the first chip
  [34.9, 17],     // sandbox check passed
  [38.4, 39],     // agent started, project written
  [46.3, 105],    // packages installed
  [46.9, 111],    // app built
  [48.95, 137],   // notes written
  [50.05, 149.6], // built
  [50.8, 154],    // checked, pushed
  [53.3, 180],    // live
  [54.35, 183.6], // delivered: the page shows the link
  [58.2, 193],
];
export function frameAt(t) {
  if (t <= CLOCK[0][0]) return CLOCK[0][1];
  for (let i = 0; i < CLOCK.length - 1; i++) {
    const [t0, f0] = CLOCK[i], [t1, f1] = CLOCK[i + 1];
    if (t <= t1) return f0 + (f1 - f0) * (t - t0) / (t1 - t0);
  }
  return CLOCK[CLOCK.length - 1][1];
}

/** The two captured frames either side of frame f, and the quick dissolve between them (the way a page updates). */
export function footageAt(f) {
  const list = frames("dashboard");
  if (!list.length) return null;
  const x = Math.max(1, Math.min(list.length, f));
  const i = Math.floor(x);
  const k = smooth((x - i - 0.75) / 0.25);
  const ia = i, ib = Math.min(list.length, i + 1);
  return { a: list[ia - 1], b: list[ib - 1], k, ha: cropHeightOf(ia), hb: cropHeightOf(ib) };
}

/** Draws the crop of the footage onto the panel's canvas (DASH_W x DASH_H). */
export function dashCanvas(f) {
  const fa = footageAt(f);
  return {
    needs: fa ? [fa.a, fa.b] : [],
    h: fa ? lerp(fa.ha, fa.hb, fa.k) : 460,
    draw: (g, io) => {
      if (!fa) {
        g.fillStyle = "#f3f2ee";
        g.fillRect(0, 0, DASH_W, DASH_H);
        return;
      }
      const A = io.image(fa.a), B = io.image(fa.b);
      if (A && A.naturalWidth) g.drawImage(A, 60, 700, 1, 1, 0, 0, DASH_W, DASH_H); // the page's own background colour
      const one = (img, h, alpha) => {
        if (!img || !img.naturalWidth || alpha <= 0) return;
        g.save();
        g.globalAlpha = alpha;
        g.beginPath();
        g.rect(0, 0, DASH_W, h);
        g.clip();
        g.drawImage(img, CROP_X, CROP_Y, CROP_W, h, 0, 0, CROP_W, h);
        g.restore();
      };
      one(A, fa.ha, 1);
      one(B, fa.hb, fa.k);
    },
  };
}

/** The panel's size for a crop height h (page pixels). */
export function panelShape(h) {
  const dy = (h * CM) / 2;
  return { disp: [DISP_X, dy], half: [DISP_X + 1.0, dy + 1.0, 0.6], pos: [0, TOP - dy, 0], crop: [0, 1 - h / DASH_H, 1, 1] };
}

/** Where page pixel (px, py) of the footage is in the world, for a panel of crop height h and rotation rot. */
export function pagePoint(px, py, h, rot) {
  const sh = panelShape(h);
  const local = [(px - CROP_X) * CM - DISP_X, sh.disp[1] - (py - CROP_Y) * CM, 0.6];
  return add(sh.pos, rotate(local, rot));
}

/**
 * The camera over the panel, as keyframes: [time, page x, page y, view direction in the panel's own
 * frame, distance, a screen-space shift of the aim (cm, panel x/y), aperture]. The aim shift puts the
 * panel to the right of the frame for the supers on the left.
 */
const SHOTS = {
  hero: [
    [34.0, 960, 300, [-0.36, 0.12, 0.93], 104, [-20, 1], 10],
    [38.7, 960, 300, [-0.28, 0.1, 0.95], 93, [-19, 1], 10],
  ],
  sandbox: [
    [38.7, 960, 300, [-0.3, 0.1, 0.95], 99, [-21, 1], 10],
    [46.0, 960, 300, [-0.14, 0.08, 0.99], 88, [-19.5, 1], 10],
  ],
  insert1: [
    [46.0, 560, 463, [0.62, 0.1, 0.78], 50, [0, 0], 30],
    [47.33, 600, 458, [0.5, 0.1, 0.86], 46, [0, 0], 30],
  ],
  insert2: [
    [47.33, 1040, 421, [-0.6, 0.18, 0.78], 48, [0, 0], 30],
    [48.67, 1010, 425, [-0.52, 0.14, 0.84], 44, [0, 0], 30],
  ],
  insert3: [
    [48.67, 760, 455, [0.5, -0.12, 0.86], 50, [0, 0], 30],
    [50.0, 800, 445, [0.42, -0.1, 0.9], 46, [0, 0], 30],
  ],
  rail: [
    [50.0, 820, 300, [-0.2, 0.06, 0.98], 64, [0, 0], 12],
    [52.2, 960, 300, [-0.12, 0.05, 0.99], 61, [0, 0], 12],
    [54.3, 1090, 320, [-0.02, 0.04, 1.0], 58, [0, 0], 12],
    [56.1, 960, 292, [0.1, 0.05, 0.99], 52, [0, 0], 14],
    [58.2, 770, 262, [0.18, 0.04, 0.98], 44, [0, 0], 16],
  ],
};

function shotAt(t) {
  if (t < 38.7) return "hero";
  if (t < 46.0) return "sandbox";
  if (t < 47.33) return "insert1";
  if (t < 48.67) return "insert2";
  if (t < 50.0) return "insert3";
  return "rail";
}

/**
 * 34 to 58.4: the real dashboard on a floating panel. shotT is the frame's own time: the shot (and so the
 * cut) is chosen by it, so a frame's motion-blur samples never mix the shots either side of a cut.
 */
export function panelPlan(t, shotT = t) {
  const f = frameAt(t);
  const dash = dashCanvas(f);
  const shape = panelShape(dash.h);
  const name = shotAt(shotT);
  const ks = SHOTS[name];
  const k = (i) => flowKeys(t, ks.map((x) => [x[0], x[i]]));
  const px = k(1), py = k(2), vdir = norm(k(3)), dist = k(4), shift = k(5), ap = k(6);
  // The panel turns a little over the whole sequence, so even the held shots move.
  const yaw = name === "hero" ? lerp(-0.36, -0.3, clamp((t - 34) / 4.7)) : name === "sandbox" ? lerp(-0.3, -0.18, inOutSine(clamp((t - 38.7) / 7.3))) : -0.08 + 0.02 * Math.sin(t * 0.4);
  const rot = [yaw, 0.02, 0];
  const aimPage = pagePoint(px, py, dash.h, rot);
  const aim = add(aimPage, rotate([shift[0], shift[1], 0], rot));
  const pos = add(aim, scale(rotate(vdir, rot), dist));
  // The arrival at 34: from the light of the night, a settle from further back.
  const arrive = 1 - outCubic(clamp((t - 34) / 1.8));
  const camPos = add(pos, rotate([0, -3 * arrive, 34 * arrive], rot));
  const focusD = Math.hypot(...sub(camPos, aimPage));
  // The sandbox boundary forms from 38.9 (a scan line rising), holds, and goes at 45.6.
  const sweep = lerp(-2, 2 * (shape.half[1] + 2.2) + 4, inOutSine(clamp((t - 38.9) / 1.8)));
  const shell = ramp(t, 38.8, 39.4) * (1 - ramp(t, 45.3, 46.0));
  return {
    needs: dash.needs,
    canvas: { w: DASH_W, h: DASH_H, draw: dash.draw },
    name,
    params: {
      uCamPos: camPos,
      uCamTgt: aim,
      uFov: 32,
      uRoll: 0,
      uFocus: focusD,
      uAperture: ap,
      uScreen: "dash",
      uScreenB: "dash",
      uScreenMix: 0,
      uWipe: -2,
      uScreenOn: 1,
      uScreenGain: 1.0,
      uCrop: shape.crop,
      uScreenAvg: [0.8, 0.79, 0.76],
      uRot: rot,
      uPos: shape.pos,
      uHalfP: shape.half,
      uDispP: shape.disp,
      uRimDir: norm([-0.3, 0.6, -0.75]),
      uRimCol: [0.5, 0.6, 1.0].map((x) => x * 0.9),
      uKeyDir: norm([0.8, 0.4, 0.5]),
      uKeyCol: [0.3, 0.35, 0.55],
      uBg: [0.0025, 0.003, 0.008],
      uGlowCol: [0.36, 0.5, 1.0],
      uGlow: 1.2,
      uShell: shell,
      uShellSweep: sweep,
      uShellPad: [1.5, 1.5, 0.9],
      uFloorRefl: 0.75,
      uDust: 1,
      uMoon: 0,
      uLidAngle: 0,
      uStripCol: [0, 0, 0],
      uBackCol: [0.02, 0.025, 0.06],
      uBackSize: 0.6,
      uSheen: 0.6,
      uSheenPos: lerp(-0.4, 1.6, clamp((t - 34.4) / 3.5)),
      uFingerOn: 0,
      uFingerTip: [0, 0, 0],
      uFingerDir: [1, 0, 0],
      uFingerBend: [0, 1, 0],
    },
  };
}

/** A still of the panel for the how-it-works beats: footage frame f, a camera at page point (px, py). */
export function panelBeat(t, t0, f, { px, py, vdir, dist, shell = 0, drift = [0, 0], shift = [0, 0] }) {
  const dash = dashCanvas(f);
  const shape = panelShape(dash.h);
  const u = clamp((t - t0) / 5.6);
  const rot = [lerp(-0.2, -0.08, inOutSine(u)), 0.02, 0];
  const focusAt = pagePoint(px + drift[0] * u, py + drift[1] * u, dash.h, rot);
  const aimPage = add(focusAt, rotate([shift[0], shift[1], 0], rot));
  const pos = add(aimPage, scale(rotate(norm(vdir), rot), dist * lerp(1.06, 0.96, inOutSine(u))));
  return {
    needs: dash.needs,
    canvas: { w: DASH_W, h: DASH_H, draw: dash.draw },
    params: {
      ...panelPlan(40).params,
      uCamPos: pos,
      uCamTgt: aimPage,
      uFocus: Math.hypot(...sub(pos, focusAt)),
      uAperture: 16,
      uCrop: shape.crop,
      uRot: rot,
      uPos: shape.pos,
      uHalfP: shape.half,
      uDispP: shape.disp,
      uShell: shell,
      uShellSweep: 200,
      uSheenPos: lerp(-0.4, 1.6, u),
    },
  };
}

export function buildSeconds() {
  return captureMeta()?.buildSeconds ?? 140;
}
