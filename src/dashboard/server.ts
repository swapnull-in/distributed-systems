/**
 * The Failure Lab dashboard — run with:  npm run dashboard
 *
 * Every simulation in this repo also runs in the browser as an INTERACTIVE
 * instrument: cut a Raft cluster in two and watch which side can still commit,
 * drag the utilization slider until a region loss flips from non-event to
 * outage, step a retry storm into metastable collapse, and merge two replicas
 * under LWW vs a CRDT to watch a write get lost or survive.
 *
 * All the logic is client-side (same as the CLI phases — pure simulation, no
 * external services), so this server does exactly one thing: serve the page.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { log } from "../lib/log.ts";

const PORT = 3000;
const HTML = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(HTML);
}).listen(PORT, () => {
  log(`Failure Lab dashboard on  http://localhost:${PORT}`);
  log("open it in a browser — cut networks, drag utilization, step the storm.");
});
