// Renders the launch film to PNG frames, deterministically: frame n is the film at t = n / 30 s.
//
//   node submission/film/render.mjs <start> <end> <outDir> [--workers 3] [--sub 4]
//       Frames start (included) to end (not included). start and end are frame numbers, or seconds
//       with an "s" (12s, 34.5s). Writes <outDir>/f00000.png ... Resumable: a frame already on disk
//       is skipped, and a frame is written to a temporary name first, so a stopped run leaves no
//       half-written frame.
//   node submission/film/render.mjs --times 0.5,2,6 <outDir> [--sheet]
//       Single frames at these times (t-000.50.png ...), and with --sheet a contact sheet of them.
//
// It opens submission/film/scenes/index.html in Playwright's Chromium with the GPU (Metal) and serves
// the film folder to it from disk through a request route: no port is opened, nothing is fetched
// from outside, and only files inside submission/film/ can be read.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILM_DIR = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://film.local";
const FPS = 30;
const LENGTH_S = 160;

function usage(msg) {
  if (msg) console.error(msg);
  console.error("Usage: node submission/film/render.mjs <start> <end> <outDir> [--workers N] [--sub N]\n       node submission/film/render.mjs --times 0.5,2,6 <outDir> [--sheet]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { workers: 3, sub: 4, times: null, sheet: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workers") opts.workers = Number(argv[++i]);
    else if (a === "--sub") opts.sub = Number(argv[++i]);
    else if (a === "--times") opts.times = argv[++i].split(",").map(Number);
    else if (a === "--sheet") opts.sheet = true;
    else if (a.startsWith("--")) usage(`Unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

function frameOf(s) {
  if (/^\d+(\.\d+)?s$/.test(s)) return Math.round(parseFloat(s) * FPS);
  if (/^\d+$/.test(s)) return Number(s);
  usage(`Not a frame number or a time: ${s}`);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" };

/** The capture index the page reads its footage from: every image in each folder under capture/, in name order. */
function captureIndex() {
  const root = path.join(FILM_DIR, "capture");
  const folders = {};
  const taps = {};
  let meta = null;
  if (existsSync(root)) {
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      }
      const imgs = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
      if (imgs.length && rel) folders[rel] = imgs.map((f) => `${ORIGIN}/capture/${rel}/${f}`);
      const tapsFile = path.join(dir, "taps.json");
      if (rel && existsSync(tapsFile)) {
        try { taps[rel] = JSON.parse(readFileSync(tapsFile, "utf8")); } catch { /* no taps */ }
      }
    };
    walk(root, "");
    const mp = path.join(root, "meta.json");
    if (existsSync(mp)) {
      try { meta = JSON.parse(readFileSync(mp, "utf8")); } catch { meta = null; }
    }
  }
  return { folders, meta, taps };
}

async function openPage(browser, sub) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(FILM_DIR, rel);
    if (!file.startsWith(FILM_DIR + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    await route.fulfill({ status: 200, path: file, headers: { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" } });
  });
  await context.route(/^(?!http:\/\/film\.local\/).*/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${ORIGIN}/scenes/index.html?sub=${sub}`);
  const ok = await page.waitForFunction(() => (window.film && window.film.ready) || window.filmError, null, { timeout: 60_000 }).then(() => page.evaluate(() => window.filmError || null));
  if (ok) throw new Error(`The film page failed to start:\n${ok}`);
  const counts = await page.evaluate((idx) => window.film.setCaptureIndex(idx), captureIndex());
  return { page, errors, counts };
}

async function renderTo(page, errors, t, file) {
  const tmp = `${file}.part`;
  await page.evaluate((tt) => window.film.renderFrame(tt), t);
  if (errors.length) throw new Error(`The page reported an error at t=${t}:\n${errors.join("\n")}`);
  const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  writeFileSync(tmp, buf);
  renameSync(tmp, file);
}

function done(file) {
  return existsSync(file) && statSync(file).size > 1000;
}

async function contactSheet(browser, outDir, times) {
  const files = times.map((t) => `t-${t.toFixed(2).padStart(6, "0")}.png`);
  const cells = files.map((f, i) => `<figure><img src="data:image/png;base64,${readFileSync(path.join(outDir, f)).toString("base64")}"><figcaption>${times[i].toFixed(1)} s</figcaption></figure>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#111;font:600 15px system-ui;color:#aaa">
  <div style="display:grid;grid-template-columns:repeat(4,480px);gap:8px;padding:8px">${cells}</div>
  <style>figure{margin:0}img{width:480px;height:270px;display:block}figcaption{padding:4px 2px 2px}</style></body></html>`;
  const page = await browser.newPage({ viewport: { width: 4 * 480 + 5 * 8, height: 400 } });
  await page.setContent(html);
  const out = path.join(outDir, "contact-sheet.png");
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--force-color-profile=srgb", "--disable-gpu-watchdog"] });
  try {
    if (opts.times) {
      const outDir = path.resolve(opts.positional[0] || path.join(FILM_DIR, "review"));
      mkdirSync(outDir, { recursive: true });
      const { page, errors, counts } = await openPage(browser, opts.sub);
      console.log(`capture folders: ${JSON.stringify(counts)}`);
      for (const t of opts.times) {
        const file = path.join(outDir, `t-${t.toFixed(2).padStart(6, "0")}.png`);
        const t0 = performance.now();
        await renderTo(page, errors, t, file);
        console.log(`t=${t.toFixed(2)}s  ${((performance.now() - t0) / 1000).toFixed(2)} s  ${path.relative(process.cwd(), file)}`);
      }
      if (opts.sheet) console.log(`contact sheet: ${await contactSheet(browser, outDir, opts.times)}`);
      return;
    }
    if (opts.positional.length !== 3) usage();
    const start = frameOf(opts.positional[0]);
    const end = Math.min(frameOf(opts.positional[1]), LENGTH_S * FPS);
    const outDir = path.resolve(opts.positional[2]);
    mkdirSync(outDir, { recursive: true });
    const todo = [];
    for (let n = start; n < end; n++) if (!done(path.join(outDir, `f${String(n).padStart(5, "0")}.png`))) todo.push(n);
    console.log(`frames ${start} to ${end - 1}: ${end - start - todo.length} already done, ${todo.length} to render with ${opts.workers} workers`);
    if (!todo.length) return;
    const chunks = Array.from({ length: opts.workers }, () => []);
    const per = Math.ceil(todo.length / opts.workers);
    todo.forEach((n, i) => chunks[Math.floor(i / per)].push(n));
    const t0 = performance.now();
    let count = 0;
    await Promise.all(chunks.filter((c) => c.length).map(async (chunk) => {
      const { page, errors } = await openPage(browser, opts.sub);
      for (const n of chunk) {
        await renderTo(page, errors, n / FPS, path.join(outDir, `f${String(n).padStart(5, "0")}.png`));
        count++;
        if (count % 30 === 0 || count === todo.length) {
          const el = (performance.now() - t0) / 1000;
          console.log(`${count}/${todo.length} frames, ${(el / count).toFixed(2)} s per frame, about ${Math.round((todo.length - count) * el / count)} s left`);
        }
      }
      await page.close();
    }));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
