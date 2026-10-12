// What the dashboard offers to code outside it: the site (the read-only half), the web server
// that serves it, and the demo's invented data (the only half that writes, and only into a
// folder it is handed). The command itself is src/main.ts.
export { demoNightSteps } from "./demo/night-script.ts";
export { seedDemoData } from "./demo/seed.ts";
export { createDashboard } from "./server/server.ts";
export { createSite } from "./site.ts";
export type { SiteOptions } from "./site.ts";
export type * from "./types.ts";
