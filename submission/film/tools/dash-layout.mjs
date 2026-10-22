// Measures the layout of each captured dashboard frame (where the hero card ends, where the step rail
// sits, whether the "Open the app" button is there), so the film can crop to the hero card alone.
// Writes scenes/data/dash-layout.js. Reads only submission/film/capture/dashboard/.
//   node submission/film/tools/dash-layout.mjs
import { chromium } from "playwright";
import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(FILM, "capture", "dashboard");
const files = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://film.local/**", (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  if (name === "index.html") return route.fulfill({ status: 200, body: "<canvas id=c width=1920 height=1080></canvas>", headers: { "content-type": "text/html" } });
  route.fulfill({ status: 200, body: readFileSync(path.join(DIR, name)), headers: { "content-type": "image/png" } });
});
await page.goto("http://film.local/index.html");
const out = [];
for (const f of files) {
  const r = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.getElementById("c");
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const px = (x, y) => g.getImageData(x, y, 1, 1).data;
    const isWhite = (p) => p[0] > 250 && p[1] > 250 && p[2] > 250;
    // The hero card's bottom: scanning down its right margin (x 1490, inside the card, right of every chip).
    let bottom = null;
    for (let y = 380; y < 1000; y++) if (!isWhite(px(1490, y))) { bottom = y; break; }
    // The "Open the app" button (blue) at x 470, y 238.
    const b = px(470, 238);
    const button = b[2] > 200 && b[0] < 120;
    // The rail: the Heard circle's centre row at x 515.
    let rail = null;
    for (let y = 200; y < 360; y++) { const p = px(515, y); if (p[2] > 200 && p[0] < 140 && p[1] < 140) { rail = y + 21; break; } }
    return { bottom, button, rail };
  }, `http://film.local/${f}`);
  out.push({ file: f, ...r });
}
await browser.close();
writeFileSync(path.join(FILM, "scenes", "data", "dash-layout.js"), "// Measured by tools/dash-layout.mjs from capture/dashboard/: the hero card's bottom edge (page px) per frame.\nexport const DASH_LAYOUT = " + JSON.stringify(out.map((o) => ({ bottom: o.bottom }))) + ";\n");
let last = "";
out.forEach((o, i) => { const s = `${o.bottom} ${o.button} ${o.rail}`; if (s !== last) { console.log(i + 1, s); last = s; } });
