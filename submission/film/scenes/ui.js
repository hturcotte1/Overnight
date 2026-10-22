// The typography layer: supers, subtitles and the honesty labels, drawn on a 2D canvas for each frame.
import { clamp, ramp, smooth, outCubic, inOutSine } from "./ease.js";

export const FONT = "system-ui, -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif";
export const ROUNDED = "ui-rounded, 'SF Pro Rounded', system-ui, sans-serif";

export function font(size, weight = 600, family = FONT) {
  return `${weight} ${size}px ${family}`;
}

/**
 * A line of text that arrives word by word (fade, a short rise, a blur that clears) and leaves as one.
 * t: film time. inAt/outAt: when it starts arriving and when it is gone.
 */
export function superText(ctx, text, o) {
  const {
    x = 960, y = 540, size = 72, weight = 600, align = "center", color = "255,255,255", t,
    inAt, outAt = 1e9, tracking = -0.02, stagger = 0.09, dur = 0.9, rise = 18, blur = 14,
    outDur = 0.6, family = FONT, alpha = 1, shadow = 0, baseline = "alphabetic",
  } = o;
  if (t < inAt - 0.01 || t > outAt + 0.01) return;
  ctx.save();
  ctx.font = font(size, weight, family);
  ctx.letterSpacing = `${tracking * size}px`;
  ctx.textBaseline = baseline;
  const words = text.split(" ");
  const space = ctx.measureText(" ").width;
  const widths = words.map((w) => ctx.measureText(w).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const out = ramp(t, outAt - outDur, outAt, inOutSine);
  for (let i = 0; i < words.length; i++) {
    const k = outCubic((t - inAt - i * stagger) / dur);
    const a = clamp(k) * (1 - out) * alpha;
    if (a > 0.002) {
      const b = (1 - k) * blur + out * blur * 0.6;
      ctx.filter = b > 0.25 ? `blur(${b.toFixed(2)}px)` : "none";
      ctx.fillStyle = `rgba(${color},${a})`;
      if (shadow > 0) {
        ctx.shadowColor = `rgba(0,0,0,${0.55 * a})`;
        ctx.shadowBlur = shadow;
      }
      ctx.textAlign = "left";
      ctx.fillText(words[i], cx, y + (1 - k) * rise - out * rise * 0.4);
    }
    cx += widths[i] + space;
  }
  ctx.restore();
}

/** Plain text, no animation. */
export function text(ctx, s, x, y, { size = 32, weight = 500, color = "rgba(255,255,255,1)", align = "left", tracking = 0, family = FONT, baseline = "alphabetic", blur = 0 } = {}) {
  ctx.save();
  ctx.font = font(size, weight, family);
  ctx.letterSpacing = `${tracking * size}px`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (blur > 0.25) ctx.filter = `blur(${blur}px)`;
  ctx.fillText(s, x, y);
  const w = ctx.measureText(s).width;
  ctx.restore();
  return w;
}

export function measure(ctx, s, size, weight = 500, tracking = 0, family = FONT) {
  ctx.save();
  ctx.font = font(size, weight, family);
  ctx.letterSpacing = `${tracking * size}px`;
  const w = ctx.measureText(s).width;
  ctx.restore();
  return w;
}

/** The small honesty label, bottom left: "Illustration", "Real app", ... */
export function label(ctx, s, alpha, { corner = "left", y = 1080 - 58 } = {}) {
  if (alpha <= 0.002 || !s) return;
  ctx.save();
  const size = 21;
  ctx.font = font(size, 500);
  ctx.letterSpacing = "0.4px";
  const w = ctx.measureText(s).width;
  const padX = 15, h = 38;
  const x = corner === "left" ? 64 : 1920 - 64 - (w + padX * 2 + 18);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(8,10,18,0.8)"; // opaque enough to read over the light dashboard
  roundRect(ctx, x, y - h / 2, w + padX * 2 + 18, h, h / 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y - h / 2 + 0.5, w + padX * 2 + 17, h - 1, h / 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.arc(x + padX + 3, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.textBaseline = "middle";
  ctx.fillText(s, x + padX + 16, y + 1);
  ctx.restore();
}

/** A film subtitle, centred low in the frame. */
export function subtitle(ctx, s, t, inAt, outAt) {
  const a = Math.min(ramp(t, inAt, inAt + 0.35), 1 - ramp(t, outAt - 0.35, outAt));
  if (a <= 0.002) return;
  ctx.save();
  ctx.font = font(44, 500);
  ctx.letterSpacing = "-0.2px";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = `rgba(255,255,255,${0.96 * a})`;
  ctx.fillText(s, 960, 1080 - 132);
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Word-wraps s to maxW at the context's current font. */
export function wrap(ctx, s, maxW) {
  const out = [];
  let line = "";
  for (const word of s.split(" ")) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = test;
  }
  if (line) out.push(line);
  return out;
}

export { smooth, ramp };

/** A clock whose digits roll from one time to the next (an odometer), with a small suffix (A.M.). */
export function rollingClock(ctx, from, to, k0, { x = 960, y = 560, size = 230, weight = 200, color = "255,255,255", alpha = 1, suffix = "" } = {}) {
  if (alpha <= 0.002) return;
  const track = -0.03 * size;
  const sufSize = Math.max(20, size * 0.2);
  const wFrom = measure(ctx, from, size, weight, -0.03);
  const wTo = measure(ctx, to, size, weight, -0.03);
  const wSuf = suffix ? measure(ctx, suffix, sufSize, 500, 0.12) + sufSize * 0.5 : 0;
  const k = Math.max(0, Math.min(1, k0));
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const wTime = wFrom + (wTo - wFrom) * e;
  const left = x - (wTime + wSuf) / 2;
  const centre = left + wTime / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y - size * 0.92, 1920, size * 1.12);
  ctx.clip();
  ctx.font = font(size, weight);
  ctx.letterSpacing = `${track}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const draw = (s, dy, a, b) => {
    ctx.filter = b > 0.3 ? `blur(${b.toFixed(1)}px)` : "none";
    ctx.fillStyle = `rgba(${color},${a * alpha})`;
    ctx.fillText(s, centre - track / 2, y + dy);
  };
  if (e < 1) draw(from, -e * size * 0.8, 1 - e, e * 10);
  if (e > 0) draw(to, (1 - e) * size * 0.8, e, (1 - e) * 10);
  ctx.restore();
  if (suffix) {
    ctx.save();
    ctx.font = font(sufSize, 500);
    ctx.letterSpacing = `${0.12 * sufSize}px`;
    ctx.fillStyle = `rgba(${color},${0.85 * alpha})`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(suffix, left + wTime + sufSize * 0.5, y);
    ctx.restore();
  }
}

/** A spoken line, set as a quotation: italic, in curly quotes, with a soft shadow. Words arrive in turn. */
export function quote(ctx, s, t, inAt, outAt, { x = 960, y = 1080 - 150, size = 50 } = {}) {
  if (t < inAt - 0.01 || t > outAt + 0.01) return;
  const words = `“${s}”`.split(" ");
  ctx.save();
  ctx.font = `italic 500 ${size}px ${FONT}`;
  ctx.letterSpacing = "-0.3px";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const space = ctx.measureText(" ").width;
  const widths = words.map((w) => ctx.measureText(w).width);
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  let cx = x - total / 2;
  const out = ramp(t, outAt - 0.5, outAt, inOutSine);
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 20;
  for (let i = 0; i < words.length; i++) {
    const k = outCubic((t - inAt - i * 0.16) / 0.7);
    const a = clamp(k) * (1 - out);
    if (a > 0.002) {
      const b = (1 - k) * 8;
      ctx.filter = b > 0.25 ? `blur(${b.toFixed(2)}px)` : "none";
      ctx.fillStyle = `rgba(255,246,236,${0.96 * a})`;
      ctx.fillText(words[i], cx, y + (1 - k) * 10);
    }
    cx += widths[i] + space;
  }
  ctx.restore();
}
