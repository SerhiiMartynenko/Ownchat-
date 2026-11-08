// Deno Deploy entry point for the same proxy (alternative host to Cloudflare Workers).
// Deploy this file together with cloudflare-worker.js; set ALLOWED_ORIGINS if needed.
import { handle } from "./cloudflare-worker.js";

Deno.serve((req) => handle(req, { ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") }));
