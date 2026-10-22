import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
const DIR = path.join(import.meta.dirname, "..", "capture", "dashboard");
const frames = process.argv.slice(3).map(Number);
const out = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 70 * frames.length } });
await page.route("http://film.local/**", (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  if (name === "index.html") return route.fulfill({ status: 200, body: `<body style="margin:0"><canvas id=c width=1100 height=${70 * frames.length}></canvas></body>`, headers: { "content-type": "text/html" } });
  route.fulfill({ status: 200, body: readFileSync(path.join(DIR, name)), headers: { "content-type": "image/png" } });
});
await page.goto("http://film.local/index.html");
await page.evaluate(async ({ frames, cy }) => {
  const g = document.getElementById("c").getContext("2d");
  for (let i = 0; i < frames.length; i++) {
    const img = new Image();
    img.src = `http://film.local/frame-${String(frames[i]).padStart(5, "0")}.png`;
    await img.decode();
    g.drawImage(img, 440, cy, 1060, 85, 40, i * 70, 1060 * 0.8, 85 * 0.8);
    g.fillStyle = "#000"; g.font = "16px sans-serif"; g.fillText(String(frames[i]), 2, i * 70 + 30);
  }
}, { frames, cy: Number(process.env.CROP_Y || 400) });
await page.screenshot({ path: out });
await browser.close();
