# Ownchat

A single-file, mobile-first chat web app that talks to **OpenRouter** models
(Claude Opus/Sonnet/Haiku and others) using your own API key. The key and chat
history stay in your browser's `localStorage` and are sent directly to
OpenRouter — there's no backend.

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

It's a single `index.html` — open it directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```
