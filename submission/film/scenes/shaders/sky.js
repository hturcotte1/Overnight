// The sky: a night of stars over a far ridge, and the same sky at sunrise. Analytic; no geometry.
import { HEADER, COMMON } from "./common.js";

export const SKY = HEADER + COMMON + `
uniform float uPitch, uYaw, uFov, uRoll;
uniform float uSunElev, uSunAz;   // degrees
uniform float uDawn;              // 0 deep night .. 1 full sunrise
uniform float uStars;             // star brightness
uniform float uCloud;             // cloud cover amount
uniform float uRays;              // crepuscular rays
uniform float uExposureSky;

vec3 dirFrom(float az, float el) { return vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el)); }

float ridge(float az) {
  float h = 0.02 + 0.075 * pow(fbm(vec2(az * 1.6, 3.1)), 1.5) + 0.018 * fbm(vec2(az * 9.0, 9.4));
  return h - 0.03;
}

vec3 stars(vec3 rd) {
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 3; layer++) {
    float sc = 90.0 + float(layer) * 70.0;
    vec3 p = rd * sc;
    vec3 c = floor(p);
    vec3 f = fract(p) - 0.5;
    vec3 h = hash33(c + float(layer) * 31.7);
    if (h.x > 0.9) {
      vec3 off = (hash33(c * 1.7 + 4.0) - 0.5) * 0.7;
      float d = length(f - off);
      float size = 0.07 + 0.1 * pow(h.y, 5.0);
      float tw = 0.75 + 0.25 * sin(uTime * (1.5 + h.z * 3.0) + h.y * 40.0);
      float b = pow(h.z, 4.0) * 9.0 + 0.35;
      vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.7), h.y);
      col += tint * b * tw * exp(-d * d / (size * size) * 3.0) * (1.0 - float(layer) * 0.3);
    }
  }
  return col;
}

void main() {
  vec2 p = (gl_FragCoord.xy + uJitter - 0.5 * uRes) / uRes.y;
  float k = tan(radians(uFov) * 0.5) * 2.0;
  vec3 f = dirFrom(radians(uYaw), radians(uPitch));
  vec3 r = normalize(cross(f, vec3(sin(uRoll), cos(uRoll), 0.0)));
  vec3 u = cross(r, f);
  vec3 rd = normalize(f + (p.x * r + p.y * u) * k);

  vec3 sun = dirFrom(radians(uSunAz), radians(uSunElev));
  float sd = max(dot(rd, sun), 0.0);
  float el = asin(clamp(rd.y, -1.0, 1.0));
  float az = atan(rd.x, -rd.z);

  // Night sky: deep navy, lighter toward the horizon.
  float hz = exp(-max(el, 0.0) * 5.0);
  vec3 night = mix(vec3(0.0016, 0.0024, 0.009), vec3(0.008, 0.013, 0.04), hz);
  // Dawn sky: blue overhead, gold and rose at the horizon, brightest near the sun.
  vec3 zen = vec3(0.025, 0.045, 0.13);
  vec3 hor = mix(vec3(0.55, 0.2, 0.2), vec3(1.25, 0.5, 0.16), pow(sd, 3.0));
  vec3 dawn = mix(zen, hor, pow(hz, 1.1));
  dawn += vec3(1.6, 0.75, 0.3) * pow(sd, 14.0) * 0.8 + vec3(2.4, 1.2, 0.5) * pow(sd, 120.0) * 1.6;
  vec3 col = mix(night, dawn, uDawn);

  // The Milky Way: a soft band of light and dust.
  vec3 bandN = normalize(vec3(0.35, 0.55, 0.75));
  float bd = dot(rd, bandN);
  float band = exp(-bd * bd * 22.0);
  float mw = band * (0.35 + 0.65 * fbm(rd.xy * 6.0 + rd.z * 3.0)) * (1.0 - 0.7 * smoothstep(0.45, 0.8, fbm(rd.yz * 9.0 + 2.0)) * band);
  col += vec3(0.06, 0.07, 0.12) * mw * uStars * (1.0 - uDawn) * 1.3;
  col += stars(rd) * uStars * (1.0 - smoothstep(0.0, 0.7, uDawn)) * smoothstep(-0.02, 0.06, el);

  // The sun's disc.
  col += vec3(30.0, 18.0, 9.0) * smoothstep(0.99985, 0.99993, dot(rd, sun)) * uDawn;

  // Clouds: a thin deck, dark at night with a silver edge, lit gold and rose from below at sunrise.
  if (rd.y > 0.0 && uCloud > 0.0) {
    vec2 cp = rd.xz / (rd.y + 0.08) * 1.4 + vec2(uTime * 0.012, 0.0);
    float c = fbm(cp * 1.3) * 0.65 + fbm(cp * 3.7 + 5.0) * 0.35;
    float dens = smoothstep(0.5, 0.78, c) * uCloud * smoothstep(0.0, 0.12, rd.y) * (1.0 - smoothstep(0.55, 0.95, rd.y));
    vec3 cn = vec3(0.012, 0.016, 0.035) + vec3(0.03, 0.04, 0.07) * smoothstep(0.6, 0.9, c);
    vec3 cd = mix(vec3(0.6, 0.3, 0.32), vec3(2.4, 1.1, 0.45), pow(sd, 4.0)) * (0.55 + 0.6 * (1.0 - smoothstep(0.55, 0.85, c)));
    col = mix(col, mix(cn, cd, uDawn), dens * 0.9);
  }

  // Crepuscular rays fanning out from the sun.
  if (uRays > 0.0) {
    vec3 sr = normalize(cross(sun, vec3(0, 1, 0)));
    vec3 su = cross(sr, sun);
    float ang = atan(dot(rd, su), dot(rd, sr));
    float rays = fbm(vec2(ang * 9.0, 1.3)) * 0.7 + fbm(vec2(ang * 23.0, 7.7)) * 0.3;
    rays = smoothstep(0.35, 0.8, rays);
    col += vec3(1.2, 0.6, 0.25) * rays * pow(sd, 8.0) * uRays * 0.7 * smoothstep(-0.05, 0.05, el);
  }

  // The far ridge: a silhouette, with a thin rim of light at sunrise.
  float rh = ridge(az);
  if (el < rh) {
    float depthK = sat((rh - el) * 20.0);
    vec3 land = mix(vec3(0.0006, 0.0008, 0.002), vec3(0.02, 0.012, 0.012), uDawn);
    land += vec3(1.6, 0.8, 0.35) * uDawn * exp(-(rh - el) * 260.0) * pow(sd, 2.0) * 0.6;
    col = mix(col, land, smoothstep(0.0, 0.002, rh - el));
    col *= mix(1.0, 0.7, depthK);
  }
  // A low haze at the horizon line.
  col += mix(vec3(0.006, 0.01, 0.03), vec3(0.9, 0.5, 0.25) * (0.4 + pow(sd, 3.0)), uDawn) * exp(-abs(el - rh) * 40.0) * 0.35;

  col *= uExposureSky;
  outColor = vec4(col, 0.0) * uWeight;
}`;
