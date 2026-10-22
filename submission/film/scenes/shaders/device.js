// Devices in a dark studio, raymarched, units in centimetres:
//   KIND 0  a laptop on a desk in a dark room, a window of night sky behind it
//   KIND 1  a floating display panel over a glossy floor, with a sandbox shell of light around it
//   KIND 2  a phone standing over a glossy floor
// The screen shows uScreen (a canvas or footage); uScreenB and uScreenMix crossfade a timelapse.
import { HEADER, COMMON } from "./common.js";

function device(kind) {
  return HEADER + `#define KIND ${kind}\n` + COMMON + `
uniform vec3 uCamPos, uCamTgt;
uniform float uFov, uRoll, uFocus, uAperture;
uniform sampler2D uScreen, uScreenB;
uniform float uScreenMix, uScreenOn, uScreenGain;
uniform vec4 uCrop;            // the part of the screen texture shown: u0, v0, u1, v1
uniform vec3 uScreenAvg;       // its average colour, for the light it casts
uniform vec3 uRot;             // device yaw, pitch, roll (radians)
uniform vec3 uPos;             // device centre
uniform vec3 uRimDir, uRimCol, uKeyDir, uKeyCol, uBg, uGlowCol;
uniform float uGlow, uShell, uShellSweep, uFloorRefl, uDust, uMoon;
uniform float uLidAngle;
uniform float uWipe;          // > -1: show uScreenB below this display height (0..1), uScreen above it
uniform vec3 uStripCol;        // two tall strip lights left and right of the device (edge highlights)
uniform vec3 uBackCol;         // a soft glow on the backdrop behind the device
uniform float uBackSize;
uniform float uSheen, uSheenPos; // a soft band of light that sweeps across the glass
uniform vec3 uShellPad;        // the sandbox boundary's distance from the panel (cm)
uniform float uFingerOn;
uniform vec3 uFingerTip, uFingerDir, uFingerBend;

#if KIND == 0
const vec3 HALF = vec3(15.2, 0.0, 10.6);
const vec2 DISP = vec2(13.6, 8.6);
#elif KIND == 1
// The panel takes the size of the footage it shows (the hero card grows when the app goes live).
uniform vec3 uHalfP;
uniform vec2 uDispP;
#define HALF uHalfP
#define DISP uDispP
#else
const vec3 HALF = vec3(3.6, 7.45, 0.42);
const vec2 DISP = vec2(3.35, 7.25);
#endif

mat3 devRot() { return rotY(uRot.x) * rotX(uRot.y) * rotZ(uRot.z); }

// Local frames. Panel/phone: x right, y up, z out of the screen.
vec3 toLocal(vec3 p) { return transpose(devRot()) * (p - uPos); }

#if KIND == 0
// The laptop: base on the desk (y = 0), lid hinged at the back edge.
vec3 lidLocal(vec3 q) {
  // Lid space: x across, z up the lid from the hinge, y through its thickness (the screen is the -y face).
  vec3 h = q - vec3(0.0, 1.55, -HALF.z + 0.35);
  float c = cos(uLidAngle), s = sin(uLidAngle);
  return vec3(h.x, c * h.y - s * h.z, s * h.y + c * h.z);
}
const float LID_L = 19.5;
#endif

float sdFinger(vec3 p) {
  if (uFingerOn < 0.5) return 1e5;
  vec3 d1 = uFingerDir;
  vec3 d2 = normalize(d1 + uFingerBend * 0.3);
  vec3 a = uFingerTip + d1 * 0.62;
  vec3 b = a + d1 * 1.9;
  vec3 c = b + d2 * 2.7;
  vec3 e = c + d2 * 5.0;
  float d = sdCapsule2(p, a, b, 0.66, 0.74);
  d = smin(d, sdCapsule2(p, b, c, 0.76, 0.84), 0.3);
  d = smin(d, sdCapsule2(p, c, e, 0.86, 1.02), 0.3);
  d = smin(d, length(p - (e + d2 * 3.2)) - 3.4, 1.8);
  return d;
}

vec2 map(vec3 p) {
  vec2 res = vec2(1e5, 0.0);
#if KIND == 0
  vec3 q = toLocal(p);
  float base = sdRoundBox(q - vec3(0.0, 0.78, 0.0), vec3(HALF.x, 0.78, HALF.z), 0.7);
  res = vec2(base, 1.0);
  vec3 l = lidLocal(q);
  float lid = sdRoundBox(l - vec3(0.0, 0.3, LID_L * 0.5), vec3(HALF.x, 0.3, LID_L * 0.5), 0.55);
  if (lid < res.x) res = vec2(lid, 2.0);
  float desk = p.y + 0.0;
  if (desk < res.x) res = vec2(desk, 4.0);
#elif KIND == 1
  vec3 q = toLocal(p);
  float panel = sdRoundBox(q, HALF, 1.4);
  res = vec2(panel, 2.0);
  float flo = p.y;
  if (flo < res.x) res = vec2(flo, 5.0);
#else
  vec3 q = toLocal(p);
  float phone = length(max(vec2(sdRoundRect(q.xy, HALF.xy - 0.34, 0.95), abs(q.z) - HALF.z + 0.34), 0.0)) + min(max(sdRoundRect(q.xy, HALF.xy - 0.34, 0.95), abs(q.z) - HALF.z + 0.34), 0.0) - 0.34;
  res = vec2(phone, 2.0);
  float flo = p.y;
  if (flo < res.x) res = vec2(flo, 5.0);
  float fi = sdFinger(p);
  if (fi < res.x) res = vec2(fi, 3.0);
#endif
  return res;
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1, -1);
  float e = 0.002;
  return normalize(k.xyy * map(p + k.xyy * e).x + k.yyx * map(p + k.yyx * e).x + k.yxy * map(p + k.yxy * e).x + k.xxx * map(p + k.xxx * e).x);
}

vec3 env(vec3 rd, float rough) {
  float soft = 0.05 + rough * 0.9;
  vec3 c = uBg * (0.4 + 0.6 * sat(rd.y * 0.5 + 0.5));
  vec3 rc = normalize(uRimDir);
  vec3 rr = normalize(cross(rc, vec3(0, 1, 0)));
  vec3 ru = cross(rr, rc);
  c += uRimCol * 0.7 * softbox(rd, rc, rr, ru, vec2(1.2, 0.18), soft);
  vec3 kc = normalize(uKeyDir);
  vec3 kr = normalize(cross(kc, vec3(0, 1, 0)));
  vec3 ku = cross(kr, kc);
  c += uKeyCol * 1.2 * softbox(rd, kc, kr, ku, vec2(0.15, 0.8), soft);
  if (uStripCol.r + uStripCol.g + uStripCol.b > 0.0) {
    mat3 R0 = devRot();
    for (int s = -1; s <= 1; s += 2) {
      vec3 sc = normalize(R0 * vec3(float(s) * 1.0, 0.12, -0.32));
      vec3 sr = normalize(cross(sc, vec3(0, 1, 0)));
      vec3 su = cross(sr, sc);
      c += uStripCol * softbox(rd, sc, sr, su, vec2(0.1, 1.4), soft * 0.7);
    }
    // A broad soft light overhead and in front, for the long reflection down the glass.
    vec3 tc = normalize(R0 * vec3(0.25, 0.75, 0.6));
    vec3 tr = normalize(cross(tc, vec3(0, 0, 1) + vec3(0.001)));
    vec3 tu = cross(tr, tc);
    c += uStripCol * 0.22 * softbox(rd, tc, tr, tu, vec2(0.5, 0.25), soft + 0.15);
  }
  return c;
}

// The screen, in its own 0..1 coordinates (u right, v up).
vec3 screenAt(vec2 uv, float lod) {
  vec2 t = mix(uCrop.xy, uCrop.zw, uv);
  vec3 a = textureLod(uScreen, t, lod).rgb;
  vec3 b = textureLod(uScreenB, t, lod).rgb;
  float k = uWipe > -1.0 ? smoothstep(uWipe + 0.012, uWipe - 0.012, uv.y) : uScreenMix;
  vec3 c = mix(a, b, k);
  // The wipe's edge glows.
  if (uWipe > -1.0) c += vec3(0.5, 0.6, 1.0) * exp(-pow((uv.y - uWipe) * 90.0, 2.0)) * 0.9;
  return pow(c, vec3(2.2)) * uScreenGain * uScreenOn;
}

// Where a point on the device's front face falls on the display, and whether it is inside it.
bool displayUV(vec3 p, out vec2 uv, out float inside) {
#if KIND == 0
  vec3 l = lidLocal(toLocal(p));
  vec2 c = vec2(l.x, l.z - LID_L * 0.5 - 0.3);
  uv = c / (2.0 * DISP) + 0.5;
  inside = 1.0 - smoothstep(-0.05, 0.05, sdRoundRect(c, DISP, 0.5));
  return l.y < 0.12 && l.y > -0.25 && l.z > 0.2 && l.z < LID_L + 0.3 && abs(l.x) < HALF.x + 0.3;
#elif KIND == 1
  vec3 q = toLocal(p);
  uv = q.xy / (2.0 * DISP) + 0.5;
  inside = 1.0 - smoothstep(-0.05, 0.05, sdRoundRect(q.xy, DISP, 0.6));
  return q.z > HALF.z - 0.2;
#else
  vec3 q = toLocal(p);
  uv = q.xy / (2.0 * DISP) + 0.5;
  inside = 1.0 - smoothstep(-0.03, 0.03, sdRoundRect(q.xy, DISP, 1.05));
  return q.z > HALF.z - 0.12;
#endif
}

// Light the screen casts on a point (a few samples across the display).
vec3 screenLight(vec3 p, vec3 n) {
  vec3 acc = vec3(0.0);
  mat3 R = devRot();
#if KIND == 0
  vec3 sn = vec3(0.0, sin(uLidAngle - 1.5708), cos(uLidAngle - 1.5708));
#else
  vec3 sn = R * vec3(0, 0, 1);
#endif
  for (int i = -1; i <= 1; i++) {
#if KIND == 0
    vec3 sp = uPos + vec3(float(i) * 9.0, 1.55 + sin(uLidAngle) * 9.75, -HALF.z + 0.35 + cos(uLidAngle) * 9.75) + sn * 0.5;
#else
    vec3 sp = uPos + R * vec3(float(i) * DISP.x * 0.6, 0.0, HALF.z + 0.5);
#endif
    vec3 d = sp - p;
    float l2 = dot(d, d);
    vec3 L = d * inversesqrt(l2);
    float emit = sat(dot(-L, sn));
    acc += uScreenAvg * uScreenOn * sat(dot(n, L)) * emit / (1.0 + l2 * 0.004);
  }
  return acc * 0.33 * uGlow;
}

float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.05;
  for (int i = 0; i < 40; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.05, 3.0);
    if (res < 0.003 || t > 120.0) break;
  }
  return sat(res);
}

vec3 shadeDevice(vec3 p, vec3 n, vec3 v, float m) {
  vec2 uv;
  float inside;
  bool face = displayUV(p, uv, inside);
  vec3 r = reflect(-v, n);
  float nv = max(dot(n, v), 0.0);
  if (face) {
    // Glass over the display: the picture, a black border, and a faint reflection.
    float F = fresnel(nv, 0.04);
    vec3 pic = inside > 0.0 ? screenAt(uv, 0.0) * inside : vec3(0.0);
    float band = exp(-pow((uv.x * 0.75 + uv.y * 0.66 - uSheenPos) * 4.2, 2.0)) + 0.35 * exp(-pow((uv.x * 0.75 + uv.y * 0.66 - uSheenPos - 0.16) * 11.0, 2.0));
    return pic * (1.0 - F) + env(r, 0.03) * F + vec3(0.0006, 0.0007, 0.001) + vec3(0.85, 0.9, 1.0) * band * uSheen * 0.05;
  }
  // Anodised aluminium / titanium body.
  vec3 f0 = vec3(0.55, 0.56, 0.58);
  float rough = 0.28;
#if KIND == 2
  f0 = vec3(0.58, 0.59, 0.62);
  rough = 0.22;
#elif KIND == 0
  f0 = vec3(0.2, 0.205, 0.215);
  rough = 0.42;
#endif
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0);
  vec3 col = env(r, rough) * F;
  col += uRimCol * ggx(n, v, uRimDir, rough) * F * 0.6;
  col += uKeyCol * ggx(n, v, uKeyDir, rough) * F * 0.5;
  col += screenLight(p, n) * 0.25 * F;
  vec3 albedo = vec3(0.05);
  col += albedo * (uRimCol * sat(dot(n, uRimDir)) + uKeyCol * sat(dot(n, uKeyDir)));
#if KIND == 0
  // A faint keyboard pattern on the base, lit by the screen.
  vec3 q = toLocal(p);
  if (m < 1.5 && n.y > 0.9) {
    vec2 kp = q.xz - vec2(0.0, -1.5);
    vec2 cell = fract(kp / vec2(1.85, 1.85)) - 0.5;
    float key = step(abs(kp.x), 12.5) * step(abs(kp.y + 0.5), 5.4);
    float gap = smoothstep(0.38, 0.44, max(abs(cell.x), abs(cell.y)));
    col *= mix(1.0, mix(0.06, 0.8, gap), key);
    float pad = step(abs(q.x), 5.5) * step(abs(q.z - 6.6), 2.9);
    col *= mix(1.0, 0.8, pad);
  }
#endif
  return col;
}

vec3 background(vec3 ro, vec3 rd) {
  vec3 col = uBg * (0.35 + 0.65 * sat(rd.y * 0.8 + 0.4));
  if (uBackSize > 0.0) {
    vec3 toward = normalize(uPos + vec3(0.0, 2.0, 0.0) - ro);
    float a = acos(clamp(dot(rd, toward), -1.0, 1.0));
    col += uBackCol * (exp(-a * a / (uBackSize * uBackSize)) + 0.25 * exp(-a / (uBackSize * 2.5)));
  }
#if KIND == 0
  // A window far behind: night sky in its panes, with a moon glow; it will be out of focus.
  if (rd.z < -0.05) {
    float t = (-260.0 - ro.z) / rd.z;
    vec3 wp = ro + rd * t;
    vec2 w = wp.xy - vec2(95.0, 40.0);
    float win = 1.0 - smoothstep(-2.0, 2.0, sdRoundRect(w, vec2(48.0, 40.0), 2.0));
    float bars = smoothstep(1.5, 3.5, abs(w.x)) * smoothstep(1.5, 3.5, abs(w.y + 4.0));
    vec3 sky = mix(vec3(0.02, 0.035, 0.1), vec3(0.05, 0.08, 0.22), sat(w.y / 120.0 + 0.5));
    sky += vec3(0.25, 0.3, 0.45) * exp(-dot(w - vec2(20.0, 20.0), w - vec2(20.0, 20.0)) / 300.0) * uMoon;
    vec2 sc = floor(w * 0.6);
    float st = step(0.985, hash21(sc)) * hash21(sc + 3.0);
    sky += vec3(0.6, 0.7, 1.0) * st * 0.5;
    col = mix(col, sky * uMoon, win * bars);
  }
#endif
  return col;
}

#if KIND == 1
// The sandbox: a box of light around the panel. Its faces have a faint sheen, its edges glow, and it
// is built from the floor up (uShellSweep, in cm of height) with a bright line where it is forming.
vec3 shellLight(vec3 ro, vec3 rd, float tMax) {
  vec3 B = HALF + uShellPad;
  float R = 0.7;
  mat3 Rt = transpose(devRot());
  vec3 o = Rt * (ro - uPos), d = Rt * rd;
  vec3 acc = vec3(0.0);
  float t = 0.0;
  bool inside = sdRoundBox(o, B, R) < 0.0;
  for (int hitN = 0; hitN < 2; hitN++) {
    bool found = false;
    for (int i = 0; i < 90; i++) {
      vec3 q = o + d * t;
      float sd = sdRoundBox(q, B, R);
      float dd = inside ? -sd : sd;
      if (dd < 0.01) { found = true; break; }
      t += max(dd, 0.02);
      if (t > tMax) break;
    }
    if (!found || t > tMax) break;
    vec3 q = o + d * t;
    vec3 a = B - abs(q);
    float m1 = min(a.x, min(a.y, a.z)), m3 = max(a.x, max(a.y, a.z));
    float m2 = a.x + a.y + a.z - m1 - m3;
    float edge = exp(-max(m2 - R * 0.2, 0.0) * 16.0);
    vec2 e = vec2(0.001, 0.0);
    vec3 n = normalize(vec3(sdRoundBox(q + e.xyy, B, R) - sdRoundBox(q - e.xyy, B, R), sdRoundBox(q + e.yxy, B, R) - sdRoundBox(q - e.yxy, B, R), sdRoundBox(q + e.yyx, B, R) - sdRoundBox(q - e.yyx, B, R)));
    float fr = pow(1.0 - abs(dot(n, d)), 3.0);
    float level = q.y + B.y;
    float shown = smoothstep(uShellSweep + 0.5, uShellSweep - 3.0, level);
    float scan = exp(-pow((level - uShellSweep) * 1.1, 2.0)) * step(uShellSweep, 2.0 * B.y + 2.0);
    float grid = 0.5 + 0.5 * smoothstep(0.92, 1.0, max(abs(sin(q.x * 0.42)), abs(sin(q.y * 0.42 + q.z * 0.42))));
    acc += uGlowCol * (edge * 1.6 + fr * 0.008 + 0.003 * grid) * shown + uGlowCol * scan * 0.7;
    inside = !inside;
    t += 0.05;
  }
  return acc;
}
#endif

void main() {
  mat3 basis;
  vec3 ro = uCamPos;
  vec3 rd = camRay(gl_FragCoord.xy, uCamPos, uCamTgt, uFov, uRoll, basis);
  float t = 0.0;
  vec2 h = vec2(0.0);
  bool hit = false;
  for (int i = 0; i < 200; i++) {
    vec3 p = ro + rd * t;
    h = map(p);
    if (h.x < 0.0015 * t) { hit = true; break; }
    t += h.x * 0.85;
    if (t > 900.0) break;
  }
  vec3 col = vec3(0.0);
  float depth = 5000.0;
  if (hit) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    vec3 v = -rd;
    depth = t;
    float m = h.y;
    if (m > 2.5 && m < 3.5) {
      // A fingertip: skin in the dark, lit by the screen and the rims.
      vec3 alb = vec3(0.36, 0.22, 0.16);
      float nv = max(dot(n, v), 0.0);
      vec3 w = vec3(0.32, 0.17, 0.12);
      col = alb * (screenLight(p, n) * 2.2 + uStripCol * 0.25 * sat3((vec3(dot(n, normalize(devRot() * vec3(1, 0.1, -0.3)))) + w) / (1.0 + w)) + uKeyCol * sat(dot(n, uKeyDir)) * 0.6);
      col += uStripCol * pow(1.0 - nv, 3.0) * 0.18 * vec3(1.0, 0.85, 0.78);
      col += uRimCol * pow(1.0 - nv, 4.0) * sat(dot(n, uRimDir) + 0.3) * 0.25 * vec3(1.0, 0.85, 0.78);
    } else if (m > 3.5) {
      // Floor or desk: dark, glossy; it reflects the device and the screen lights it.
#if KIND == 0
      vec3 alb = vec3(0.09, 0.055, 0.035) * (0.7 + 0.6 * fbm(vec2(p.x * 0.05, p.z * 0.6)));
      float gloss = 0.35;
#else
      vec3 alb = vec3(0.012, 0.013, 0.016);
      float gloss = uFloorRefl;
#endif
      vec3 lit = screenLight(p, n) + uRimCol * 0.02 * sat(dot(n, uRimDir)) + uKeyCol * 0.03;
      col = alb * lit * 2.0;
      // One reflected ray.
      vec3 r = reflect(rd, n);
      vec3 ro2 = p + n * 0.02;
      float t2 = 0.0;
      bool hit2 = false;
      vec2 h2;
      for (int i = 0; i < 90; i++) {
        h2 = map(ro2 + r * t2);
        if (h2.x < 0.002 * (t2 + 1.0)) { hit2 = true; break; }
        t2 += h2.x * 0.9;
        if (t2 > 400.0) break;
      }
      float F = fresnel(max(dot(n, v), 0.0), 0.06);
      vec3 rc = background(ro2, r);
      if (hit2 && h2.y < 3.5) {
        vec3 p2 = ro2 + r * t2;
        vec2 uv;
        float inside;
        if (displayUV(p2, uv, inside)) rc = screenAt(uv, clamp(1.5 + t2 * 0.22, 0.0, 7.0)) * inside * 0.9;
        else rc = env(r, 0.3) * 0.3;
        rc *= exp(-t2 * 0.045);
      }
      col += rc * mix(F, 0.35, gloss) * gloss * 0.55 * (1.0 - 0.75 * uShell);
    } else {
      col = shadeDevice(p, n, v, m);
    }
  } else {
    col = background(ro, rd);
  }
#if KIND == 1
  if (uShell > 0.0) col += shellLight(ro, rd, hit ? depth : 2000.0) * uShell;
#endif
  // A soft volumetric glow of the screen's light in the air.
  col += uScreenAvg * uScreenOn * uGlow * 0.004 * exp(-length(cross(rd, uPos - ro)) * 0.03);
  float coc = cocAt(depth, uFocus, uAperture) * (depth < uFocus ? -1.0 : 1.0);
  outColor = vec4(col, coc) * uWeight;
}`;
}

export const LAPTOP = device(0);
export const PANEL = device(1);
export const PHONE = device(2);
