// The man, before the push into his wrist: a rim-lit silhouette in profile, seated at a table, his left
// forearm resting on it with the watch on his wrist. Painted on a 2D canvas (vector paths, redrawn at
// every zoom so it stays sharp) and put through the film's lens by the PLATE world. An illustration.
import { clamp, lerp, smooth } from "../ease.js";

export const MAN_W = 1920;
export const MAN_H = 1080;
/** Where the watch sits in the painting; the camera pushes in toward it. */
export const WATCH_AT = [1361, 826];

const DX = -112; // the figure sits a little left of centre, so the light has room in front of his face
// The figure, facing right: head, neck, chest and back (one outline). Scale: about 14 px to the cm.
const BODY = [
  [1118, 150], [1146, 146], [1176, 152], [1203, 166], [1225, 190], [1240, 220], [1250, 258], [1258, 293], [1255, 313],
  [1263, 333], [1281, 357], [1295, 374], [1287, 385], [1268, 389], [1262, 397], [1268, 410],
  [1263, 420], [1267, 431], [1255, 446], [1261, 465], [1251, 485], [1222, 497], [1188, 503],
  [1177, 527], [1183, 548], [1177, 577], [1190, 612], [1238, 652], [1264, 722], [1279, 830],
  [1288, 1100], [872, 1100], [890, 900], [915, 770], [950, 660], [1003, 575], [1030, 508],
  [1013, 452], [994, 392], [984, 318], [994, 252], [1022, 200], [1058, 168], [1088, 154],
].map(([x, y]) => [x + DX, y]);
// The left forearm and hand, resting on the table, in front of the body.
const ARM = [
  [990, 800], [1100, 810], [1220, 822], [1330, 832], [1400, 838], [1440, 836], [1500, 832], [1560, 840],
  [1608, 858], [1636, 884], [1620, 910], [1560, 915], [1480, 913], [1410, 915], [1300, 921], [1180, 929],
  [1060, 934], [982, 924], [958, 866],
];
const TABLE_Y = 918;
// A few hairs at the crown that catch the light.
const HAIRS = [
  [[1150, 150], [1182, 144], [1212, 158]],
  [[1170, 152], [1200, 150], [1226, 172]],
  [[1190, 160], [1216, 164], [1236, 192]],
  [[1128, 150], [1160, 140], [1190, 146]],
].map((h) => h.map(([x, y]) => [x + DX, y]));

/** A closed smooth path through points (Catmull-Rom as Bezier curves). */
function smoothPath(pts) {
  const p = new Path2D();
  const n = pts.length;
  const at = (i) => pts[(i + n) % n];
  p.moveTo(...pts[0]);
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    p.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]);
  }
  p.closePath();
  return p;
}

const bodyPath = smoothPath(BODY);
const armPath = smoothPath(ARM);
const casePath = (() => {
  const p = new Path2D();
  p.roundRect(1330, 816, 62, 20, 8);
  return p;
})();
const tablePath = (() => {
  const p = new Path2D();
  p.rect(1010, TABLE_Y, 2400, 46);
  return p;
})();

const scratch = new Map();
function layer(name) {
  if (!scratch.has(name)) {
    const c = document.createElement("canvas");
    c.width = MAN_W;
    c.height = MAN_H;
    scratch.set(name, { c, g: c.getContext("2d") });
  }
  const l = scratch.get(name);
  l.g.setTransform(1, 0, 0, 1, 0, 0);
  l.g.globalCompositeOperation = "source-over";
  l.g.filter = "none";
  l.g.globalAlpha = 1;
  l.g.clearRect(0, 0, MAN_W, MAN_H);
  return l;
}

/**
 * Paints the man. o: { t, zoom (1 = the wide frame), light (0..1, the rim's strength) }.
 * The zoom is about WATCH_AT, which moves toward the frame's centre as it grows.
 */
