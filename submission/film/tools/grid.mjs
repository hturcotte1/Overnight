// Review helper: puts images side by side in one PNG.
//   node submission/film/tools/grid.mjs <out.png> <height> <img[@x,y,w,h]> ...
// An @x,y,w,h suffix crops that image first (in its own pixels).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const [out, h, ...specs] = process.argv.slice(2);
const b = await chromium.launch();
const cells = specs.map((spec) => {
  const [f, crop] = spec.split("@");
  const src = `data:image/png;base64,${readFileSync(f).toString("base64")}`;
  if (!crop) return `<img src="${src}" style="height:${h}px;margin:4px">`;
  const [x, y, w, hh] = crop.split(",").map(Number);
  const k = Number(h) / hh;
  return `<div style="width:${w * k}px;height:${h}px;overflow:hidden;margin:4px;position:relative"><img src="${src}" style="position:absolute;left:${-x * k}px;top:${-y * k}px;transform-origin:0 0;transform:scale(${k})"></div>`;
}).join("");
const p = await b.newPage({ viewport: { width: 400, height: Number(h) + 10 } });
await p.setContent(`<body style="margin:0;background:#333;display:inline-flex;flex-wrap:nowrap">${cells}</body>`);
await p.waitForLoadState("load");
const w = await p.evaluate(() => document.body.scrollWidth);
await p.setViewportSize({ width: w, height: Number(h) + 10 });
await p.screenshot({ path: out });
await b.close();
