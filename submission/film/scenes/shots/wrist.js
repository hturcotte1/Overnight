// The wrist: the ask (6.8 to 19.8), the night push into the watch (26 to 28.3), the morning
// (63.6 to 72), and the wrist shots the brand half reuses (how it works, the end card).
import { flowKeys, ramp, clamp, norm, add, scale, sub, smooth, inOutSine, inOutCubic, outCubic, inCubic, lerp, mix3 } from "../ease.js";
import { drawWatch } from "../watchui.js";

export const CASE_C = [-2.1, 0.86, 0.0];
export const SCREEN_C = [-2.1, 1.38, 0.0];
/** Where the wrapped link sits on the glass of the morning to-do. */
const LINK_ON_GLASS = [-2.1, 1.38, 0.42];

/** A haptic buzz: two short pulses, as a small offset of the watch. */
export function hapticShake(t, at) {
  const out = [0, 0, 0];
  for (const p of [at, at + 0.14]) {
    const k = t - p;
    if (k < 0 || k > 0.35) continue;
    const a = 0.045 * Math.exp(-k * 12) * smooth(k / 0.02);
    out[0] += a * Math.sin(k * 2 * Math.PI * 165);
    out[2] += a * 0.6 * Math.cos(k * 2 * Math.PI * 165 + 0.7);
  }
  return out;
}

/** The ripple on the screen after a buzz (0..1, then 1 when done). */
export function pulseAt(t, at) {
  return clamp((t - at) / 0.9, 0, 1);
}

/** A short brightening of the screen with each buzz. */
export function flareAt(t, at) {
  const k = t - at;
  return k < 0 ? 0 : 0.45 * Math.exp(-k * 5) * smooth(k / 0.04);
}

export const NIGHT_LIGHTS = {
  uRimDir: norm([-0.15, 0.3, -0.94]),
  uRimCol: [0.62, 0.76, 1.0].map((x) => x * 3.6),
  uKeyDir: norm([-0.75, 0.25, 0.62]),
  uKeyCol: [1.0, 0.62, 0.4].map((x) => x * 0.16),
  uAmb: [0.0025, 0.0035, 0.007],
  uBg: [0.0035, 0.0045, 0.009],
  uHazeCol: [0.32, 0.42, 0.7],
  uHaze: 0.9,
  uBokeh: 0.4,
  uDust: 1,
  uWarm: 0,
  uPoolKey: 9,
  uPoolRim: 16,
  uShadowK: 7,
  uScreenGain: 1.9,
  uHandFade: 1,
};

// The morning: a low warm sun from behind and to the right as a wide light (soft shadows), and a warm
// fill from the camera's side, so the band's shadow falls behind the wrist, out of shot.
export const MORNING_LIGHTS = {
  uRimDir: norm([0.55, 0.55, -0.62]),
  uRimCol: [1.0, 0.72, 0.42].map((x) => x * 3.2),
  uKeyDir: norm([0.28, 0.72, 0.64]),
  uKeyCol: [1.0, 0.7, 0.45].map((x) => x * 0.75),
  uAmb: [0.035, 0.026, 0.022],
  uBg: [0.03, 0.016, 0.01],
  uHazeCol: [1.0, 0.62, 0.32],
  uHaze: 1.2,
  uBokeh: 0.9,
  uDust: 1.2,
  uWarm: 1,
  uPoolKey: 30,
  uPoolRim: 40,
  uShadowK: 2.4,
  uScreenGain: 1.9,
  uHandFade: 1,
};

const NO_FINGER = { uFingerOn: 0, uFingerTip: [0, 0, 0], uFingerDir: [1, 0, 0], uFingerBend: [0, 1, 0], uFingerUp: [0, 1, 0] };

function camFrom(target, dir, dist) {
  return add(target, scale(norm(dir), dist));
}

