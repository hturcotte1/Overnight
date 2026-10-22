// Easing and keyframes. Pure functions of time.
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
export const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
export const smoother = (x) => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
export const inOutCubic = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const inOutSine = (x) => { x = clamp(x); return -(Math.cos(Math.PI * x) - 1) / 2; };
export const outCubic = (x) => { x = clamp(x); return 1 - Math.pow(1 - x, 3); };
export const outQuart = (x) => { x = clamp(x); return 1 - Math.pow(1 - x, 4); };
export const outExpo = (x) => { x = clamp(x); return x === 1 ? 1 : 1 - Math.pow(2, -10 * x); };
export const inCubic = (x) => { x = clamp(x); return x * x * x; };
export const inQuad = (x) => { x = clamp(x); return x * x; };
export const inExpo = (x) => { x = clamp(x); return x === 0 ? 0 : Math.pow(2, 10 * x - 10); };
/** 0 before a, 1 after b, eased between. */
export const ramp = (t, a, b, e = smooth) => e((t - a) / (b - a));
/** Fades in over [a, a+fi], holds, fades out over [b-fo, b]. */
export const window_ = (t, a, b, fi = 0.5, fo = 0.5, e = smooth) => Math.min(ramp(t, a, a + fi, e), 1 - ramp(t, b - fo, b, e));

/** Keyframes [[time, value], ...]; value a number or an array. Eased between neighbours. */
export function keys(t, ks, e = inOutSine) {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 0; i < ks.length - 1; i++) {
    const [t0, v0] = ks[i];
    const [t1, v1] = ks[i + 1];
    if (t <= t1) {
      const k = e((t - t0) / (t1 - t0));
      return Array.isArray(v0) ? v0.map((v, j) => lerp(v, v1[j], k)) : lerp(v0, v1, k);
    }
  }
  return ks[ks.length - 1][1];
}

/** A smooth path through points (Catmull-Rom), param u in [0,1] spread evenly over the points. */
export function spline(u, pts) {
  const n = pts.length - 1;
  const x = clamp(u) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  return p1.map((_, j) => {
    const a = p0[j], b = p1[j], c = p2[j], d = p3[j];
    return 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
  });
}

export const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const scale = (a, k) => a.map((x) => x * k);

/** A deterministic pseudo-random number for an integer seed. */
export function rand(seed) {
  let x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Keyframes [[time, value], ...] passed through smoothly (Catmull-Rom), so a camera keeps moving
 * through each key instead of stopping at it. Values are numbers or arrays.
 */
export function flowKeys(t, ks) {
  if (t <= ks[0][0]) return ks[0][1];
  const n = ks.length - 1;
  if (t >= ks[n][0]) return ks[n][1];
  let i = 0;
  while (i < n - 1 && t > ks[i + 1][0]) i++;
  const f = (t - ks[i][0]) / (ks[i + 1][0] - ks[i][0]);
  const get = (j) => ks[Math.max(0, Math.min(n, j))][1];
  const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
  const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
  return Array.isArray(p1) ? p1.map((_, j) => cr(p0[j], p1[j], p2[j], p3[j])) : cr(p0, p1, p2, p3);
}
