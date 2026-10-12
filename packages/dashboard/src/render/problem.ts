// The three pages with no data in them: the dashboard was opened without its link, the address
// leads nowhere, or making the page went wrong. Nothing here comes from the database, a log or a
// request, and an error's own message is never shown.
import type { View } from "../types.ts";
import { html } from "./html.ts";

export function renderProblem(kind: "needs-key" | "not-found" | "error", c: { port: number }): View {
  if (kind === "needs-key") {
    return {
      title: "Open it from its link",
      main: html`<div class="card empty"><h1>Open it from its link</h1><p>This dashboard opens from its own link. Ask Claude Code for it. It starts with http://127.0.0.1:${c.port}/?key=</p><p>The link is new every time the dashboard starts, so an old one stops working.</p></div>`,
    };
  }
  if (kind === "not-found") {
    return {
      title: "Nothing here",
      main: html`<div class="card empty"><h1>Nothing here</h1><p>There is no page at this address.</p><p><a class="button" href="/">Go to Today</a></p></div>`,
    };
  }
  return {
    title: "Something went wrong",
    main: html`<div class="card empty"><h1>Something went wrong</h1><p>This page could not be made just now. Nothing was changed.</p><p>Try again in a moment. If it keeps happening, tell Claude Code.</p></div>`,
  };
}
