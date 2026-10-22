// The wrist world: a man's forearm and hand in near darkness, a watch on the wrist, and (when asked)
// a finger of the other hand. Raymarched signed distances, units in centimetres.
// Arm space: x runs along the forearm toward the hand, y is up (the watch faces +y), z toward the thumb.
import { HEADER, COMMON } from "./common.js";

export const WRIST = HEADER + COMMON + `
uniform vec3 uCamPos, uCamTgt;
uniform float uFov, uRoll, uFocus, uAperture;
uniform sampler2D uScreen;
uniform float uScreenOn;
uniform vec3 uScreenGlow;
uniform vec3 uShake;
uniform vec3 uFingerTip, uFingerDir, uFingerBend, uFingerUp;
uniform float uFingerOn;
uniform vec3 uRimDir, uRimCol, uKeyDir, uKeyCol, uAmb, uBg, uHazeCol;
uniform float uHaze, uBokeh, uDust, uWarm;
uniform float uGlassScreen; // 1: the glass shows the screen texture; 0: dark glass
uniform float uPoolKey, uPoolRim; // radius (cm) of the pools of key and rim light around the watch
uniform float uShadowK;          // soft-shadow hardness: 8 to 10 is a small hard light, 2 to 3 a wide soft one
uniform float uScreenGain;       // how bright the watch screen glows (linear)
uniform float uHandFade;         // 1: the hand past the knuckles falls into darkness

const vec3 CASE_C = vec3(-2.1, 0.86, 0.0);
const vec2 CASE_HALF = vec2(1.9, 2.25);
const float CASE_HH = 0.52;
const vec2 DISP_HALF = vec2(1.66, 2.0);

float topLine(float x) {
  float elbowRise = 1.35 * (1.0 - smoothstep(-30.0, -1.0, x));
  float handDrop = 0.55 * smoothstep(0.5, 10.0, x);
  return 0.06 + elbowRise - handDrop;
}
vec2 halfSize(float x) {
  float tA = smoothstep(-30.0, 0.5, x);
  float ry = mix(3.55, 1.98, tA);
  float rz = mix(4.35, 2.95, tA);
  float tH = smoothstep(0.3, 7.0, x);
  ry = mix(ry, 1.22, tH);
  rz = mix(rz, 4.05, smoothstep(0.8, 8.0, x));
  return vec2(ry, rz);
}
float sdLimbRaw(vec3 p) {
  vec2 r = halfSize(p.x);
  float cy = topLine(p.x) - r.x;
  float cz = 0.25 * smoothstep(0.0, 9.0, p.x);
  vec2 q = vec2(p.y - cy, p.z - cz);
  // A superellipse: rounder at the forearm, flatter on top at the wrist and over the hand. Smooth everywhere.
  float n = mix(2.1, 2.9, smoothstep(-6.0, 4.0, p.x));
  vec2 a = abs(q) / r;
  float k = pow(pow(a.x, n) + pow(a.y, n), 1.0 / n);
  return (k - 1.0) * min(r.x, r.y);
}
float sdLimb(vec3 p) {
  float d = sdLimbRaw(p);
  // Close the hand at the knuckle line (a little further forward on the index side).
  float kx = 9.4 + 0.28 * p.z;
  d = smax(d, p.x - kx, 1.6);
  // The wrist bone on the little-finger side.
  // (no separate wrist-bone bump: its seam showed as a crease)
  return d;
}
float sdFingers(vec3 p) {
  if (p.x < 5.5) return 1e3;
  float d = 1e3;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float z = 2.8 - fi * 1.88;
    float len = (i == 0) ? 4.4 : (i == 1) ? 4.8 : (i == 2) ? 4.5 : 3.6;
    float r = (i == 0) ? 0.97 : (i == 1) ? 0.95 : (i == 2) ? 0.9 : 0.8;
    vec3 k = vec3(8.7 + 0.22 * z, topLine(8.7) - 1.05, z);
    vec3 a = k + vec3(len * 0.84, -len * 0.54, 0.05 * z);
    vec3 b = a + vec3(len * 0.3, -len * 0.5, 0.0);
    vec3 c = b + vec3(-len * 0.06, -len * 0.42, 0.0);
    float f = sdCapsule2(p, k, a, r, r * 0.92);
    f = smin(f, sdCapsule2(p, a, b, r * 0.92, r * 0.84), 0.3);
    f = smin(f, sdCapsule2(p, b, c, r * 0.84, r * 0.74), 0.25);
    d = smin(d, f, 0.55);
  }
  return d;
}
float sdThumb(vec3 p) {
  vec3 a = vec3(1.3, -1.5, 2.4), b = vec3(4.9, -2.55, 4.1), c = vec3(7.5, -3.1, 4.7), d_ = vec3(9.5, -3.75, 4.45);
  float d = sdCapsule2(p, a, b, 1.35, 1.05);
  d = smin(d, sdCapsule2(p, b, c, 1.02, 0.93), 0.3);
  d = smin(d, sdCapsule2(p, c, d_, 0.92, 0.8), 0.25);
  return d;
}
float sdHandAll(vec3 p) {
  float d = sdLimb(p);
  d = smin(d, sdThumb(p), 1.4);
  d = smin(d, sdFingers(p), 1.7);
  return d;
}
float sdSleeve(vec3 p) {
  if (p.x > -10.0) return 1e3;
  float cuffX = -15.0 + 0.35 * sin(atan(p.z, p.y) * 3.0 + 1.0) + 0.2 * sin(atan(p.z, p.y) * 7.0);
  float d = sdLimbRaw(p) - 1.05;
  // Knit ribs around the cuff.
  float ang = atan(p.z, p.y - topLine(p.x) + halfSize(p.x).x);
  d -= 0.05 * (0.5 + 0.5 * sin(ang * 70.0)) * smoothstep(cuffX - 5.0, cuffX, p.x);
  d = smax(d, p.x - cuffX, 0.6);
  return d;
}
float sdCase(vec3 q) {
  return sdSlab(q, CASE_HALF, 1.05, CASE_HH, 0.44);
}
float sdCrown(vec3 q) {
  vec3 c = q - vec3(CASE_HALF.x + 0.09, 0.07, -0.62);
  float ang = atan(c.z, c.y);
  float r = 0.34 - 0.012 * (0.5 + 0.5 * sin(ang * 46.0));
  vec2 w = vec2(length(c.yz) - r, abs(c.x) - 0.17);
  float d = min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.035;
  return d;
}
float sdButton(vec3 q) {
  return sdRoundBox(q - vec3(CASE_HALF.x - 0.03, 0.05, 0.78), vec3(0.09, 0.1, 0.44), 0.08);
}
float sdBand(vec3 p) {
  if (abs(p.x - CASE_C.x) > 1.6) return 1e3;
  float s = sdLimbRaw(p);
  float d = abs(s - 0.19) - 0.155;
  d = smax(d, abs(p.x - CASE_C.x) - 1.1, 0.14);
  return d;
}
float sdFinger(vec3 p) {
  if (uFingerOn < 0.5) return 1e3;
  vec3 d1 = uFingerDir;
  vec3 d2 = normalize(d1 + uFingerBend * 0.35);
  vec3 d3 = normalize(d1 + uFingerBend * 0.75);
  vec3 a = uFingerTip + d1 * 0.7;
  vec3 b = a + d1 * 1.75;
  vec3 c = b + d2 * 2.6;
  vec3 e = c + d3 * 4.4;
  float d = sdCapsule2(p, a, b, 0.72, 0.78);
  d = smin(d, sdCapsule2(p, b, c, 0.8, 0.86), 0.25);
  d = smin(d, sdCapsule2(p, c, e, 0.88, 0.98), 0.25);
  d = smin(d, length(p - (e + d3 * 3.0)) - 3.2, 1.5);
  return d;
}

// Returns distance and material: 1 skin, 2 sleeve, 3 band, 4 case, 6 crown, 7 button, 8 finger.
vec2 map(vec3 p) {
  vec2 res = vec2(sdHandAll(p), 1.0);
  float s = sdSleeve(p);
  if (s < res.x) res = vec2(s, 2.0);
  float b = sdBand(p);
  if (b < res.x) res = vec2(b, 3.0);
  vec3 q = p - CASE_C - uShake;
  if (length(q) < 4.5) {
    float c = sdCase(q);
    if (c < res.x) res = vec2(c, 4.0);
    float cr = sdCrown(q);
    if (cr < res.x) res = vec2(cr, 6.0);
    float bt = sdButton(q);
    if (bt < res.x) res = vec2(bt, 7.0);
  }
  float f = sdFinger(p);
  if (f < res.x) res = vec2(f, 8.0);
  return res;
}
vec3 calcNormal(vec3 p, float e) {
  const vec2 k = vec2(1, -1);
  return normalize(k.xyy * map(p + k.xyy * e).x + k.yyx * map(p + k.yyx * e).x + k.yxy * map(p + k.yxy * e).x + k.xxx * map(p + k.xxx * e).x);
}
float softShadow(vec3 ro, vec3 rd, float k) {
  float res = 1.0, t = 0.04;
  for (int i = 0; i < 48; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, k * h / t);
    t += clamp(h, 0.03, 1.2);
    if (res < 0.002 || t > 40.0) break;
  }
  return sat(res);
}
float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, w = 1.0;
  for (int i = 1; i <= 5; i++) {
    float h = 0.08 + 0.32 * float(i);
    occ += (h - map(p + n * h).x) * w;
    w *= 0.62;
  }
  return sat(1.0 - 0.55 * occ);
}

// The studio: near-black, a big cool softbox behind and above, a long warm strip low on the left.
vec3 env(vec3 rd, float rough) {
  float soft = 0.04 + rough * 0.9;
  vec3 c = uBg * (0.6 + 0.4 * sat(rd.y));
  vec3 rimC = normalize(uRimDir);
  vec3 rr = normalize(cross(rimC, vec3(0, 1, 0)));
  vec3 ru = cross(rr, rimC);
  c += uRimCol * 0.9 * softbox(rd, rimC, rr, ru, vec2(0.9, 0.22), soft);
  vec3 keyC = normalize(uKeyDir);
  vec3 kr = normalize(cross(keyC, vec3(0, 1, 0)));
  vec3 ku = cross(kr, keyC);
  c += uKeyCol * 1.6 * softbox(rd, keyC, kr, ku, vec2(0.12, 0.7), soft);
  c += uRimCol * 0.25 * softbox(rd, normalize(vec3(0.3, 1.0, 0.2)), vec3(1, 0, 0), vec3(0, 0, 1), vec2(0.5, 0.5), soft + 0.2);
  return c;
}

vec2 dispUV(vec3 q) { return vec2((q.x + DISP_HALF.x) / (2.0 * DISP_HALF.x), (-q.z + DISP_HALF.y) / (2.0 * DISP_HALF.y)); }

vec3 screenLight(vec3 p, vec3 n, out vec3 L) {
  vec3 sp = CASE_C + uShake + vec3(0.0, CASE_HH + 0.25, 0.0);
  vec3 dv = sp - p;
  float d2 = dot(dv, dv);
  L = dv * inversesqrt(d2);
  float facing = sat(dot(-L, vec3(0, 1, 0)) * 1.4 + 0.25); // the screen lights what is above it
  return uScreenGlow * uScreenOn * facing * 2.2 / (1.0 + d2 * 0.55);
}

float pool(vec3 p, float r) {
  vec3 d = (p - CASE_C) * vec3(1.0, 1.0, 1.3);
  return exp(-dot(d, d) / (r * r));
}
vec3 shadeSkin(vec3 p, vec3 n, vec3 v, float ao, float mat) {
  float tone = 0.9 + 0.18 * fbm(p.xz * 1.7 + p.y);
  vec3 alb = vec3(0.36, 0.22, 0.16) * tone;
  // Fine skin texture in the normal.
  vec3 bump = vec3(vnoise3(p * 4.5), vnoise3(p * 4.5 + 7.0), vnoise3(p * 4.5 + 13.0)) - 0.5;
  vec3 fine = vec3(vnoise3(p * 11.0), vnoise3(p * 11.0 + 7.0), vnoise3(p * 11.0 + 13.0)) - 0.5;
  n = normalize(n + bump * 0.045 + fine * 0.012);
  vec3 w = vec3(0.32, 0.17, 0.12);
  vec3 col = vec3(0.0);
  float shR = softShadow(p + n * 0.03, uRimDir, uShadowK * 1.2) * pool(p, uPoolRim);
  float shK = softShadow(p + n * 0.03, uKeyDir, uShadowK) * pool(p, uPoolKey);
  // Past the knuckles the hand falls away into the dark, so the fingers never take the eye.
  float handK = mix(1.0, 0.025 + 0.975 * smoothstep(10.5, 5.5, p.x), uHandFade);
  shR *= handK; shK *= handK;
  vec3 dR = sat3((vec3(dot(n, uRimDir)) + w) / (1.0 + w));
  vec3 dK = sat3((vec3(dot(n, uKeyDir)) + w) / (1.0 + w));
  col += alb * uRimCol * dR * dR * shR;
  col += alb * uKeyCol * dK * shK;
  vec3 Ls;
  vec3 sc = screenLight(p, n, Ls);
  vec3 dS = sat3((vec3(dot(n, Ls)) + w) / (1.0 + w));
  col += alb * sc * dS * (0.6 + 0.4 * ao) * handK;
  col += alb * uAmb * (0.5 + 0.5 * n.y) * ao * handK;
  float nv = max(dot(n, v), 0.0);
  float spec = ggx(n, v, uRimDir, 0.5) * shR;
  col += uRimCol * spec * 0.055;
  col += uKeyCol * ggx(n, v, uKeyDir, 0.52) * shK * 0.04;
  col += sc * ggx(n, v, Ls, 0.4) * 0.05;
  // Rim sheen: grazing light on skin.
  col += uRimCol * pow(1.0 - nv, 4.0) * sat(dot(n, uRimDir) + 0.3) * shR * 0.35 * vec3(1.0, 0.85, 0.78);
  return col;
}

vec3 shadeFabric(vec3 p, vec3 n, vec3 v, float ao) {
  vec3 alb = vec3(0.028, 0.03, 0.036);
  float shR = softShadow(p + n * 0.03, uRimDir, uShadowK) * pool(p, uPoolRim);
  float nv = max(dot(n, v), 0.0);
  vec3 col = alb * uRimCol * sat(dot(n, uRimDir)) * shR;
  col += alb * uKeyCol * sat(dot(n, uKeyDir));
  col += alb * uAmb * ao;
  col += uRimCol * pow(1.0 - nv, 2.5) * sat(dot(n, uRimDir) + 0.2) * shR * 0.08;
  return col;
}

vec3 shadeBand(vec3 p, vec3 n, vec3 v, float ao) {
  vec3 alb = mix(vec3(0.012, 0.013, 0.02), vec3(0.03, 0.022, 0.02), uWarm);
  float shR = softShadow(p + n * 0.03, uRimDir, uShadowK * 1.2);
  float shK = softShadow(p + n * 0.03, uKeyDir, uShadowK);
  vec3 col = alb * uRimCol * sat(dot(n, uRimDir)) * shR + alb * uKeyCol * sat(dot(n, uKeyDir)) * shK + alb * uAmb * ao;
  vec3 Ls;
  vec3 sc = screenLight(p, n, Ls);
  col += alb * sc * sat(dot(n, Ls));
  float nv = max(dot(n, v), 0.0);
  float F = fresnel(nv, 0.04);
  col += uRimCol * ggx(n, v, uRimDir, 0.45) * shR * 0.12;
  col += uKeyCol * ggx(n, v, uKeyDir, 0.45) * shK * 0.1;
  col += env(reflect(-v, n), 0.55) * F * 0.5 * ao;
  col += sc * ggx(n, v, Ls, 0.4) * 0.08;
  return col;
}

vec3 shadeMetal(vec3 p, vec3 n, vec3 v, float ao, float rough, vec3 f0) {
  vec3 r = reflect(-v, n);
  float nv = max(dot(n, v), 0.0);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0);
  vec3 col = env(r, rough) * F * (0.4 + 0.6 * ao);
  col += uRimCol * ggx(n, v, uRimDir, max(rough, 0.12)) * F * 0.5;
  col += uKeyCol * ggx(n, v, uKeyDir, max(rough, 0.12)) * F * 0.4;
  vec3 Ls;
  vec3 sc = screenLight(p, n, Ls);
  col += sc * ggx(n, v, Ls, 0.2) * F * 0.3;
  return col;
}

vec3 shadeCase(vec3 p, vec3 n, vec3 v, float ao) {
  vec3 q = p - CASE_C - uShake;
  vec3 col;
  if (n.y > 0.62 && q.y > 0.1) {
    // Glass: a slight dome bends the reflections; the screen glows from underneath.
    vec3 gn = normalize(n + vec3(-q.x * 0.045, 0.0, -q.z * 0.04));
    vec3 r = reflect(-v, gn);
    float F = fresnel(max(dot(gn, v), 0.0), 0.04);
    vec3 refl = env(r, 0.02) * F;
    vec2 uv = dispUV(q);
    float inside = 1.0 - smoothstep(-0.02, 0.02, sdRoundRect(q.xz, DISP_HALF, 0.9));
    vec3 scr = texture(uScreen, uv).rgb;
    scr = pow(scr, vec3(2.2)) * uScreenOn * uScreenGain * inside * uGlassScreen;
    col = scr * (1.0 - F) + refl + vec3(0.0008, 0.001, 0.0016);
    col += uRimCol * ggx(gn, v, uRimDir, 0.06) * F * 0.6;
    col += uKeyCol * ggx(gn, v, uKeyDir, 0.08) * F * 0.5;
  } else {
    col = shadeMetal(p, n, v, ao, 0.16, mix(vec3(0.28, 0.29, 0.31), vec3(0.42, 0.36, 0.3), uWarm * 0.3));
  }
  return col;
}

// Out-of-focus lights far behind, and dust in the air, drawn as soft discs.
vec3 background(vec3 ro, vec3 rd, mat3 basis) {
  vec3 col = uBg * (0.25 + 0.75 * sat(rd.y * 0.7 + 0.45));
  float toward = sat(dot(rd, normalize(uRimDir)) * 0.5 + 0.5);
  col += uHazeCol * uHaze * (0.004 + 0.05 * pow(toward, 6.0) + 0.16 * pow(toward, 22.0));
  if (uBokeh > 0.0) {
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      vec3 h = hash33(vec3(fi, fi * 1.7, 3.1));
      vec3 lp = vec3(-140.0 + h.x * 280.0, -90.0 + h.y * 110.0, -160.0 - h.z * 160.0);
      vec3 dl = normalize(lp - ro);
      vec3 cp = transpose(basis) * dl;
      vec3 cr = transpose(basis) * rd;
      if (cp.z <= 0.0) continue;
      vec2 a = cp.xy / cp.z, b = cr.xy / cr.z;
      float rad = 0.016 + 0.026 * h.y * h.y;
      float dd = length(a - b) / rad;
      float disc = smoothstep(1.0, 0.9, dd) * (0.75 + 0.25 * smoothstep(0.5, 0.97, dd));
      vec3 lc = mix(vec3(1.0, 0.55, 0.22), vec3(0.45, 0.6, 1.0), step(0.55, h.z));
      lc = mix(lc, vec3(1.0, 0.75, 0.45), uWarm);
      col += lc * disc * uBokeh * (0.08 + 0.4 * hash11(fi * 9.1) * hash11(fi * 3.3));
    }
  }
  return col;
}

vec3 dust(vec3 ro, vec3 rd, mat3 basis, float tHit) {
  vec3 col = vec3(0.0);
  if (uDust <= 0.0) return col;
  vec3 cr = transpose(basis) * rd;
  for (int i = 0; i < 36; i++) {
    float fi = float(i);
    vec3 h = hash33(vec3(fi * 3.3, fi * 0.7 + 5.0, 1.9));
    vec3 pp = CASE_C + vec3(-14.0 + h.x * 30.0, -4.0 + h.y * 14.0, -12.0 + h.z * 20.0);
    pp += vec3(sin(uTime * 0.13 + fi) * 0.9, sin(uTime * 0.09 + fi * 2.0) * 0.6 + uTime * 0.12, cos(uTime * 0.11 + fi) * 0.7);
    vec3 dl = pp - ro;
    float dist = length(dl);
    if (dist > tHit) continue;
    vec3 cp = transpose(basis) * (dl / dist);
    if (cp.z <= 0.0) continue;
    vec2 a = cp.xy / cp.z, b = cr.xy / cr.z;
    float coc = cocAt(dist, uFocus, uAperture) / uRes.y;
    float rad = 0.0012 + coc * 0.9;
    float dd = length(a - b) / rad;
    float disc = smoothstep(1.0, 0.6, dd);
    float lit = 0.35 + 1.6 * pow(sat(dot(normalize(dl), normalize(uRimDir)) * 0.5 + 0.5), 3.0);
    col += uHazeCol * disc * lit * uDust * (0.0012 / (rad * rad * 900.0 + 0.0012)) * 0.6;
  }
  return col;
}

void main() {
  mat3 basis;
  vec3 ro = uCamPos;
  vec3 rd = camRay(gl_FragCoord.xy, uCamPos, uCamTgt, uFov, uRoll, basis);
  float t = 0.0;
  vec2 h = vec2(0.0);
  bool hit = false;
  for (int i = 0; i < 220; i++) {
    vec3 p = ro + rd * t;
    h = map(p);
    if (h.x < 0.0012 * t) { hit = true; break; }
    t += h.x * 0.85;
    if (t > 400.0) break;
  }
  vec3 col;
  float depth = 3000.0;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, 0.0008 * t + 0.0005);
    vec3 v = -rd;
    float ao = calcAO(p, n);
    float m = h.y;
    if (m < 1.5 || m > 7.5) col = shadeSkin(p, n, v, ao, m);
    else if (m < 2.5) col = shadeFabric(p, n, v, ao);
    else if (m < 3.5) col = shadeBand(p, n, v, ao);
    else if (m < 4.5) col = shadeCase(p, n, v, ao);
    else col = shadeMetal(p, n, v, ao, 0.22, vec3(0.3, 0.31, 0.33));
    depth = t;
    // Haze between the lens and the subject.
    float fogK = 1.0 - exp(-t * 0.0025 * uHaze);
    col = mix(col, uHazeCol * 0.08, fogK * 0.5);
  } else {
    col = background(ro, rd, basis);
  }
  col += dust(ro, rd, basis, hit ? t : 1e4);
  // Forward-scattered rim light in the air, strongest looking toward the light.
  float ph = pow(sat(dot(rd, normalize(uRimDir)) * 0.5 + 0.5), 4.0);
  col += uHazeCol * ph * uHaze * 0.012 * (hit ? sat(t / 80.0) : 0.0);
  float coc = cocAt(depth, uFocus, uAperture) * (depth < uFocus ? -1.0 : 1.0);
  outColor = vec4(col, coc) * uWeight;
}`;
