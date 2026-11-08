# Implementation plan: fix OpenRouter preflight 403, add Grok models

Date: 2026-11-08. Branch: `claude/adoring-hamilton-cq46ew`.

## Problem

Safari (iOS, PWA) logs:

```
[Error] Preflight response is not successful. Status code: 403
[Error] Fetch API cannot load https://openrouter.ai/api/v1/chat/completions due to access control checks.
[Warning] Parsing application manifest blob:https://serhiimartynenko.github.io/...: The value of "start_url" is not a valid URL.
```

The browser's CORS preflight (`OPTIONS`) to OpenRouter is answered with 403, so the real
`POST` never happens. OpenRouter sits behind Cloudflare bot protection that is known to
return 403 "Access denied by security policy" to whole classes of clients
(see SillyTavern/SillyTavern#5825). The app sends a non-standard `X-Title` header, which
widens the preflight beyond the `authorization, content-type` set that is known to pass.

Constraints from the owner: the app must stay a browser-only static site on GitHub Pages,
with key and history in `localStorage`. No required backend.

## Diagnosis result (2026-11-08, after the plan was written)

A real preflight was sent from a US datacenter to `https://openrouter.ai/api/v1/chat/completions` with
`Origin: https://serhiimartynenko.github.io`, `Access-Control-Request-Headers: authorization,content-type,x-title`
and an iOS Safari user agent. OpenRouter answered **204** with `access-control-allow-origin: *` and an allow-headers
list that includes `X-Title`. The response came from Cloudflare with a `__cf_bm` bot-management cookie.

Conclusion: OpenRouter's CORS policy is correct and the app's headers are accepted. The 403 seen in the owner's Safari
is Cloudflare bot / IP-reputation / region protection on the owner's own network path (VPN, iCloud Private Relay, or a
geo-blocked region are the usual causes). No header change can fix that from a static page. Layers 2 to 4 of the
strategy (configurable endpoint, optional personal proxy, clear error message) are therefore the actual fix; layer 1
is kept only because a smaller preflight is harmless.

## Strategy (layered)

1. **Minimise the preflight.** Send only `Authorization` and `Content-Type`. Drop `X-Title`.
2. **Make the endpoint configurable.** Default stays `https://openrouter.ai/api/v1/chat/completions`.
   An optional "API endpoint" field in Settings → Advanced lets the owner point the app at a
   tiny personal proxy if OpenRouter's edge keeps blocking their browser. Persisted in `localStorage`.
3. **Ship an optional proxy.** `proxy/cloudflare-worker.js`: answers `OPTIONS` itself, forwards
   `POST` to OpenRouter with the user's `Authorization` header passed through, streams the body
   back, restricts `Access-Control-Allow-Origin` to an allow-list (defaults to the Pages origin).
   Deployable on the free Cloudflare Workers tier; README documents it in five steps.
4. **Explain failures.** A rejected `fetch` (Safari: `TypeError: Load failed`, Chrome:
   `Failed to fetch`) currently surfaces as a bare error. Show a clear message that names the
   likely cause (request blocked before reaching OpenRouter) and the two remedies
   (turn off VPN / iCloud Private Relay; or set a proxy endpoint).

## Workstreams and model assignment

### WS-B · Models, branding, manifest, README  — **Sonnet**  (runs first)

Files: `index.html`, `README.md`.

- `MODEL_PRESETS` → `["x-ai/grok-4.7","x-ai/grok-4.5","anthropic/claude-opus-4.8","anthropic/claude-opus-4.8-fast","anthropic/claude-sonnet-4.6","anthropic/claude-haiku-4.5"]`.
- Default model for fresh installs → `x-ai/grok-4.7` (every `"anthropic/claude-opus-4.8"` fallback literal,
  the `#setModel` placeholder, the header pill default text). Saved settings of existing users are untouched.
- `shortModel()` becomes provider-agnostic: strip `vendor/`, strip a leading `claude-`, replace `-` with spaces
  (so `x-ai/grok-4.7` → `grok 4.7`).
- Branding away from Claude-only: `APP_TITLE` → `"Ownchat"`, `<title>`, manifest `name`/`short_name` → `Ownchat`,
  empty-state copy → "Talk to Grok, Claude and other OpenRouter models with your own key. Your key and history stay on this device.",
  composer placeholder → `Message…`, hero letter `C` → `O`.
- Manifest fix: build absolute URLs since the manifest is served from a `blob:` URL and relative
  `start_url` cannot resolve: `var base = new URL(".", location.href).href;` then `start_url: base, scope: base, id: base`.
