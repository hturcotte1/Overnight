// Light for the brand half of the film.
//   RAYS: a wordmark (a mask texture) revealed by light from behind: crepuscular rays round the
//         letters, a lit fill, an anamorphic flare line.
//   ATMOS: a deep backdrop: a soft coloured glow that can move, slow nebula, drifting motes.
import { HEADER, COMMON } from "./common.js";

export const RAYS = HEADER + COMMON + `
uniform sampler2D uMask;       // white letters on black, full frame
uniform vec2 uLight;           // light centre (0..1 frame coords)
uniform float uBack;           // light behind the letters
uniform float uRayAmt;         // length/strength of the rays
uniform float uFill;           // light on the letters' faces
uniform float uEdge;           // rim on the letters
uniform float uFlare;          // the anamorphic line
uniform float uSweep;          // a band of light that sweeps across the letters (0..1 position)
uniform vec3 uWarm, uCool;
uniform float uBgGlow;

float maskAt(vec2 uv) { return textureLod(uMask, uv, 0.0).r; }

vec3 source(vec2 uv) {
  vec2 d = (uv - uLight) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(d * vec2(0.42, 1.35));
  vec3 c = mix(uWarm, uCool, smoothstep(0.0, 0.35, r));
  return c * (exp(-r * r * 60.0) * 2.4 + exp(-r * 7.0) * 0.28) * uBack;
}

void main() {
  vec2 uv = (gl_FragCoord.xy + uJitter) / uRes;
  float m = maskAt(uv);
  // Rays: march toward the light, adding what the letters do not hide.
  vec3 rays = vec3(0.0);
  vec2 delta = (uv - uLight) * (uRayAmt / 72.0);
  vec2 p = uv;
  float decay = 1.0;
  p -= delta * hash21(gl_FragCoord.xy + uTime * 60.0);
  for (int i = 0; i < 72; i++) {
    p -= delta;
    rays += source(p) * (1.0 - maskAt(p)) * decay;
    decay *= 0.962;
  }
  rays *= 1.0 / 30.0;
  vec3 col = source(uv) * (1.0 - m) * 0.4 + rays * (1.0 - m);
  // The letters: dark against the light with a fine rim, then lit from the front.
  // The rim is fine (about two pixels) and gives way once the faces are lit, so the resting wordmark is sharp.
  float soft = textureLod(uMask, uv, 1.0).r * 0.8 + textureLod(uMask, uv, 2.0).r * 0.2;
  float edge = sat((soft - m) * 4.0);
  col += mix(uCool, vec3(1.0), 0.55) * edge * uEdge * 0.9 * (0.3 + uBack) * (1.0 - 0.85 * sat(uFill));
  vec3 face = mix(vec3(1.0, 0.9, 0.78), vec3(0.9, 0.93, 1.0), sat(uv.y * 2.2 - 0.6));
  // The crescent mark is drawn into the mask with no blue: it lights amber, like the dashboard's logo.
  float markK = sat((textureLod(uMask, uv, 0.0).r - textureLod(uMask, uv, 0.0).b) * 2.0);
  face = mix(face, vec3(1.0, 0.62, 0.16) * 1.15, markK);
  float sweepBand = exp(-pow((uv.x - uSweep) * 6.0, 2.0)) * (1.0 - smoothstep(0.85, 1.0, uSweep));
  vec3 lit = face * (1.4 * uFill + sweepBand * 2.2 * uFill);
  col = mix(col, lit, m * sat(uFill * 1.2));
  // Anamorphic flare: a thin horizontal line through the light.
  float fy = abs(uv.y - uLight.y) * uRes.y;
  float fl = exp(-fy * fy / 10.0) * exp(-abs(uv.x - uLight.x) * 2.6);
  col += mix(uCool, vec3(1.0), 0.4) * fl * uFlare * 5.0;
  col += uCool * exp(-fy / 50.0) * exp(-abs(uv.x - uLight.x) * 2.0) * uFlare * 0.18;
  col += uCool * uBgGlow * 0.012 * exp(-length((uv - 0.5) * vec2(1.6, 2.4)) * 2.0);
  outColor = vec4(col, 0.0) * uWeight;
}`;

export const ATMOS = HEADER + COMMON + `
uniform vec2 uGlowPos;     // 0..1
uniform vec3 uGlowCol, uGlowCol2;
uniform float uGlowAmt, uGlowSize, uNebula, uMotes, uCamX, uFloorLine;
uniform vec3 uBase;

void main() {
  vec2 uv = (gl_FragCoord.xy + uJitter) / uRes;
  vec2 a = vec2(uRes.x / uRes.y, 1.0);
  vec2 d = (uv - uGlowPos) * a;
  float r = length(d * vec2(0.8, 1.2));
  vec3 col = uBase * (0.6 + 0.6 * uv.y);
  col += mix(uGlowCol, uGlowCol2, smoothstep(0.0, uGlowSize * 2.0, r)) * (exp(-r * r / (uGlowSize * uGlowSize)) * 0.9 + exp(-r / uGlowSize * 1.2) * 0.25) * uGlowAmt;
  // Slow nebula: large soft structures, very low contrast.
  if (uNebula > 0.0) {
    vec2 q = uv * a * 1.4 + vec2(uCamX * 0.15 + uTime * 0.008, uTime * 0.004);
    float n = fbm(q * 1.2 + fbm(q * 0.8 + 3.0) * 0.8);
    col += mix(uGlowCol, uGlowCol2, n) * pow(n, 3.0) * uNebula * 0.12;
  }
  // Motes in two depths, drifting with the camera.
  if (uMotes > 0.0) {
    for (int layer = 0; layer < 2; layer++) {
      float depth = layer == 0 ? 0.35 : 1.0;
      vec2 q = (uv * a + vec2(uCamX * depth * 0.6, uTime * 0.01 * depth)) * (layer == 0 ? 7.0 : 14.0);
      vec2 c = floor(q);
      vec2 f = fract(q) - 0.5;
      vec2 h = hash22(c + float(layer) * 9.1);
      if (h.x > 0.72) {
        vec2 o = (hash22(c * 1.3 + 2.0) - 0.5) * 0.6;
        float s = layer == 0 ? 0.09 : 0.04;
        float b = smoothstep(s, 0.0, length(f - o)) * (0.4 + 0.6 * h.y);
        col += mix(uGlowCol, vec3(1.0), 0.5) * b * uMotes * (layer == 0 ? 0.06 : 0.1);
      }
    }
  }
  // A faint horizon line of light (a stage floor), if asked.
  if (uFloorLine > 0.0) {
    float y = abs(uv.y - 0.36) * uRes.y;
    col += uGlowCol * exp(-y * y / 30.0) * exp(-abs(uv.x - 0.5) * 3.0) * uFloorLine * 0.3;
  }
  outColor = vec4(col, 0.0) * uWeight;
}`;

// PLATE: a painted canvas (the silhouette, the idea card) put through the same lens as the 3D worlds:
// it is read as display colour, turned to linear light at uGain, and given a circle of confusion.
export const PLATE = HEADER + COMMON + `
uniform sampler2D uPlate;
uniform float uGain, uCoc;
void main() {
  vec2 uv = (gl_FragCoord.xy + uJitter) / uRes;
  vec3 c = texture(uPlate, uv).rgb;
  c = pow(c, vec3(2.2)) * uGain;
  outColor = vec4(c, uCoc) * uWeight;
}`;
