// The watch screen, drawn on its own canvas and mapped onto the glass by the wrist shader.
// Our own clean design: a black OLED screen, a time, and a to-do card. Not Bee's or Apple's interface.
import { clamp, ramp, outCubic, outExpo, inOutCubic, smooth, lerp } from "./ease.js";
import { font, ROUNDED, FONT, roundRect, wrap } from "./ui.js";

export const SW = 830;
export const SH = 1000;

const AMBER = "255,190,80";
const GREEN = "79,211,154";

function timeFace(ctx, time, a, { y = 250, size = 210, color = "255,255,255" } = {}) {
  if (a <= 0) return;
  ctx.save();
  ctx.font = font(size, 600, ROUNDED);
  ctx.letterSpacing = "-4px";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(${color},${a})`;
  ctx.fillText(time, SW / 2, y);
  ctx.restore();
}

function cardFrame(ctx, x, y, w, h, a) {
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#26262b");
  g.addColorStop(1, "#1a1a1f");
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, 64);
  ctx.fill();
  ctx.restore();
}

function header(ctx, x, y, a, right = "now") {
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = `rgb(${AMBER})`;
  ctx.beginPath();
  ctx.arc(x + 22, y - 14, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1408";
  ctx.font = font(22, 800, ROUNDED);
  ctx.textAlign = "center";
  ctx.fillText("✓", x + 22, y - 6);
  ctx.textAlign = "left";
  ctx.font = font(34, 600, ROUNDED);
  ctx.letterSpacing = "1px";
  ctx.fillStyle = `rgba(${AMBER},1)`;
  ctx.fillText("BEE · TO-DO", x + 56, y);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText(right, SW - x, y);
  ctx.restore();
}

/**
 * state: { mode: "face" | "ask" | "night" | "morning", time, cardIn (0..1), tick (0..1), approved (0..1),
 *          pulse (0..1, the haptic ripple), night (0..1), stars: seconds, url, title }
 */
export function drawWatch(ctx, s) {
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, SW, SH);

  if (s.mode === "night" || (s.night ?? 0) > 0) drawNight(ctx, s);

  if (s.mode === "face" || s.mode === "ask") {
    const faceA = 1 - clamp(s.cardIn ?? 0) * 0.85;
    timeFace(ctx, s.time ?? "12:41", faceA * (1 - (s.night ?? 0)), { y: lerp(330, 150, outCubic(s.cardIn ?? 0)), size: lerp(230, 96, outCubic(s.cardIn ?? 0)) });
  }
  if (s.mode === "ask") drawAsk(ctx, s);
  if (s.mode === "listen") drawListen(ctx, s);
  if (s.mode === "morning") drawMorning(ctx, s);

  // The haptic ripple: a soft ring of light that runs out from the edge of the card.
  if ((s.pulse ?? 0) > 0 && s.pulse < 1) {
    const k = outCubic(s.pulse);
    ctx.save();
    ctx.globalAlpha = (1 - s.pulse) * 0.55;
    ctx.strokeStyle = s.mode === "morning" ? "rgba(255,200,120,1)" : `rgba(${AMBER},1)`;
    ctx.lineWidth = 10 * (1 - k) + 2;
    ctx.filter = "blur(4px)";
    roundRect(ctx, 40 - k * 30, 290 - k * 30, SW - 80 + k * 60, 640 + k * 60, 70 + k * 30);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawAsk(ctx, s) {
  const k = outExpo(clamp(s.cardIn ?? 0));
  if (k <= 0) return;
  const y0 = lerp(SH + 40, 250, k);
  const a = clamp((s.cardIn ?? 0) * 3);
  cardFrame(ctx, 34, y0, SW - 68, 690, a);
  header(ctx, 86, y0 + 88, a);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "#fff";
  ctx.font = font(58, 600, FONT);
  ctx.letterSpacing = "-0.6px";
  ctx.fillText("💡 Build tonight?", 86, y0 + 190);
  ctx.font = font(72, 700, FONT);
  ctx.letterSpacing = "-1.4px";
  const lines = wrap(ctx, s.title ?? "Game Night Scores", SW - 172);
  lines.forEach((l, i) => ctx.fillText(l, 86, y0 + 285 + i * 82));
  ctx.restore();

  // The tick: a round box that fills and draws a check.
  const tick = clamp(s.tick ?? 0);
  const cx = SW / 2, cy = y0 + 560, r = 66;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.lineWidth = 7;
  ctx.strokeStyle = tick > 0 ? `rgba(${GREEN},1)` : "rgba(255,255,255,0.75)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (tick > 0) {
    const f = outCubic(clamp(tick * 1.6));
    ctx.fillStyle = `rgba(${GREEN},${f})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.6 + 0.4 * f), 0, Math.PI * 2);
    ctx.fill();
    const c = clamp((tick - 0.25) / 0.6);
    if (c > 0) {
      ctx.strokeStyle = "#0b1a12";
      ctx.lineWidth = 12;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const p = [[cx - 30, cy + 2], [cx - 8, cy + 25], [cx + 32, cy - 22]];
      ctx.beginPath();
      ctx.moveTo(...p[0]);
      const k1 = clamp(c * 2), k2 = clamp(c * 2 - 1);
      ctx.lineTo(lerp(p[0][0], p[1][0], k1), lerp(p[0][1], p[1][1], k1));
      if (k2 > 0) ctx.lineTo(lerp(p[1][0], p[2][0], k2), lerp(p[1][1], p[2][1], k2));
      ctx.stroke();
    }
  }
  ctx.restore();
  // "Approved." under the title once ticked.
  const ap = clamp(s.approved ?? 0);
  if (ap > 0) {
    ctx.save();
    ctx.globalAlpha = ap * a;
    ctx.fillStyle = `rgb(${GREEN})`;
    ctx.font = font(44, 600, ROUNDED);
    ctx.textAlign = "center";
    ctx.fillText("Approved.", cx, y0 + 470 + (1 - outCubic(ap)) * 14);
    ctx.restore();
  }
}