- README: mention Grok + Claude, the new default, keep everything else accurate.
- Do **not** touch `streamCompletion`, `reasoningConfig`, the fetch headers or the settings-form JS beyond the model default.

Acceptance: page loads with no console errors; six preset chips render and wrap cleanly on a 390px-wide
viewport; clicking a chip fills the model field; manifest parses with an absolute `start_url`.

### WS-A · Preflight fix, endpoint override, reasoning compatibility, proxy  — **Opus**  (after WS-B)

Files: `index.html`, `README.md`, new `proxy/cloudflare-worker.js`.

- Headers: remove `X-Title`. Request headers are exactly `Authorization` and `Content-Type: application/json`.
- Settings: add `settings.endpoint` (string, default `""`). Effective URL = `settings.endpoint || DEFAULT_API_URL`.
  Add an "Advanced" section to the settings sheet with `#setEndpoint` (placeholder = default URL) and a hint:
  "Leave empty to call OpenRouter directly. Set this only if your browser is blocked (see README → Troubleshooting)."
  Load/save/validate (must start with `https://`; otherwise toast and keep previous).
- Reasoning by model family (`body.reasoning`):
  - `anthropic/*` → unchanged: `{ max_tokens: budget }` and top-level `max_tokens: max`.
  - everything else → `{ effort: "medium" | "high" }` (medium→medium, high→high, max→high), top-level `max_tokens: max`.
  - On HTTP 400 whose message mentions `reasoning`/`effort`/`unsupported`, retry once without `reasoning` (not streamed yet, so safe).
- Network-failure message: in the `.catch` of `streamCompletion`, when `e` is a `TypeError` (fetch rejected before a response)
  and not an abort, replace the message with:
  "Request was blocked before it reached OpenRouter (CORS preflight failed). Try turning off a VPN or iCloud Private Relay,
  or set a proxy endpoint in Settings → Advanced." Keep the original text appended in parentheses.
- `proxy/cloudflare-worker.js` (ES module Worker, no dependencies):
  - `OPTIONS` → 204 with `Access-Control-Allow-Origin` (echo origin if in `ALLOWED_ORIGINS` env, comma-separated; default
    `https://serhiimartynenko.github.io`), `Allow-Methods: POST, OPTIONS`, `Allow-Headers: Authorization, Content-Type`, `Max-Age: 86400`.
  - `POST` → forward to `https://openrouter.ai` + same path (only `/api/v1/*` allowed) with `Authorization` and `Content-Type`
    copied from the request, body streamed through, response streamed back with CORS headers added. No key stored in the worker.
  - Anything else → 404/405. Reject disallowed origins with 403.
- README → "Troubleshooting: Preflight response is not successful (403)" section: what it means, remedies in order,
  worker deployment steps (dashboard paste or `wrangler deploy`), how to set the endpoint in the app.

Acceptance: with the endpoint empty, the outgoing request has only the two headers; with an endpoint set, requests go there;
a Grok model sends `reasoning.effort`, an Anthropic model sends `reasoning.max_tokens`; the worker passes a local unit check
(OPTIONS from allowed origin → 204 + CORS headers; disallowed origin → 403; POST forwarded with Authorization preserved).

### WS-V · Verification  — **Opus**  (after WS-A)

- Serve the folder locally, drive it with the pre-installed Playwright + Chromium, mock `openrouter.ai` with a route that
  returns an SSE stream containing `reasoning` and `content` deltas. Check: no console errors; presets; settings persistence
  across reload; a full streamed turn renders; the manifest link resolves to JSON with absolute `start_url`; the endpoint
  override is honoured; the network-failure message appears when the route aborts.
- Run the worker tests with Node (`node --test proxy/cloudflare-worker.test.mjs` or an inline script).
- Report results verbatim.

## Deployment note

GitHub Pages currently deploys from `claude/github-pages-chat-deploy-h64nfp` (the workflow lists that branch and `main`,
and no `main` exists). To publish this work: Actions → "Deploy to GitHub Pages" → Run workflow → pick
`claude/adoring-hamilton-cq46ew`, or merge this branch into the deploy branch.

## Out of scope

Changing how the key is stored, adding a required backend, changing the history format (`orchat.history.v1`).

## Follow-up (2026-11-08, after deploy)

The owner confirmed the block persists with their protection tools on and chose to keep them. A personal proxy
was deployed through the Cloudflare API to the owner's account as Worker `ownchat-proxy` with
`ALLOWED_ORIGINS=https://serhiimartynenko.github.io`, reachable at
`https://ownchat-proxy.ownchat-serhii.workers.dev`. The app now retries a blocked direct call once through that
proxy (`FALLBACK_PROXY_URL`) and persists it as the endpoint on success, so no manual setting is needed.
