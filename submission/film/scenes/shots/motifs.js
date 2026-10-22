// Graphic motifs drawn on the typography layer: the sandbox shield and its lines.
import { clamp, ramp, outCubic, inOutSine, lerp } from "../ease.js";
import { superText, font } from "../ui.js";

// One half of the shield, from the top centre round to the bottom point (a 120 x 144 box).
const HALF_R = "M60 2 L112 18 Q118 20 118 27 L118 62 C118 104 92 128 60 142";
const HALF_L = "M60 2 L8 18 Q2 20 2 27 L2 62 C2 104 28 128 60 142";

/** The shield, drawn as a line of light from its top in both directions at once, then the sandbox's lines. */
export function shieldMotif(g, t, inAt, outAt, { x0 = 150, y0 = 236 } = {}) {
  if (t < inAt - 0.1 || t > outAt + 0.1) return;
  const out = ramp(t, outAt - 0.6, outAt);
  const draw = outCubic(clamp((t - inAt) / 1.2));
  g.save();
  g.globalAlpha = 1 - out;
  g.translate(x0, y0);
  g.scale(1.1, 1.1);
  if (draw > 0.01) {
    g.lineJoin = "round";
    g.lineCap = "butt";
    const len = 190;
    for (const d of [HALF_R, HALF_L]) {
      const p = new Path2D(d);
      g.setLineDash([len * draw, len * 2]);
      g.strokeStyle = "rgba(140,160,255,0.55)";
      g.lineWidth = 9;
      g.filter = "blur(8px)";
      g.stroke(p);
      g.filter = "none";
      g.strokeStyle = "rgba(225,232,255,0.95)";
      g.lineWidth = 3.2;
      g.stroke(p);
    }
    g.setLineDash([]);
  }
  // A check inside once the outline is drawn.
  const c = clamp((t - inAt - 1.0) / 0.6);
  if (c > 0) {
    g.strokeStyle = `rgba(225,232,255,${c})`;
    g.lineWidth = 5;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    const p = [[36, 72], [54, 90], [86, 54]];
    g.moveTo(...p[0]);
    const k1 = clamp(c * 2), k2 = clamp(c * 2 - 1);
    g.lineTo(lerp(p[0][0], p[1][0], k1), lerp(p[0][1], p[1][1], k1));
    if (k2 > 0) g.lineTo(lerp(p[1][0], p[2][0], k2), lerp(p[1][1], p[2][1], k2));
    g.stroke();
  }
  g.restore();
  superText(g, "Inside Overnight's", { t, inAt: inAt + 0.5, outAt, size: 62, weight: 700, x: x0, y: y0 + 262, align: "left", tracking: -0.03 });
  superText(g, "own sandbox.", { t, inAt: inAt + 0.7, outAt, size: 62, weight: 700, x: x0, y: y0 + 334, align: "left", tracking: -0.03 });
  const lines = ["No Bee login.", "No transcripts.", "No GitHub login."];
  lines.forEach((l, i) => {
    superText(g, l, { t, inAt: inAt + 1.7 + i * 0.67, outAt, size: 44, weight: 600, x: x0, y: y0 + 420 + i * 58, align: "left", tracking: -0.02, color: "196,206,255" });
  });
}

export { font };