export function drawMan(g, o) {
  const { zoom = 1, light = 1, t = 0, aim = 0 } = o;
  // As the camera pushes in, the watch moves to where the 3D shot that follows has it.
  const cx = lerp(WATCH_AT[0], 752, aim), cy = lerp(WATCH_AT[1], 436, aim);
  const M = (c) => c.setTransform(zoom, 0, 0, zoom, cx - WATCH_AT[0] * zoom, cy - WATCH_AT[1] * zoom);
  const toScreen = (x, y) => [cx + (x - WATCH_AT[0]) * zoom, cy + (y - WATCH_AT[1]) * zoom];
  const breathe = Math.sin(t * 1.7) * 1.4;

  // The room: near black; a warm light far behind him, in front of his face; a few lights out of focus.
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#030203";
  g.fillRect(0, 0, MAN_W, MAN_H);
  const [hx, hy] = toScreen(1335, 430);
  let rg = g.createRadialGradient(hx, hy, 10, hx, hy, 820 * Math.sqrt(zoom));
  rg.addColorStop(0, `rgba(255,170,95,${0.62 * light})`);
  rg.addColorStop(0.3, `rgba(190,100,50,${0.34 * light})`);
  rg.addColorStop(0.7, `rgba(70,32,18,${0.14 * light})`);
  rg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, MAN_W, MAN_H);
  const [bx0, by0] = toScreen(820, 360);
  const cool = g.createRadialGradient(bx0, by0, 10, bx0, by0, 700 * zoom);
  cool.addColorStop(0, `rgba(60,70,120,${0.16 * light})`);
  cool.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = cool;
  g.fillRect(0, 0, MAN_W, MAN_H);
  const bokeh = [[1660, 230, 50, 0.55], [1810, 430, 70, 0.4], [1540, 300, 34, 0.35], [1890, 170, 40, 0.45], [1720, 560, 44, 0.25], [360, 250, 56, 0.1], [200, 520, 76, 0.07]];
  for (const [bx, by, br, ba] of bokeh) {
    const x = bx + (bx - 960) * (zoom - 1) * 0.35 + t * 3, y = by + (by - 540) * (zoom - 1) * 0.35;
    const r = br * (1 + (zoom - 1) * 0.5);
    const bg = g.createRadialGradient(x, y, r * 0.2, x, y, r);
    bg.addColorStop(0, `rgba(255,180,105,${ba * 0.5 * light})`);
    bg.addColorStop(0.85, `rgba(255,170,100,${ba * 0.42 * light})`);
    bg.addColorStop(1, "rgba(255,160,90,0)");
    g.fillStyle = bg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();

  // The table: a dark slab, its top catching a long line of the warm light.
  g.save();
  M(g);
  g.fillStyle = "#050404";
  g.fill(tablePath);
  const tl = g.createLinearGradient(1010, 0, 1920, 0);
  tl.addColorStop(0, "rgba(255,190,130,0)");
  tl.addColorStop(0.45, `rgba(255,190,130,${0.55 * light})`);
  tl.addColorStop(1, `rgba(255,190,130,${0.25 * light})`);
  g.fillStyle = tl;
  g.fillRect(1010, TABLE_Y - 1, 2400, 2.2);
  g.restore();

  // Each part: black, then rim light on the edges that face the light (right and up), in two widths:
  // a fine bright line and a broad soft wrap, fading away from the light.
  const part = (path, name, rimA, offsetY, fadeFrom, fadeTo) => {
    const shape = (c) => { M(c); if (offsetY) c.translate(0, offsetY); };
    const rim = layer(name);
    for (const [w, a, b] of [[3.2, 1.0, 1.0], [13, 0.38, 5]]) {
      // The part, and the part moved away from the light and softened: what is left of the first
      // after the second is taken out of it is the lit edge.
      const tmp = layer(name + "-tmp");
      shape(tmp.g);
      tmp.g.fillStyle = `rgba(255,212,168,${rimA * a})`;
      tmp.g.fill(path);
      const cut = layer(name + "-cut");
      cut.g.filter = `blur(${(b * zoom).toFixed(2)}px)`;
      shape(cut.g);
      cut.g.translate(-w, w * 0.6);
      cut.g.fillStyle = "#000";
      cut.g.fill(path);
      tmp.g.setTransform(1, 0, 0, 1, 0, 0);
      tmp.g.globalCompositeOperation = "destination-out";
      tmp.g.drawImage(cut.c, 0, 0);
      rim.g.drawImage(tmp.c, 0, 0);
    }
    // The light falls off away from its side.
    rim.g.setTransform(1, 0, 0, 1, 0, 0);
    rim.g.globalCompositeOperation = "destination-in";
    const [fx0, fy0] = toScreen(...fadeFrom), [fx1, fy1] = toScreen(...fadeTo);
    const fade = rim.g.createLinearGradient(fx0, fy0, fx1, fy1);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(0.6, "rgba(0,0,0,0.7)");
    fade.addColorStop(1, "rgba(0,0,0,0.0)");
    rim.g.fillStyle = fade;
    rim.g.fillRect(0, 0, MAN_W, MAN_H);
    g.save();
    shape(g);
    g.fillStyle = "#030304";
    g.fill(path);
    g.restore();
    g.save();
    g.globalCompositeOperation = "lighter";
    g.filter = `blur(${(10 * zoom).toFixed(1)}px)`;
    g.globalAlpha = 0.5 * light;
    g.drawImage(rim.c, 0, 0);
    g.filter = "none";
    g.globalAlpha = light;
    g.drawImage(rim.c, 0, 0);
    g.restore();
  };
  part(bodyPath, "body", 1.0, breathe * 0.4, [1280 + DX, 200], [880 + DX, 1060]);
  part(armPath, "arm", 0.95, breathe, [1380, 780], [1000, 1000]);

  // Hairs at the crown.
  g.save();
  M(g);
  g.translate(0, breathe * 0.4);
  g.strokeStyle = `rgba(255,214,170,${0.5 * light})`;
  g.lineWidth = 0.9;
  for (const h of HAIRS) {
    g.beginPath();
    g.moveTo(...h[0]);
    g.quadraticCurveTo(...h[1], ...h[2]);
    g.stroke();
  }
  g.restore();

  // The hand past the wrist falls into shadow.
  g.save();
  M(g);
  g.translate(0, breathe);
  const sh = g.createLinearGradient(1405, 0, 1520, 0);
  sh.addColorStop(0, "rgba(3,3,4,0)");
  sh.addColorStop(1, "rgba(3,3,4,0.88)");
  g.fillStyle = sh;
  g.fill(armPath);
  // The watch: a dark case catching a line of light along its top, the band round the wrist.
  g.fillStyle = "#060709";
  g.fill(casePath);
  g.fillRect(1338, 832, 46, 84);
  g.strokeStyle = `rgba(255,224,190,${0.85 * light})`;
  g.lineWidth = 1.8;
  g.beginPath();
  g.moveTo(1340, 816.5);
  g.lineTo(1385, 816.5);
  g.quadraticCurveTo(1392, 817, 1392.5, 824);
  g.stroke();
  g.strokeStyle = `rgba(255,224,190,${0.35 * light})`;
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(1384, 834);
  g.lineTo(1384, 912);
  g.stroke();
  g.restore();
}