/** The ask: one continuous move from the first sight of the wrist (6.8) to close on the watch (19.8). */
export function askCamera(t) {
  const k = [
    [6.8, [0.4, -0.6, 0.0], [0.24, 0.44, 0.86], 42],
    [12.0, [-1.2, 0.3, 0.2], [0.18, 0.6, 0.78], 30],
    [19.8, [-2.25, 1.2, 0.35], [0.1, 0.8, 0.59], 17.0],
  ];
  const te = Math.max(6.8, t);
  const tgt = flowKeys(te, k.map((x) => [x[0], x[1]]));
  const dir = flowKeys(te, k.map((x) => [x[0], x[2]]));
  const dist = flowKeys(te, k.map((x) => [x[0], x[3]]));
  // A slow sideways dolly while the line is spoken, a drift, and the arm's breathing.
  const dolly = 3.2 * (1 - inOutSine(clamp((t - 6.0) / 7.5)));
  const drift = [Math.sin(t * 0.21) * 0.25 + dolly, Math.sin(t * 0.17 + 1) * 0.15 + Math.sin(t * 1.55) * 0.09, dolly * 0.3];
  const pos = add(camFrom(tgt, dir, dist), drift);
  const tg = add(tgt, [dolly * 0.55, Math.sin(t * 1.55) * 0.07, 0]);
  return { pos, tgt: tg };
}

function base(L, cam, extra) {
  return {
    ...L,
    ...NO_FINGER,
    uCamPos: cam.pos,
    uCamTgt: cam.tgt,
    uFov: 26,
    uRoll: 0,
    uFocus: Math.hypot(...sub(cam.pos, SCREEN_C)),
    uAperture: 18,
    uScreen: "watch",
    uScreenOn: 1,
    uScreenGlow: [0.32, 0.33, 0.38],
    uShake: [0, 0, 0],
    uGlassScreen: 1,
    ...extra,
  };
}

export function askParams(t) {
  const cam = askCamera(t);
  const wake = ramp(t, 12.2, 12.9);
  return base(NIGHT_LIGHTS, cam, {
    uAperture: lerp(9, 30, ramp(t, 8, 19)),
    uScreenOn: lerp(0.05, 1.0, wake) + flareAt(t, 13.5),
    uShake: hapticShake(t, 13.5),
  });
}

export function askScreen(t) {
  return (g) =>
    drawWatch(g, {
      mode: "ask",
      time: "12:41",
      title: "Game Night Scores",
      cardIn: ramp(t, 13.5, 14.3, (x) => x),
      pulse: pulseAt(t, 13.5),
    });
}

/** 26.0 to 28.3: night has fallen; the camera dives into the watch's 12:59. */
export function nightPushParams(t) {
  const k = inCubic(clamp((t - 26.0) / 1.9));
  const tgt = [lerp(-2.25, -2.1, k), lerp(1.3, 1.38, k), lerp(0.3, 0.05, k)];
  const dir = norm([lerp(0.06, 0.0, k), lerp(0.86, 0.97, k), lerp(0.5, 0.24, k)]);
  const dist = lerp(15.5, 3.0, k);
  const pos = add(camFrom(tgt, dir, dist), [Math.sin(t * 0.21) * 0.1, 0, 0]);
  const L = { ...NIGHT_LIGHTS, uRimCol: [0.25, 0.35, 0.9].map((x) => x * 1.6), uKeyCol: [0, 0, 0] };
  return base(L, { pos, tgt }, {
    uAperture: 26,
    uScreenGlow: [0.12, 0.2, 0.55],
    uScreenOn: 1.0,
  });
}

export function nightScreen(t) {
  return (g) =>
    drawWatch(g, {
      mode: "night",
      night: 1,
      nightTime: 1 - ramp(t, 27.3, 27.6),
      nightClock: "12:59",
      stars: t,
    });
}

/** The morning, 63.6 to 72.0: the link arrives at 65.0; from 70.2 the camera dives toward the link. */
export function morningParams(t) {
  const k = clamp((t - 63.6) / 6.6);
  const dive = inCubic(clamp((t - 70.2) / 1.8));
  let tgt = add(SCREEN_C, [lerp(0.5, 0.0, inOutSine(k)), -0.1, lerp(0.4, 0.15, k)]);
  tgt = tgt.map((v, i) => lerp(v, LINK_ON_GLASS[i], dive));
  const dir = norm([lerp(0.22, 0.1, inOutSine(k)), lerp(0.82, 0.9, inOutSine(k)), lerp(0.52, 0.42, k)]);
  const dist = lerp(21, 12.5, inOutSine(k)) * (1 - dive) + 2.6 * dive;
  const pos = add(add(tgt, scale(dir, dist)), [Math.sin(t * 0.3) * 0.15 * (1 - dive), 0, 0]);
  const wake = ramp(t, 64.6, 65.0);
  return base(MORNING_LIGHTS, { pos, tgt }, {
    uRoll: -0.03,
    uAperture: 26,
    uScreenOn: lerp(0.25, 1.0, wake) + flareAt(t, 65.0) + 1.4 * ramp(t, 71.0, 72.0, inCubic),
    uScreenGlow: [0.45, 0.38, 0.32],
    uShake: hapticShake(t, 65.0),
  });
}

