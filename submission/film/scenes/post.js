// The lens and the film stock: motion-blur accumulation, depth of field, bloom, an anamorphic streak,
// tone mapping, the typography layer, vignette, light leak and grain. Every input is a uniform; no clock.
import { HEADER, COMMON } from "./shaders/common.js";
import { W, H, program, target, draw } from "./gl.js";

const DOF = HEADER + COMMON + `
uniform sampler2D uSrc;
uniform float uMaxCoc;
void main() {
  vec2 px = 1.0 / uRes;
  vec4 c0 = texture(uSrc, vUv);
  float cc = abs(c0.a);
  vec3 acc = c0.rgb;
  float tot = 1.0;
  float radius = 0.75;
  float ang = 0.0;
  for (int i = 0; i < 400; i++) {
    if (radius >= uMaxCoc) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * px * radius;
    vec4 s = texture(uSrc, tc);
    float a = abs(s.a);
    // A sample behind the focus may not spread over something sharper than itself.
    if (s.a >= 0.0 && a > cc) a = min(a, cc * 2.0 + 0.5);
    float m = smoothstep(radius - 0.75, radius + 0.75, a);
    acc += mix(acc / tot, s.rgb, m);
    tot += 1.0;
    ang += 2.39996323;
    radius += 1.35 / radius;
  }
  outColor = vec4(acc / tot, c0.a);
}`;

const PREFILTER = HEADER + COMMON + `
uniform sampler2D uSrc;
uniform sampler2D uUi;
uniform float uThreshold, uKnee, uUiGlow;
vec3 lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 tap(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb;
  c += lin(texture(uUi, uv).rgb) * uUiGlow;
  return min(c, vec3(60.0));
}
void main() {
  vec2 px = 1.0 / uRes;
  // 13-tap downsample (half resolution)
  vec3 a = tap(vUv + px * vec2(-1, -1)), b = tap(vUv + px * vec2(1, -1)), c = tap(vUv + px * vec2(-1, 1)), d = tap(vUv + px * vec2(1, 1));
  vec3 e = tap(vUv), f = tap(vUv + px * vec2(-2, 0)), g = tap(vUv + px * vec2(2, 0)), h = tap(vUv + px * vec2(0, -2)), k = tap(vUv + px * vec2(0, 2));
  vec3 col = e * 0.25 + (a + b + c + d) * 0.125 + (f + g + h + k) * 0.0625;
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  outColor = vec4(col * w, 1.0);
}`;

const DOWN = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uSrcPx;
void main() {
  vec2 px = uSrcPx;
  vec3 a = texture(uSrc, vUv + px * vec2(-2, -2)).rgb, b = texture(uSrc, vUv + px * vec2(0, -2)).rgb, c = texture(uSrc, vUv + px * vec2(2, -2)).rgb;
  vec3 d = texture(uSrc, vUv + px * vec2(-2, 0)).rgb, e = texture(uSrc, vUv).rgb, f = texture(uSrc, vUv + px * vec2(2, 0)).rgb;
  vec3 g = texture(uSrc, vUv + px * vec2(-2, 2)).rgb, h = texture(uSrc, vUv + px * vec2(0, 2)).rgb, i = texture(uSrc, vUv + px * vec2(2, 2)).rgb;
  vec3 j = texture(uSrc, vUv + px * vec2(-1, -1)).rgb, k = texture(uSrc, vUv + px * vec2(1, -1)).rgb, l = texture(uSrc, vUv + px * vec2(-1, 1)).rgb, m = texture(uSrc, vUv + px * vec2(1, 1)).rgb;
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  outColor = vec4(col, 1.0);
}`;

const UP = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uSrcPx;
uniform float uScatter;
void main() {
  vec2 px = uSrcPx * 1.0;
  vec3 c = texture(uSrc, vUv + px * vec2(-1, -1)).rgb + texture(uSrc, vUv + px * vec2(1, -1)).rgb
         + texture(uSrc, vUv + px * vec2(-1, 1)).rgb + texture(uSrc, vUv + px * vec2(1, 1)).rgb;
  c += 2.0 * (texture(uSrc, vUv + px * vec2(0, -1)).rgb + texture(uSrc, vUv + px * vec2(0, 1)).rgb
            + texture(uSrc, vUv + px * vec2(-1, 0)).rgb + texture(uSrc, vUv + px * vec2(1, 0)).rgb);
  c += 4.0 * texture(uSrc, vUv).rgb;
  outColor = vec4(c / 16.0 * uScatter, 1.0);
}`;

