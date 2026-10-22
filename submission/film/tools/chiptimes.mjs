// When each build chip on the idea's page turns green, by captured frame. Prints the first frame of each.
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "capture", "dashboard");
const files = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://film.local/**", (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  if (name === "index.html") return route.fulfill({ status: 200, body: "<canvas id=c width=1920 height=1080></canvas>", headers: { "content-type": "text/html" } });
  route.fulfill({ status: 200, body: readFileSync(path.join(DIR, name)), headers: { "content-type": "image/png" } });
});
await page.goto("http://film.local/index.html");
const probes = { sandbox: [709, 421], agent: [1192, 421], project: [1323, 421], packages: [459, 463], appbuilt: [622, 463], notes: [727, 463], built: [863, 463] };
const first = {};
for (const f of files) {
  const r = await page.evaluate(async ({ url, probes }) => {
    const img = new Image(); img.src = url; await img.decode();
    const g = document.getElementById("c").getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const out = {};
    for (const [k, [x, y]] of Object.entries(probes)) {
      let green = false;
      for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) { const p = g.getImageData(x + dx, y + dy, 1, 1).data; if (p[1] > 100 && p[0] < 60 && p[2] < 110) green = true; }
      out[k] = green;
    }
    return out;
  }, { url: `http://film.local/${f}`, probes });
  for (const [k, v] of Object.entries(r)) if (v && !first[k]) first[k] = f;
}
console.log(first);
await browser.close();