export function morningScreen(t, url) {
  return (g) =>
    drawWatch(g, {
      mode: "morning",
      time: "7:00",
      title: "Game Night Scores",
      url,
      cardIn: ramp(t, 65.0, 65.8, (x) => x),
      pulse: pulseAt(t, 65.0),
    });
}

// ---- How it works: the wrist hears (beat 1), asks (beat 3), and gets the link (beat 6).

/** Beat 1: a slow sideways move across the watch while it listens; t0 is the beat's start. */
export function hearParams(t, t0) {
  const u = clamp((t - t0) / 5.6);
  const tgt = [lerp(-1.4, -2.3, u), 1.1, 0.1];
  const dir = norm([lerp(-0.42, -0.12, inOutSine(u)), 0.62, lerp(0.66, 0.78, u)]);
  const pos = camFrom(tgt, dir, lerp(24, 21, u));
  return base(NIGHT_LIGHTS, { pos, tgt }, { uAperture: 24, uScreenOn: 1, uScreenGlow: [0.3, 0.28, 0.22] });
}
export function hearScreen(t, t0) {
  return (g) => drawWatch(g, { mode: "listen", time: "12:40", level: t - t0 });
}

/** Beat 3: low, from the hand's side, looking back at the ask; the wrist buzzes on the beat. */
export function askBeatParams(t, t0) {
  const u = clamp((t - t0) / 5.6);
  const tgt = [lerp(-1.8, -2.2, u), 1.2, 0.25];
  const dir = norm([lerp(0.34, 0.22, inOutSine(u)), 0.78, lerp(0.5, 0.6, u)]);
  const pos = camFrom(tgt, dir, lerp(18.5, 15.5, inOutSine(u)));
  return base(NIGHT_LIGHTS, { pos, tgt }, {
    uAperture: 26,
    uScreenOn: 1 + flareAt(t, t0 + 0.05),
    uShake: hapticShake(t, t0 + 0.05),
  });
}
export function askBeatScreen(t, t0) {
  return (g) => drawWatch(g, { mode: "ask", time: "12:41", title: "Game Night Scores", cardIn: ramp(t, t0 - 0.2, t0 + 0.5, (x) => x), pulse: pulseAt(t, t0 + 0.05) });
}

/** Beat 6: the morning link, from the other side, easing back. */
export function morningBeatParams(t, t0) {
  const u = clamp((t - t0) / 5.6);
  const tgt = [lerp(-4.4, -4.0, u), 0.9, lerp(-0.9, -0.7, u)];
  const dir = norm([lerp(-0.3, -0.2, u), 0.8, lerp(0.5, 0.56, u)]);
  const pos = camFrom(tgt, dir, lerp(17, 20, inOutSine(u)));
  return base(MORNING_LIGHTS, { pos, tgt }, { uAperture: 24, uScreenOn: 1 + flareAt(t, t0 + 0.05), uShake: hapticShake(t, t0 + 0.05), uScreenGlow: [0.45, 0.38, 0.32] });
}
export function morningBeatScreen(t, t0, url) {
  return (g) => drawWatch(g, { mode: "morning", time: "7:00", title: "Game Night Scores", url, cardIn: ramp(t, t0 - 0.3, t0 + 0.4, (x) => x), pulse: pulseAt(t, t0 + 0.05) });
}

/** The end card: breakfast light on the wrist, far out of focus behind the wordmark, pulling back. */
export function endParams(t) {
  const u = clamp((t - 150.0) / 10);
  const tgt = [lerp(-1.6, -1.0, u), 0.9, 0.2];
  const dir = norm([0.2, 0.7, 0.69]);
  const pos = camFrom(tgt, dir, lerp(20, 27, outCubic(u)));
  const L = { ...MORNING_LIGHTS, uRimCol: MORNING_LIGHTS.uRimCol.map((x) => x * 1.15), uBokeh: 1.4 };
  return base(L, { pos, tgt }, {
    uFocus: 160,
    uAperture: 30,
    uScreenOn: 0.9,
    uScreenGlow: [0.45, 0.38, 0.32],
  });
}
export function endScreen(t, url) {
  return (g) => drawWatch(g, { mode: "morning", time: "7:00", title: "Game Night Scores", url, cardIn: 1 });
}
