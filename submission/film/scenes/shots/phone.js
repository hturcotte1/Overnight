// Phones: the real app on an illustrated phone (72 to 86, the proof, how it works), and the
// illustrated phone on which the to-do is ticked in the Bee app (19.6 to 26).
import { ramp, clamp, norm, add, scale, sub, smooth, inOutSine, inOutCubic, outCubic, inCubic, lerp } from "../ease.js";
import { frames, realtimeAt, captureMeta, placeholderApp, tapsFor } from "../capture.js";
import { font, roundRect, wrap, FONT, ROUNDED } from "../ui.js";

export const PW = 780;
export const PH = 1688;
const DISP = [3.35, 7.25];
const HALF_Z = 0.42;

/** The phone's screen canvas: the app frame for s seconds into the footage, and a ring where a finger tapped. */
export function phoneScreen(folder, s, title) {
  const list = frames(folder);
  const url = realtimeAt(list, s, 30);
  const draw = (g, io) => {
    const img = url && io.image(url);
    if (img && img.naturalWidth) g.drawImage(img, 0, 0, PW, PH);
    else placeholderApp(g, PW, PH, s, title);
    const info = tapsFor(folder);
    const taps = (info && info.taps) || [];
    const vw = (info && info.viewport && info.viewport.width) || 390;
    const k = PW / vw;
    const frame = s * 30;
    for (const tap of taps) {
      const age = (frame - tap.frame) / 30;
      if (age < -0.15 || age > 0.7) continue;
      const press = age < 0 ? 1 - Math.abs(age) / 0.15 : 1;
      const grow = outCubic(clamp(age / 0.55));
      const a = age < 0 ? press * 0.5 : (1 - grow) * 0.85;
      const x = tap.x * k, y = tap.y * k;
      g.save();
      // A fingertip's soft shadow, then a ring of light that runs out from the touch.
      const sh = g.createRadialGradient(x, y, 0, x, y, 46 * k * 0.5);
      sh.addColorStop(0, `rgba(255,255,255,${0.45 * a})`);
      sh.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = sh;
      g.beginPath();
      g.arc(x, y, 46 * k * 0.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = `rgba(255,255,255,${a})`;
      g.lineWidth = 5;
      g.beginPath();
      g.arc(x, y, (14 + 34 * grow) * k * 0.6, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  };
  return { draw, needs: url ? [url] : [] };
}

/** Lighting shared by the hero phone shots: cool strips along the frame, a glow behind, a sheen on the glass. */
export function phoneLook(over = {}) {
  return {
    uStripCol: [0.62, 0.72, 1.0].map((x) => x * 1.9),
    uBackCol: [0.05, 0.065, 0.16],
    uBackSize: 0.34,
    uSheen: 1,
    uSheenPos: -0.5,
    uShellPad: [0, 0, 0],
    uFingerOn: 0,
    uFingerTip: [0, 0, 0],
    uFingerDir: [1, 0, 0],
    uFingerBend: [0, 1, 0],
    ...over,
  };
}

export function phoneParams(t, { start, end, side = 1, hero = 1 }) {
  const k = clamp((t - start) / (end - start));
  const arrive = 1 - outCubic(clamp((t - start) / 1.6));
  const yaw = lerp(-0.4, -0.14, inOutSine(k)) * side - arrive * 0.3 * side;
  const tgt = [lerp(-4.0, -4.6, k) * side, 16.0, 0];
  const dist = lerp(34, 30.5, inOutSine(k)) + arrive * 3;
  const pos = add(tgt, scale(norm([0.0, 0.1, 1.0]), dist));
  return {
    uCamPos: pos,
    uCamTgt: tgt,
    uFov: 30,
    uRoll: 0,
    uFocus: Math.hypot(pos[0], pos[1] - 16, pos[2]),
    uAperture: 10,
    uScreen: "phone",
    uScreenB: "phone",
    uScreenMix: 0,
    uWipe: -2,
    uScreenOn: 1,
    uScreenGain: 1.0,
    uCrop: [0, 0, 1, 1],
    uScreenAvg: [0.25, 0.3, 0.45],
    uRot: [yaw, -0.06, 0.03 * side],
    uPos: [0, 16, 0],
    uRimDir: norm([-0.5 * side, 0.55, -0.67]),
    uRimCol: hero ? [0.55, 0.65, 1.0].map((x) => x * 2.4) : [1.0, 0.8, 0.6].map((x) => x * 2.0),
    uKeyDir: norm([0.8 * side, 0.35, 0.5]),
    uKeyCol: hero ? [1.0, 0.75, 0.5].map((x) => x * 0.7) : [0.6, 0.7, 1.0].map((x) => x * 0.5),
    uBg: [0.0035, 0.004, 0.009],
    uGlowCol: [0.5, 0.6, 1.0],
    uGlow: 1.4,
    uShell: 0,
    uShellSweep: 0,
    uFloorRefl: 0.85,
    uDust: 0,
    uMoon: 0,
    uLidAngle: 0,
    ...phoneLook({ uSheenPos: lerp(-0.6, 1.9, inOutSine(clamp((t - start - 0.3) / 3.2))) }),
  };
}

export function appUrl() {
  return captureMeta()?.publicUrl ?? "https://hturcotte1.github.io/overnight-apps/game-night-scores/";
}

// ---- The tick, 19.6 to 26: the to-do in the Bee app on the phone, ticked with one tap.

const TICK_AT = 21.0;
/** The checkbox on the phone's screen, in canvas pixels. */
const BOX = [118, 520];

/** Our own clean to-do list (not Bee's design): the ask at the top, ticked at 21.0. */
export function beeScreen(t) {
  return (g) => {
    g.fillStyle = "#07080c";
    g.fillRect(0, 0, PW, PH);
    g.save();
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.font = font(34, 600, ROUNDED);
    g.fillText("12:42", 70, 92);
    g.fillStyle = "rgba(255,190,80,1)";
    g.font = font(30, 700, ROUNDED);
    g.letterSpacing = "2px";
    g.fillText("BEE", 60, 250);
    g.letterSpacing = "0px";
    g.fillStyle = "#fff";
    g.font = font(84, 800, FONT);
    g.fillText("To-dos", 56, 340);
    g.restore();
    // The new to-do, arriving at the top of the list.
    const tick = clamp((t - TICK_AT) / 0.55);
    const y0 = 420;
    g.save();
    const card = g.createLinearGradient(0, y0, 0, y0 + 210);
    card.addColorStop(0, "#1c1d24");
    card.addColorStop(1, "#15161c");
    g.fillStyle = card;
    roundRect(g, 36, y0, PW - 72, 210, 40);
    g.fill();
    g.strokeStyle = `rgba(255,190,80,${0.5 * (1 - tick)})`;
    g.lineWidth = 3;
    roundRect(g, 37.5, y0 + 1.5, PW - 75, 207, 39);
    g.stroke();
    // The checkbox.
    const [bx, by] = BOX;
    g.lineWidth = 6;
    g.strokeStyle = tick > 0 ? "rgb(79,211,154)" : "rgba(255,255,255,0.7)";
    g.beginPath();
    g.arc(bx, by, 40, 0, Math.PI * 2);
    g.stroke();
    if (tick > 0) {
      const f = outCubic(clamp(tick * 1.6));
      g.fillStyle = `rgba(79,211,154,${f})`;
      g.beginPath();
      g.arc(bx, by, 40 * (0.55 + 0.45 * f), 0, Math.PI * 2);
      g.fill();
      const c = clamp((tick - 0.25) / 0.6);
      if (c > 0) {
        g.strokeStyle = "#0b1a12";
        g.lineWidth = 8;
        g.lineCap = "round";
        g.lineJoin = "round";
        const p = [[bx - 18, by + 1], [bx - 5, by + 15], [bx + 19, by - 13]];
        const k1 = clamp(c * 2), k2 = clamp(c * 2 - 1);
        g.beginPath();
        g.moveTo(...p[0]);
        g.lineTo(lerp(p[0][0], p[1][0], k1), lerp(p[0][1], p[1][1], k1));
        if (k2 > 0) g.lineTo(lerp(p[1][0], p[2][0], k2), lerp(p[1][1], p[2][1], k2));
        g.stroke();
      }
    }
    const dim = 1 - 0.35 * smooth(tick);
    g.fillStyle = `rgba(255,255,255,${dim})`;
    g.font = font(44, 600, FONT);
    g.letterSpacing = "-0.4px";
    g.fillText("💡 Build tonight?", 196, y0 + 88);
    g.font = font(52, 700, FONT);
    g.letterSpacing = "-0.8px";
    g.fillText("Game Night Scores", 196, y0 + 156);
    g.restore();
    // The rest of the list, out of the way.
    for (let i = 0; i < 4; i++) {
      const y = y0 + 250 + i * 150;
      g.fillStyle = "rgba(255,255,255,0.045)";
      roundRect(g, 36, y, PW - 72, 120, 34);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.16)";
      g.lineWidth = 4;
      g.beginPath();
      g.arc(118, y + 60, 26, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = "rgba(255,255,255,0.1)";
      roundRect(g, 176, y + 46, 260 + ((i * 97) % 180), 28, 14);
      g.fill();
    }
    // The touch: a soft glow under the fingertip.
    const touch = Math.exp(-Math.pow((t - TICK_AT) / 0.18, 2));
    if (touch > 0.01) {
      const rg = g.createRadialGradient(bx, by, 0, bx, by, 90);
      rg.addColorStop(0, `rgba(255,255,255,${0.35 * touch})`);
      rg.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = rg;
      g.fillRect(bx - 90, by - 90, 180, 180);
    }
  };
}

// GLSL matrices, in JS: R * v with R = rotY(yaw) * rotX(pitch) * rotZ(roll).
export function rotate(v, [yaw, pitch, roll]) {
  let [x, y, z] = v;
  let c = Math.cos(roll), s = Math.sin(roll);
  [x, y] = [c * x - s * y, s * x + c * y];
  c = Math.cos(pitch); s = Math.sin(pitch);
  [y, z] = [c * y - s * z, s * y + c * z];
  c = Math.cos(yaw); s = Math.sin(yaw);
  [x, z] = [c * x + s * z, -s * x + c * z];
  return [x, y, z];
}

export function tickParams(t) {
  const u = clamp((t - 19.6) / 6.4);
  const rot = [lerp(0.34, 0.24, inOutSine(u)), lerp(-0.62, -0.55, u), lerp(0.16, 0.12, u)];
  const centre = [0, 16, 0];
  const boxLocal = [(BOX[0] / PW - 0.5) * 2 * DISP[0], (0.5 - BOX[1] / PH) * 2 * DISP[1], HALF_Z];
  const boxW = add(centre, rotate(boxLocal, rot));
  // The camera looks at the top of the screen, pushing in slowly.
  const aim = add(centre, rotate([0.4, 2.6, 0], rot));
  const dir = norm(rotate([-0.12, 0.1, 1.0], rot));
  const pos = add(aim, scale(dir, lerp(27, 22.5, inOutSine(u))));
  // The finger comes in from the lower right, touches at 21.0, and leaves.
  const approach = outCubic(clamp((t - 20.05) / 0.95));
  const leave = inOutCubic(clamp((t - 21.25) / 1.3));
  const away = 11 * (1 - approach) + 13 * leave + 0.05;
  const fdir = norm(rotate([0.42, -0.5, 0.76], rot));
  const tip = add(boxW, scale(fdir, away));
  const fingerOn = t > 19.9 && t < 23.0 ? 1 : 0;
  return {
    uCamPos: pos,
    uCamTgt: aim,
    uFov: 30,
    uRoll: 0,
    uFocus: Math.hypot(...sub(pos, boxW)),
    uAperture: 16,
    uScreen: "bee",
    uScreenB: "bee",
    uScreenMix: 0,
    uWipe: -2,
    uScreenOn: 1,
    uScreenGain: 1.0,
    uCrop: [0, 0, 1, 1],
    uScreenAvg: [0.12, 0.12, 0.14],
    uRot: rot,
    uPos: centre,
    uRimDir: norm([-0.3, 0.6, -0.75]),
    uRimCol: [0.55, 0.65, 1.0].map((x) => x * 2.0),
    uKeyDir: norm([0.7, 0.4, 0.6]),
    uKeyCol: [1.0, 0.75, 0.5].map((x) => x * 0.25),
    uBg: [0.003, 0.0035, 0.008],
    uGlowCol: [0.5, 0.6, 1.0],
    uGlow: 2.2,
    uShell: 0,
    uShellSweep: 0,
    uFloorRefl: 0.0,
    uDust: 0,
    uMoon: 0,
    uLidAngle: 0,
    ...phoneLook({
      uStripCol: [0.6, 0.7, 1.0].map((x) => x * 1.3),
      uBackCol: [0.035, 0.03, 0.06],
      uBackSize: 0.5,
      uSheenPos: lerp(-0.4, 1.6, inOutSine(clamp((t - 19.7) / 4))),
      uFingerOn: fingerOn,
      uFingerTip: tip,
      uFingerDir: fdir,
      uFingerBend: norm(rotate([0.2, -0.5, -0.2], rot)),
    }),
  };
}
