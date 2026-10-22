// Small WebGL2 helpers: programs, render targets, textures, one full-screen triangle.
// Nothing here knows about time; the film decides what to draw for each t.

export const W = 1920;
export const H = 1080;

export function createGL(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 is not available in this browser.");
  if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float is missing.");
  gl.getExtension("EXT_float_blend");
  gl.getExtension("OES_texture_float_linear");
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  return { gl, aniso, programs: new Map() };
}

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

function compile(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split("\n");
    const m = /ERROR: \d+:(\d+)/.exec(log || "");
    const at = m ? Number(m[1]) : 0;
    const context = at ? lines.slice(Math.max(0, at - 3), at + 2).map((l, i) => `${at - 2 + i}: ${l}`).join("\n") : "";
    throw new Error(`Shader ${name} failed:\n${log}\n${context}`);
  }
  return s;
}

/** A program made of the shared vertex shader and this fragment shader. Uniform locations are cached. */
export function program(ctx, name, fragSrc) {
  const { gl } = ctx;
  if (ctx.programs.has(name)) return ctx.programs.get(name);
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT, name + ".vert"));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program ${name} failed to link: ${gl.getProgramInfoLog(p)}`);
  const uniforms = new Map();
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    const base = info.name.replace(/\[0\]$/, "");
    uniforms.set(base, { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size });
  }
  const prog = { name, p, uniforms };
  ctx.programs.set(name, prog);
  return prog;
}

/** Sets uniforms by name from a plain object. Numbers, arrays (vec2..4, mat3, float[]), and {tex, unit} pairs. */
export function setUniforms(ctx, prog, values) {
  const { gl } = ctx;
  let unit = 0;
  for (const [name, u] of prog.uniforms) {
    const v = values[name];
    if (v === undefined) {
      if (u.type === gl.SAMPLER_2D) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, ctx.blackTex);
        gl.uniform1i(u.loc, unit++);
      }
      continue;
    }
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1) gl.uniform1fv(u.loc, v);
        else gl.uniform1f(u.loc, v);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
      case gl.SAMPLER_2D: {
        const tex = v && v.tex ? v.tex : v;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex || ctx.blackTex);
        gl.uniform1i(u.loc, unit++);
        break;
      }
      default: throw new Error(`Uniform ${name} of ${prog.name} has a type this film does not set.`);
    }
  }
}

/** A floating-point render target. */
export function target(ctx, w, h, { format = "RGBA16F", filter = "LINEAR" } = {}) {
  const { gl } = ctx;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const internal = gl[format];
  const type = format === "RGBA32F" ? gl.FLOAT : format === "RGBA8" ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[filter]);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[filter]);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Render target ${w}x${h} ${format} is incomplete (${status}).`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb, w, h };
}

/** Draws prog into dst (a target, or null for the canvas) with these uniforms. */
export function draw(ctx, prog, dst, values, { blend = null, clear = false } = {}) {
  const { gl } = ctx;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
  gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
  if (clear) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.useProgram(prog.p);
  setUniforms(ctx, prog, { uRes: [dst ? dst.w : W, dst ? dst.h : H], ...values });
  if (blend === "add") {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
  } else if (blend === "over") {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  } else gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.BLEND);
}

/** An RGBA8 texture filled from a canvas or image. mip: build mipmaps (for footage seen at an angle). */
export function textureFrom(ctx, source, { mip = false, premultiply = true, tex = null } = {}) {
  const { gl, aniso } = ctx;
  const t = tex || gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (mip) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 16);
  } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function blackTexture(ctx) {
  const { gl } = ctx;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  return t;
}
