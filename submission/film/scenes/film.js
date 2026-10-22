// The film: for any time t (seconds), draw exactly one frame. No clock is read anywhere.
// window.film.renderFrame(t) resolves once the frame is on the canvas.
import { createGL, W, H, program, draw, textureFrom, blackTexture } from "./gl.js";
import { createPost, finish, DEFAULT_LOOK } from "./post.js";
import { WORLDS } from "./worlds.js";
import { planAt, FILM_LENGTH } from "./timeline.js";
import { SW, SH } from "./watchui.js";
import { setCaptureIndex } from "./capture.js";

const params = new URLSearchParams(location.search);
const SUB = Number(params.get("sub") || 4);

const canvas = document.getElementById("c");
canvas.width = W;
canvas.height = H;
const ctx = createGL(canvas);
ctx.blackTex = blackTexture(ctx);
const post = createPost(ctx);

const programs = {};
for (const [name, src] of Object.entries(WORLDS)) programs[name] = program(ctx, name, src);

const uiCanvas = document.createElement("canvas");
uiCanvas.width = W;
uiCanvas.height = H;
const ui = uiCanvas.getContext("2d");
const uiTex = { tex: null };

const canvases = new Map();
function canvas2d(name, w, h) {
  if (!canvases.has(name)) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    canvases.set(name, { c, g: c.getContext("2d"), tex: null });
  }
  return canvases.get(name);
}

const images = new Map();
function loadImage(url) {
  if (images.has(url)) return images.get(url).ready;
  const img = new Image();
  img.decoding = "sync";
  const entry = { img, tex: null, ready: null, failed: false };
  entry.ready = new Promise((resolve) => {
    img.onload = () => img.decode().then(resolve, resolve);
    img.onerror = () => { entry.failed = true; resolve(); };
  });
  img.src = url;
  images.set(url, entry);
  return entry.ready;
}
function imageTexture(url) {
  const e = images.get(url);
  if (!e || e.failed) return ctx.blackTex;
  if (!e.tex) e.tex = textureFrom(ctx, e.img, { mip: true, premultiply: false });
  return e.tex;
}
// Keep the cache from growing without end over a long render.
function trimImages(keep) {
  if (images.size < 160) return;
  for (const [url, e] of images) {
    if (keep.has(url)) continue;
    if (e.tex) ctx.gl.deleteTexture(e.tex);
    images.delete(url);
    if (images.size < 100) break;
  }
}

/** Shutter: 4 sub-frames spread over half a frame (a 180 degree shutter), each with its own sub-pixel offset. */
const JITTER = [[-0.375, -0.125], [0.125, -0.375], [0.375, 0.125], [-0.125, 0.375], [0, 0], [-0.25, 0.25], [0.25, -0.25], [0.4, 0.4]];

function resolveSamplers(values, named) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" && k.startsWith("u")) {
      if (v.startsWith("img:")) out[k] = imageTexture(v.slice(4));
      else if (named[v]) out[k] = named[v];
      else out[k] = ctx.blackTex;
    } else out[k] = v;
  }
  return out;
}

async function renderFrame(t, opts = {}) {
  const sub = opts.sub ?? SUB;
  const plan = planAt(t);
  const needs = new Set(plan.needs || []);
  await Promise.all([...needs].map(loadImage));
  trimImages(needs);

  // Canvases the worlds sample (the watch screen, the laptop screen, ...).
  const named = {};
  for (const [name, spec] of Object.entries(plan.canvases || {})) {
    const c = canvas2d(name, spec.w ?? SW, spec.h ?? SH);
    c.g.save();
    c.g.clearRect(0, 0, c.c.width, c.c.height);
    spec.draw(c.g, { image: (url) => images.get(url)?.img, ready: (url) => images.has(url) && !images.get(url).failed });
    c.g.restore();
    c.tex = textureFrom(ctx, c.c, { mip: spec.mip ?? true, premultiply: false, tex: c.tex });
    named[name] = c.tex;
  }

  // Typography.
  ui.save();
  ui.clearRect(0, 0, W, H);
  if (plan.ui) plan.ui(ui, { image: (url) => images.get(url)?.img });
  ui.restore();
  uiTex.tex = textureFrom(ctx, uiCanvas, { premultiply: true, tex: uiTex.tex });

  // The picture: every world layer, accumulated over the shutter.
  const gl = ctx.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.t.accum.fb);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  for (const layer of plan.layers || []) {
    if (!(layer.weight > 0.0005)) continue;
    const n = layer.still ? 1 : Math.max(1, sub);
    for (let i = 0; i < n; i++) {
      const dt = layer.still || n === 1 ? 0 : ((i + 0.5) / n - 0.5) * (1 / 60);
      const ts = t + dt;
      const values = resolveSamplers(layer.params(ts), named);
      draw(ctx, programs[layer.world], post.t.accum, {
        ...values,
        uTime: ts,
        uJitter: n === 1 ? [0, 0] : JITTER[i % JITTER.length],
        uWeight: layer.weight / n,
      }, { blend: "add" });
    }
  }
  const look = { ...DEFAULT_LOOK, ...(plan.look || {}), frame: Math.round(t * 30) };
  finish(ctx, post, post.t.accum, uiTex.tex, look);
  gl.finish();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { t, layers: (plan.layers || []).map((l) => l.world) };
}

window.film = {
  renderFrame,
  length: FILM_LENGTH,
  setCaptureIndex,
  ready: true,
};