const STREAK = HEADER + `
uniform sampler2D uSrc;
uniform float uStep;
void main() {
  vec2 px = vec2(1.0 / uRes.x, 0.0) * uStep;
  vec3 c = vec3(0.0);
  float tot = 0.0;
  for (int i = -7; i <= 7; i++) {
    float w = exp(-float(i * i) / 18.0);
    c += texture(uSrc, vUv + px * float(i)).rgb * w;
    tot += w;
  }
  outColor = vec4(c / tot, 1.0);
}`;

const FINAL = HEADER + COMMON + `
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform sampler2D uStreakTex;
uniform sampler2D uUi;
uniform float uBloomAmt, uStreakAmt, uExposure, uVignette, uGrain, uFade, uCA, uFrame, uLeak, uSat, uLift, uUiOpacity;
uniform vec3 uStreakTint, uLeakColor, uGrade;
uniform vec2 uLeakPos;
vec3 aces(vec3 x) {
  const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = m1 * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), 0.0, 1.0);
}
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  float r2 = dot(dc, dc);
  // Lateral chromatic aberration, strongest at the corners.
  vec2 off = dc * r2 * uCA * 0.012;
  vec3 col;
  col.r = texture(uSrc, uv - off).r;
  col.g = texture(uSrc, uv).g;
  col.b = texture(uSrc, uv + off).b;
  col += texture(uBloom, uv).rgb * uBloomAmt;
  col += texture(uStreakTex, uv).rgb * uStreakAmt * uStreakTint;
  // Light leak: a warm wash that drifts in from an edge.
  if (uLeak > 0.0) {
    vec2 a = vec2((uv.x - uLeakPos.x) * uRes.x / uRes.y, uv.y - uLeakPos.y);
    float l = exp(-dot(a, a) * 2.2) * 0.85 + exp(-dot(a * vec2(0.55, 2.2), a * vec2(0.55, 2.2)) * 1.4) * 0.4;
    col += uLeakColor * l * uLeak;
  }
  col *= uExposure * uGrade;
  col += uLift * vec3(0.004, 0.006, 0.012);
  col = aces(col);
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(luma), col, uSat), 0.0);
  col = srgb(col);
  vec4 ui = texture(uUi, uv) * uUiOpacity;
  col = col * (1.0 - ui.a) + ui.rgb;
  // Vignette.
  float vig = 1.0 - smoothstep(0.18, 0.95, r2 * 2.1);
  col *= mix(1.0, 0.25 + 0.75 * vig, uVignette);
  col *= uFade;
  // Grain: fine, moving, a little stronger in the mid tones. Then a dither against banding.
  vec2 gp = gl_FragCoord.xy / 1.35 + vec2(hash11(uFrame * 1.7) * 512.0, hash11(uFrame * 3.1 + 1.0) * 512.0);
  float g = vnoise(gp) + vnoise(gp * 1.9 + 31.0) * 0.6 - 0.8;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col += g * uGrain * (0.35 + 0.65 * (1.0 - abs(lum - 0.4) * 1.4));
  col += (hash21(gl_FragCoord.xy + uFrame * 13.0) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

const COPY = HEADER + `
uniform sampler2D uSrc;
uniform float uGain;
void main() { outColor = texture(uSrc, vUv) * uGain; }`;

export function createPost(ctx) {
  const t = {
    accum: target(ctx, W, H),
    dof: target(ctx, W, H),
    layer: target(ctx, W, H),
    bloom: [],
    streakA: target(ctx, W / 4, H / 4),
    streakB: target(ctx, W / 4, H / 4),
  };
  let w = W / 2, h = H / 2;
  for (let i = 0; i < 7; i++) {
    t.bloom.push(target(ctx, Math.max(1, Math.round(w)), Math.max(1, Math.round(h))));
    w /= 2;
    h /= 2;
  }
  const p = {
    dof: program(ctx, "dof", DOF),
    prefilter: program(ctx, "prefilter", PREFILTER),
    down: program(ctx, "down", DOWN),
    up: program(ctx, "up", UP),
    streak: program(ctx, "streak", STREAK),
    final: program(ctx, "final", FINAL),
    copy: program(ctx, "copy", COPY),
  };
  return { t, p };
}

/**
 * Lens and film on the HDR image in post.t.accum (or src). ui: the typography texture. look: the grade.
 * Writes to the canvas.
 */
export function finish(ctx, post, src, uiTex, look) {
  const { t, p } = post;
  let img = src;
  if (look.maxCoc > 0.8) {
    draw(ctx, p.dof, t.dof, { uSrc: src.tex, uMaxCoc: look.maxCoc });
    img = t.dof;
  }
  // Bloom chain.
  draw(ctx, p.prefilter, t.bloom[0], { uSrc: img.tex, uUi: uiTex, uThreshold: look.threshold, uKnee: look.knee, uUiGlow: look.uiGlow });
  for (let i = 1; i < t.bloom.length; i++) {
    const s = t.bloom[i - 1];
    draw(ctx, p.down, t.bloom[i], { uSrc: s.tex, uSrcPx: [0.5 / s.w, 0.5 / s.h] });
  }
  // Streak from the quarter-size level, before the up pass adds to it.
  if (look.streak > 0) {
    draw(ctx, p.copy, t.streakA, { uSrc: t.bloom[1].tex, uGain: 1 });
    let a = t.streakA, b = t.streakB;
    for (const step of [1.5, 4, 10, 22]) {
      draw(ctx, p.streak, b, { uSrc: a.tex, uStep: step });
      [a, b] = [b, a];
    }
    t.streakOut = a;
  }
  for (let i = t.bloom.length - 1; i > 0; i--) {
    const s = t.bloom[i];
    draw(ctx, p.up, t.bloom[i - 1], { uSrc: s.tex, uSrcPx: [1 / s.w, 1 / s.h], uScatter: look.scatter }, { blend: "add" });
  }
  draw(ctx, p.final, null, {
    uSrc: img.tex,
    uBloom: t.bloom[0].tex,
    uStreakTex: look.streak > 0 ? t.streakOut.tex : null,
    uUi: uiTex,
    uBloomAmt: look.bloom,
    uStreakAmt: look.streak,
    uStreakTint: look.streakTint,
    uExposure: look.exposure,
    uVignette: look.vignette,
    uGrain: look.grain,
    uFade: look.fade,
    uCA: look.ca,
    uFrame: look.frame,
    uLeak: look.leak,
    uLeakPos: look.leakPos,
    uLeakColor: look.leakColor,
    uSat: look.sat,
    uLift: look.lift,
    uGrade: look.grade,
    uUiOpacity: look.uiOpacity,
  });
}

export const DEFAULT_LOOK = {
  maxCoc: 0,
  threshold: 0.9,
  knee: 0.6,
  uiGlow: 0.35,
  scatter: 0.85,
  bloom: 0.55,
  streak: 0.25,
  streakTint: [0.55, 0.7, 1.0],
  exposure: 1.0,
  vignette: 0.55,
  grain: 0.035,
  fade: 1,
  ca: 0.35,
  frame: 0,
  leak: 0,
  leakPos: [1.1, 0.8],
  leakColor: [1.0, 0.45, 0.18],
  sat: 1.0,
  lift: 0.0,
  grade: [1, 1, 1],
  uiOpacity: 1,
};
