// GLSL shared by every world: noise, signed distance shapes, camera, light helpers.
export const HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uJitter;
uniform float uWeight;
`;

export const COMMON = `
#define PI 3.14159265
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i.xy + i.z * 17.17), b = hash21(i.xy + vec2(1, 0) + i.z * 17.17);
  float c = hash21(i.xy + vec2(0, 1) + i.z * 17.17), d = hash21(i.xy + vec2(1, 1) + i.z * 17.17);
  float e = hash21(i.xy + (i.z + 1.0) * 17.17), f2 = hash21(i.xy + vec2(1, 0) + (i.z + 1.0) * 17.17);
  float g = hash21(i.xy + vec2(0, 1) + (i.z + 1.0) * 17.17), h = hash21(i.xy + vec2(1, 1) + (i.z + 1.0) * 17.17);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f2, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise3(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }

float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = sat(dot(pa, ba) / dot(ba, ba)); return length(pa - ba * h) - r; }
float sdCapsule2(vec3 p, vec3 a, vec3 b, float ra, float rb) { vec3 pa = p - a, ba = b - a; float h = sat(dot(pa, ba) / dot(ba, ba)); return length(pa - ba * h) - mix(ra, rb, h); }
float sdRoundRect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }
float sdRoundBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
// A rounded rectangle in xz, extruded in y with edges rounded by re.
float sdSlab(vec3 p, vec2 half_, float corner, float halfH, float re) {
  float d2 = sdRoundRect(p.xz, half_ - re, max(corner - re, 0.001));
  vec2 w = vec2(d2, abs(p.y) - (halfH - re));
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - re;
}
float sdEllipse2(vec2 p, vec2 r) { float k0 = length(p / r); return (k0 - 1.0) * min(r.x, r.y); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }

// Camera: a ray for this pixel (with sub-pixel jitter) from pos looking at target, vertical fov in degrees.
vec3 camRay(vec2 fragCoord, vec3 pos, vec3 tgt, float fovDeg, float roll, out mat3 basis) {
  vec3 f = normalize(tgt - pos);
  vec3 up = vec3(sin(roll), cos(roll), 0.0);
  vec3 r = normalize(cross(f, up));
  vec3 u = cross(r, f);
  basis = mat3(r, u, f);
  vec2 p = (fragCoord + uJitter - 0.5 * uRes) / uRes.y;
  float k = tan(radians(fovDeg) * 0.5) * 2.0;
  return normalize(f + (p.x * r + p.y * u) * k);
}
// Circle of confusion in pixels for a point at distance d, with focus distance fd and aperture ap (pixels at infinity).
float cocAt(float d, float fd, float ap) { return clamp(ap * abs(1.0 - fd / max(d, 0.001)), 0.0, 28.0); }

float ggx(vec3 n, vec3 v, vec3 l, float rough) {
  vec3 h = normalize(v + l);
  float a = rough * rough, a2 = a * a;
  float nh = max(dot(n, h), 0.0);
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * d * d);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 0.001);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  return D * G / max(4.0 * nv, 0.001);
}
float fresnel(float cosT, float f0) { return f0 + (1.0 - f0) * pow(1.0 - sat(cosT), 5.0); }
// A soft rectangular light seen in direction rd: centre direction c, right axis r, up axis u, half sizes (angles, radians-ish), softness.
float softbox(vec3 rd, vec3 c, vec3 r, vec3 u, vec2 halfS, float soft) {
  float fz = dot(rd, c);
  if (fz <= 0.0) return 0.0;
  vec2 q = vec2(dot(rd, r), dot(rd, u)) / fz;
  vec2 e = abs(q) - halfS;
  float d = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, d);
}
`;
