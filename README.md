# Ownchat

A mobile-first chat web app (the root chat is a single file) that talks to **OpenRouter** models
using your own API key. Presets include Grok 4.7 (the default) and Grok 4.5, plus
Claude Opus 4.8 / Opus 4.8 fast / Sonnet 4.6 / Haiku 4.5; any other OpenRouter
model slug can be typed in. The key and chat
history stay in your browser's `localStorage` and are sent directly to
OpenRouter — there's no backend. (If your network is blocked from calling
OpenRouter directly, you can optionally point the app at a tiny personal proxy;
see [Troubleshooting](#troubleshooting-preflight-response-is-not-successful-403).)

## Features

- Streaming responses (SSE) with live "thinking" / reasoning panel
- Markdown rendering with sanitisation (marked + DOMPurify)
- Model picker with presets, adjustable reasoning effort, optional system prompt
- Attach `.md` / `.txt` files, full-screen reader, export to Markdown
- Installable as a home-screen PWA (generated icons + manifest), iOS-tuned UI

## Usage

1. Open the deployed site (see below).
2. Tap the gear / model pill and paste your
   [OpenRouter API key](https://openrouter.ai/keys).
3. Pick a model and start chatting.

> Your API key lives only in this browser. Anyone with access to the device can
> read it from `localStorage`, so don't add a key on a shared machine.

## Troubleshooting: Preflight response is not successful (403)

Safari / Chrome console shows something like:

```
Preflight response is not successful. Status code: 403
Fetch API cannot load https://openrouter.ai/api/v1/chat/completions due to access control checks.
```

and the app says *"Request was blocked before it reached OpenRouter"*.

**What it means.** Before sending your message the browser makes a CORS
"preflight" (`OPTIONS`) request. That preflight was answered with 403, so the
browser never sent the real request. Your key and message did not reach
OpenRouter.

**What it is not.** OpenRouter's CORS policy is fine: a normal preflight from
this site's origin gets `204` with `Access-Control-Allow-Origin: *` and allows
the `Authorization` and `Content-Type` headers (the only two the app sends).
The 403 comes from the Cloudflare bot / IP / region protection in front of
openrouter.ai rejecting *your particular browser and network path*. VPNs,
iCloud Private Relay and some countries/regions are the usual triggers. No
change to this app's code can make Cloudflare accept a path it has decided to
block, so the fixes are on the network side.

**What the app does about it.** When the direct call is blocked, the app
retries the same request once through the owner's personal proxy
(`https://ownchat-proxy.ownchat-serhii.workers.dev`, deployed from
`proxy/cloudflare-worker.js`) and, if that works, saves it as the endpoint in
Settings → Advanced so later messages go straight to the proxy. Clear that
field to go back to direct calls. The proxy only accepts requests from this
site's origin and never stores the key.

**If the proxy is blocked too, remedies in order:**

1. Try another network (e.g. mobile data instead of Wi-Fi, or vice versa), or
   turn off a VPN / iCloud Private Relay for a moment to confirm the cause.
2. Deploy your own copy of the proxy (below) and set it in Settings → Advanced.

### Optional personal proxy (Cloudflare Worker)

[`proxy/cloudflare-worker.js`](proxy/cloudflare-worker.js) is a ~90-line,
dependency-free Worker. It answers the preflight itself, forwards `POST`s under
`/api/v1/` to `https://openrouter.ai`, streams the response back and adds CORS
headers for an allow-list of origins. It copies only the `Authorization` and
`Content-Type` headers; your key is forwarded in that header and is never
stored or logged by the proxy.

Deploy from the dashboard (free tier is enough):

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**
   (start from "Hello World"), give it a name, **Deploy**.
2. **Edit code**, replace everything with the contents of
   `proxy/cloudflare-worker.js`, **Deploy**.
3. Worker → **Settings → Variables and Secrets** → add a text variable
   `ALLOWED_ORIGINS` = `https://serhiimartynenko.github.io` (comma-separate
   more origins, e.g. `http://localhost:8000`, if you need them). If unset it
   defaults to that origin.
4. **Deploy** again so the variable takes effect.

Or from a terminal: `npx wrangler deploy proxy/cloudflare-worker.js --name ownchat-proxy --compatibility-date 2026-01-01`
(then set `ALLOWED_ORIGINS` in the dashboard or with `--var ALLOWED_ORIGINS:https://serhiimartynenko.github.io`).

Then in the app: **Settings → Advanced → API endpoint (optional proxy)** =

```
https://<your-worker>.<your-subdomain>.workers.dev/api/v1/chat/completions
```

and **Save**. Clear the field to go back to calling OpenRouter directly.

**Alternative host: Deno Deploy.** A Worker's outbound request to OpenRouter
also passes through Cloudflare and can be blocked if the Worker runs in a
blocked region. In that case deploy the same code on Deno Deploy instead:
create a project from this repo with entry point `proxy/deno.ts`, set
`ALLOWED_ORIGINS`, and use `https://<project>.deno.dev/api/v1/chat/completions`
as the endpoint.

Proxy tests (Node 20+): `node --test proxy/cloudflare-worker.test.mjs`

## Deploying on GitHub Pages

This repo ships with a GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`) that publishes the static site.

One-time setup in the GitHub repo:

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

Every push to the deploy branch (or `main`) then publishes automatically. The
live URL appears in the Actions run summary and under Settings → Pages, usually:

```
https://serhiimartynenko.github.io/Ownchat-/
```

## Development

The chat is a single root `index.html` — open it directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Writing tool (preview)

The AI writing app lives in `write/` and is published at
`https://serhiimartynenko.github.io/Ownchat-/write/`. It is a separate PWA on the
same origin as the chat, with its own storage keys, and it leaves the root chat
untouched. It uses ES modules, so it must be served over http (it won't work from
`file://`): run `python3 -m http.server` from the repo root and open `/write/`.

Features so far:

- Projects, chapters and scenes, with a scene editor that autosaves.
- Scenes open as paragraph blocks: tap a paragraph to edit it in place, tap its
  handle (or hold it) to select it, extend the selection to neighbours. A "Write"
  button switches to a plain full-text editor and back; selecting text there shows
  the same action bar for that selection.
- AI actions on the selection: Rewrite, Tighten, Expand, Tone, Custom and
  Continue. The result streams into a preview with a word-level diff; Accept
  replaces the paragraphs, Retry takes an extra instruction, Reject discards.
  Actions use the writing model and reasoning level from Settings.
- "To scene" on a chat reply puts the reply into the open scene: replace the
  editor's selection, append it, or replace the whole scene (a version is saved).
- Versions: accepting an AI change snapshots the previous text; "Save version"
  and "Versions…" live in the scene menu. Up to 30 versions per scene are kept on
  the device (they are not part of the export bundle).
- Chat is scoped: every scene has its own thread (open it from the scene with the
  chat button; switch between Scene and Project at the top of the chat), and the
  project thread stays for whole-book talk. The open scene is sent along with the
  project chat (toggle in the chat).
- Scene summaries: when you leave a scene whose text changed, the utility model
  writes a short digest of it in the background. Later scenes and the project chat
  get a "Story so far" layer built from those digests (out-of-date ones are marked).
  "Summary…" in the scene menu shows, edits and regenerates a scene's digest.
- Proposed facts: the same digest calls (and chat summaries) suggest new characters,
  places and plot threads. They appear in a Proposed section at the top of the story
  bible, where you accept or dismiss them; the model never edits approved cards.
- Export and import as an `.ownchat.zip` bundle (Markdown per scene and card plus a
  manifest, lossless), and export of the manuscript as Markdown.
- iOS: use "Save to Files" from the share sheet. Safari auto-unzips plain downloads,
  but a re-zipped folder still imports.
- Desktop layout: from 1024px wide the outline is a sidebar beside the scene and
  chat; from 1280px the scene chat opens next to the editor. Sheets become centered
  dialogs. Escape closes the topmost sheet. The phone layout is unchanged.
- Data lives in IndexedDB on the device, so export regularly. Settings has a Storage
  section with the current status and a "Protect" button that asks the browser not to
  clear the data (on iPhone, add the app to the Home Screen first).
- Backup reminders: the library suggests protecting storage, and reminds you to export
  when a project changed and was not exported for 7 days. "Later" snoozes a notice.
- Long chats show the latest 60 messages; "Show earlier messages" reveals more.
- Optional sync is explored in `docs/SYNC.md` (not implemented).

Run all tests with `npm test` (or `node --test`).

`npm run e2e` runs the browser end-to-end checks for phases 1 to 5 (needs Playwright +
Chromium installed locally). `npm run perf` times the main steps on a project of about
115k words with a 4x CPU slowdown.
