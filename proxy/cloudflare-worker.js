// Ownchat personal proxy for OpenRouter (Cloudflare Workers, ES module syntax).
//
// Use only if your browser's requests to openrouter.ai are blocked (see README ->
// Troubleshooting). It answers the CORS preflight itself and forwards POSTs under
// /api/v1/ to https://openrouter.ai. The API key is never stored: the Authorization
// header from the browser is passed straight through.
//
// Optional variable: ALLOWED_ORIGINS, comma-separated list of page origins allowed to
// call this proxy (default: https://serhiimartynenko.github.io).

const UPSTREAM = "https://openrouter.ai";
const DEFAULT_ORIGINS = "https://serhiimartynenko.github.io";
const FORWARD_HEADERS = ["authorization", "content-type"];

function allowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS;
  return raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function plain(status, text, extra) {
  return new Response(text, {
    status,
    headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, extra || {}),
  });
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const origins = allowedOrigins(env);

  // Browser requests always carry Origin; anything else is not this app and is refused.
  if (!origin || !origins.includes(origin)) {
    return plain(403, "Origin not allowed");
  }
  const cors = corsHeaders(origin);

  if (!url.pathname.startsWith("/api/v1/")) {
    return plain(404, "Not found", cors);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return plain(405, "Method not allowed", Object.assign({ Allow: "POST, OPTIONS" }, cors));
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: "POST",
      headers,
      body: request.body,
      // Required by the WHATWG fetch spec (Node, Deno) when streaming a request body.
      duplex: "half",
    });
  } catch (e) {
    return plain(502, "Upstream fetch failed: " + (e && e.message ? e.message : String(e)), cors);
  }

  const out = new Headers(upstream.headers);
  out.delete("set-cookie");
  // The runtime hands us a decoded body; the upstream encoding/length no longer apply.
  out.delete("content-encoding");
  out.delete("content-length");
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};