function drawNight(ctx, s) {
  const n = clamp(s.night ?? 1);
  ctx.save();
  ctx.globalAlpha = n;
  const g = ctx.createLinearGradient(0, 0, 0, SH);
  g.addColorStop(0, "#02040c");
  g.addColorStop(0.65, "#0a1236");
  g.addColorStop(1, "#1d2a6a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SW, SH);
  // Stars: fixed positions, a slow twinkle.
  const tt = s.stars ?? 0;
  for (let i = 0; i < 140; i++) {
    const x = (Math.sin(i * 91.7) * 0.5 + 0.5) * SW;
    const y = (Math.sin(i * 37.3 + 2.0) * 0.5 + 0.5) * SH * 0.95;
    const b = 0.35 + 0.65 * (Math.sin(i * 12.9) * 0.5 + 0.5);
    const tw = 0.75 + 0.25 * Math.sin(tt * (1.2 + (i % 5) * 0.4) + i);
    ctx.fillStyle = `rgba(220,230,255,${b * tw})`;
    const r = 1.2 + 2.2 * Math.pow(Math.sin(i * 5.1) * 0.5 + 0.5, 4);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  const ta = clamp(s.nightTime ?? 0);
  if (ta > 0) timeFace(ctx, s.nightClock ?? "12:59", ta * n, { y: 585, size: 240, color: "235,240,255" });
}

function drawMorning(ctx, s) {
  const k = outExpo(clamp(s.cardIn ?? 0));
  // A warm glow at the top of the face.
  const g = ctx.createRadialGradient(SW / 2, -200, 50, SW / 2, -200, 900);
  g.addColorStop(0, "rgba(255,170,80,0.55)");
  g.addColorStop(1, "rgba(255,170,80,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SW, SH);
  timeFace(ctx, s.time ?? "7:00", 1 - k * 0.85, { y: lerp(330, 150, outCubic(s.cardIn ?? 0)), size: lerp(230, 96, outCubic(s.cardIn ?? 0)) });
  if (k <= 0) return;
  const y0 = lerp(SH + 40, 250, k);
  const a = clamp((s.cardIn ?? 0) * 3);
  cardFrame(ctx, 34, y0, SW - 68, 700, a);
  header(ctx, 86, y0 + 88, a);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "#fff";
  ctx.font = font(54, 600, FONT);
  ctx.letterSpacing = "-0.5px";
  ctx.fillText("☀️ Built overnight:", 86, y0 + 186);
  ctx.font = font(66, 700, FONT);
  ctx.letterSpacing = "-1.2px";
  ctx.fillText(`${s.title ?? "Game Night Scores"} →`, 86, y0 + 268);
  ctx.font = font(44, 500, FONT);
  ctx.letterSpacing = "-0.3px";
  ctx.fillStyle = "rgb(150,170,255)";
  const url = s.url ?? "https://hturcotte1.github.io/overnight-apps/game-night-scores/";
  const parts = url.replace("https://", "https://​").split(/(?<=\/)/);
  // Break the address after slashes so it wraps cleanly.
  const lines = [];
  let line = "";
  for (const part of parts) {
    if (ctx.measureText(line + part).width > SW - 172 && line) {
      lines.push(line);
      line = part;
    } else line += part;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l.replace("​", ""), 86, y0 + 356 + i * 56));
  ctx.restore();
}

/** Listening: the time, small, and a live waveform. Our own design. */
function drawListen(ctx, s) {
  const lv = s.level ?? 0;
  timeFace(ctx, s.time ?? "12:40", 0.85, { y: 200, size: 120 });
  const n = 23, cx = SW / 2, cy = 560, gap = 26;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const x = cx + (i - (n - 1) / 2) * gap;
    const env = Math.exp(-Math.pow((i - (n - 1) / 2) / 7.5, 2));
    const v = 0.25 + 0.75 * Math.abs(Math.sin(lv * 5.3 + i * 0.83) * Math.sin(lv * 2.1 + i * 0.37 + 1.0));
    const h = 26 + 300 * env * v;
    ctx.strokeStyle = `rgba(${AMBER},${0.55 + 0.45 * env})`;
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(x, cy - h / 2);
    ctx.lineTo(x, cy + h / 2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.font = font(40, 600, ROUNDED);
  ctx.letterSpacing = "1px";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(${AMBER},0.9)`;
  ctx.fillText("BEE · LISTENING", SW / 2, 850);
  ctx.restore();
}
