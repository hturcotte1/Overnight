/* global document, location, sessionStorage, window */
// Put on every page the recorder opens (context.addInitScript), and acts only on the dashboard,
// which the recorder serves on 127.0.0.1 with --demo. It adds the video's caption strip and
// shows the page at 90 % so the hero card and the caption both fit in 1280 x 720. Its top bar,
// with the "DEMO DATA: invented" label, is kept in view when the page is scrolled.
// It changes nothing on the server: this is only how the recording browser draws the page.
(() => {
  if (location.hostname !== "127.0.0.1") return;
  const KEY = "overnight-demo-caption";

  const set = (main, sub) => {
    const strip = document.getElementById("demo-strip");
    if (!strip) return;
    strip.querySelector("b").textContent = main;
    strip.querySelector("span").textContent = sub || "";
    strip.classList.toggle("on", Boolean(main));
  };

  window.demoCaption = (main, sub) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify([main, sub || ""]));
    } catch {
      // A caption that is not kept for the next page is set again by the recorder.
    }
    set(main, sub);
  };

  const build = () => {
    const style = document.createElement("style");
    style.textContent = `
      body { zoom: .9; }
      /* The top bar stays in view, so the dashboard's own "DEMO DATA: invented" label is always in the picture. */
      header.top { position: sticky; top: 0; z-index: 20; background: #f5f3ee; }
      details.doc { scroll-margin-top: 84px; }
      #demo-strip { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); width: max-content; max-width: 1160px;
        padding: 14px 28px 15px; border-radius: 18px; background: #1a1e2b; color: #fff; text-align: center; z-index: 9999;
        font-family: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
        box-shadow: 0 10px 30px rgba(20, 24, 40, .25); opacity: 0; transition: opacity .35s ease; }
      #demo-strip.on { opacity: 1; }
      #demo-strip b { display: block; font-size: 30px; line-height: 1.25; font-weight: 800; }
      #demo-strip span { display: block; margin-top: 4px; font-size: 21px; line-height: 1.3; font-weight: 600; color: #c9cde0; }
      #demo-strip span:empty { display: none; }`;
    document.head.append(style);
    const strip = document.createElement("div");
    strip.id = "demo-strip";
    strip.append(document.createElement("b"), document.createElement("span"));
    // Outside <body>, so the page's zoom does not shrink the caption.
    document.documentElement.append(strip);
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (Array.isArray(saved)) set(String(saved[0]), String(saved[1]));
    } catch {
      // Nothing kept: the recorder sets the caption.
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
