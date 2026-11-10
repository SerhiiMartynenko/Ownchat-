# Ownchat Writing Tool: Design

Status: phases 1 to 5 are implemented under `write/` (live at `/Ownchat-/write/`). Branch: `claude/ai-writing-tool-planning-fowkbw`.

## 1. Goal

Grow Ownchat from a single chat into an AI-assisted tool for writing long-form
fiction, while keeping its principles: static site on GitHub Pages, no backend,
the user's own OpenRouter key, phone-first PWA.

Problems this design solves:

- Every turn replays the whole conversation (cost, latency, context exhaustion).
- The model loses the author's intent stated many messages earlier.
- The model loses character traits and place details.
- No way to select a passage and rewrite it in place.

## 2. Core shift: document-centric, not chat-centric

The manuscript is the product. Chat becomes a side surface attached to the
manuscript. Durable facts (intent, style, characters, places) live in a
persistent "story bible", never only in chat history. Every model request is
assembled fresh from layered sources under a token budget instead of replaying
history.

## 3. Data model (IndexedDB)

- **Project**: id, title, brief (intent and current goal, user-edited),
  styleGuide (voice, tense, POV, things to avoid), createdAt, updatedAt.
- **Chapter**: id, projectId, order, title.
- **Scene**: id, chapterId, order, title, blocks[] (paragraphs as text blocks
  with ids), summary, summaryHash (hash of the text the summary was made from),
  wordCount, updatedAt.
- **Card** (story bible): id, projectId, type (character | place | thread |
  note), name, aliases[], fields{} (small structured fields per type), body
  (free text), pinned (always included), status (approved | proposed), source
  (where a proposed fact came from).
- **Thread** (chat): id, projectId, scope (project | scene:<sceneId>),
  messages[], summary (rolling summary of folded messages), summarizedUpTo
  (index/marker), updatedAt.
- **Version**: id, sceneId, blocks[], reason (rewrite accepted | manual save |
  import), createdAt.
- **Settings**: apiKey, writingModel, utilityModel, reasoning level, endpoint
  (proxy), storage flags.

Storage notes: request `navigator.storage.persist()`; installed PWA is largely
exempt from Safari's 7-day eviction. The project is per device; export/import
(section 8) is first-class. Cloud sync is a possible later optional layer.

## 4. Context assembly (replaces history replay)

One function builds every request from layers, stable content first so
providers that support prompt caching can reuse the prefix (Anthropic via
OpenRouter needs explicit `cache_control` markers, which the client sets on the
stable layers):

1. System role + style guide + brief.
2. Bible cards: all pinned cards, plus cards whose name or alias appears in the
   current scene text or the selection (simple string matching, no embeddings).
3. Story so far: chain of scene summaries up to the current scene.
4. The current scene in full, or the block window around the selection
   (two blocks before and after by default).
5. Chat memory: the thread's rolling summary plus the last N messages verbatim.
6. The instruction (user message or rewrite action).

Budget rules: trim from the bottom of the story-so-far chain and the oldest
verbatim chat first. Never trim the brief, style guide or the target text.
A context meter in the UI shows an estimate per layer.

Background work on the utility model:

- Scene summary regenerated when `summaryHash` no longer matches the text.
- Thread summary extended when the verbatim tail exceeds its budget; folded
  messages remain stored but are no longer sent.
- Bible fact extraction (section 6).

## 5. Editor: paragraph blocks

Each paragraph is a block. Tap a block to edit it in place (textarea sized to
content). Long-press (or a handle) selects the block; extend to neighbours.
Native in-text selection inside a block is also supported for sentence-level
edits. In Write mode (the plain textarea) a native text selection shows the same
toolbar and the action applies to exactly the selected text.

AI block toolbar: Rewrite, Tighten, Expand, Tone, Continue, Custom instruction.

Rewrite contract:

- Request contains: style guide, brief, relevant cards, two blocks before and
  after for continuity, the target text, the instruction, and a strict
  "return only the replacement prose" rule.
- Response streams into a preview beside the original, not into the document.
  Word-level diff highlights changes.
- Accept replaces the target blocks and writes a Version. Retry keeps the
  target and lets the user adjust the instruction. Reject discards.
- Guard strips stray code fences or preambles; if the response is clearly a
  chat answer rather than prose, the preview says so and offers Retry.
- "Continue from here" uses the same path with an empty target and inserts
  new blocks after the cursor.

## 6. Story bible

Cards grouped by type with brief and style guide as the first two entries.
A "Proposed" section lists facts the utility model spotted in new writing or
chat; the user accepts (becomes an approved card or field update) or dismisses.
The model never writes to approved cards directly.

## 7. Chat

Threads are scoped: one per scene and one per project. Older messages fold into
the rolling summary (section 4). Any message has "save as card", and a reply has
"To scene" (replace the editor's selection, append, or replace the whole scene;
a version is saved first). The current scene is always in context for a scene
thread. Chat never edits the document on its own.

## 8. Export and import

- Project bundle: zip with one Markdown file per scene (short front matter:
  chapter, order, title), one Markdown file per card, and a JSON manifest for
  ids and ordering. Lossless round trip.
- Manuscript-only Markdown export (as today) for sharing.
- Import of the bundle creates or replaces a project.

## 9. Screens (phone first)

- **Library**: projects, new, import.
- **Outline**: chapters and scenes with word counts and summary preview; reorder
  and open.
- **Scene**: block editor (main writing surface). The chat button opens the
  scene's chat thread as a full-screen chat with a Scene / Project scope switch;
  Back returns to the scene. (A sheet over the editor was considered and dropped:
  on a phone it leaves too little of the text visible to be useful.)
- **Chat**: current thread with the context meter at the top.
- **Bible**: cards by type, Proposed section on top.
- **Settings**: API key, writing model, utility model, reasoning effort, proxy
  endpoint, storage status, export.

Desktop (implemented in phase 5): from 1024px the outline is a sidebar beside the
scene and chat views; from 1280px the scene chat opens beside the editor instead of
replacing it; sheets become centered dialogs. The phone layout is unchanged.

## 10. Code layout (no build step)

ES modules served statically from GitHub Pages; Markdown and sanitiser via CDN
as today.

- `app/db.js`: IndexedDB wrapper and schema/migrations.
- `app/context.js`: layered context assembly and token budgeting.
- `app/api.js`: streaming client and proxy fallback (moved from index.html).
- `app/summaries.js`: scene and thread summaries, fact extraction (utility model).
- `app/editor.js`: block editor, selection, rewrite preview and diff.
- `app/bible.js`, `app/chat.js`, `app/outline.js`, `app/export.js`.
- `app/ui/*`: sheets, toolbar, meter, settings.
- `index.html` becomes the shell.

## 11. Migration from the current app

The existing single chat becomes the project thread of a default project; the
system prompt becomes the style guide; settings carry over. Streaming client,
proxy fallback, Markdown rendering, settings sheet and PWA shell move into
modules unchanged.

## 12. Phases

1. **Bible + context pipeline in today's chat UI.** Brief, style guide and cards
   feed every request; rolling thread summary; utility model slot; context
   meter. Fixes lost intent and traits immediately.
2. **Project store and outline.** IndexedDB schema, projects, chapters, scenes,
   migration of the existing chat, export/import bundle.
3. **Block editor with rewrite.** Blocks, selection toolbar, rewrite contract,
   preview and diff, versions, Continue.
4. **Scoped chat and summaries.** Scene threads, chat as a sheet, scene
   summaries with story-so-far, proposed bible facts.
5. **Polish.** Desktop layout, storage persistence prompts, performance on
   long manuscripts, optional sync exploration. Implemented; sync is explored in
   `docs/SYNC.md`.

## 13. Implementation policy

Code for every phase is written by subagents running on Opus-class or lower
models (Opus for design-sensitive modules, Sonnet for mechanical work). The
top-level session only briefs, reviews and verifies. Each phase ends with the
app usable on the phone PWA and with `node --test` passing for any new
pure-logic modules (context budgeting, diff, export/import).

## Implementation notes (phases 1 to 5)

Deviations from the design above:

- The brief and the style guide live on the bible record. A project points at its
  bible and chat thread through `bibleId` and `threadId`.
- The first project adopts the phase 1 `default` bible and thread records, so
  existing data is migrated in place rather than copied.
- Scenes store `blocks[]`, built from the textarea by splitting on blank lines. Soft
  line breaks inside a paragraph are not preserved.
- Layer order is style guide and brief, cards, story so far, current scene, thread
  summary. When all five are present the first two share one cache marker, so
  Anthropic requests never exceed 4 breakpoints.
- Settings stay in localStorage, not IndexedDB.
- Phase 3: the blocks surface is the default scene view, and a "Write" mode keeps the
  plain textarea for long typing; both edit the same draft and share one autosave.
  Rewrite requests are built separately from the chat context (rules + style guide +
  brief, then matched cards) and use at most 2 cache breakpoints. Versions are kept
  on the device only, capped at 30 per scene, and are not in the export bundle.
- Phase 4: scene threads are stored as `ts-<sceneId>` with `scope:"scene"`; the
  chat opens as a full view (route `#/s/<id>/chat`), not a sheet. Scene summaries are
  made by the utility model when the author leaves a changed scene of at least 40
  words; staleness is a hash of the scene text against `summaryHash`, and stale
  digests are still sent, marked as possibly out of date. Proposed facts ride on the
  summary calls (scene digest and chat fold) as a `### Proposed facts` section and
  become cards with `status:"proposed"` and a `source`; `matchCards` ignores them
  until accepted. The bundle stays at version 1: scene threads are added as
  `chat/scene-*.json` files listed under `sceneThreads` in the manifest.

Phase 5:

- Layout is driven by two media queries in `main.js` (1024px and 1280px) that set
  `body[data-layout]` and re-run the current route when they change. A `split`
  pseudo-view activates the scene and chat sections together. The phone layout is
  unchanged. Escape closes the topmost open sheet.
- Storage: Settings has a Storage section (status, used space, an iPhone install hint
  and a Protect button). `navigator.storage.persist()` is still requested at boot;
  the button repeats it explicitly. The library shows a notice when storage is not
  protected and at least one project exists (snoozed 30 days), or a backup reminder
  when a project of 500+ words changed and was not exported for 7 days (snoozed 7
  days). Dismissals and export times are kept in the `meta/app` record under
  `notices` and `exports`.
- Performance: scenes store `textHash` on every save, and staleness checks use it
  instead of hashing text. `project.stats` is maintained with deltas on save and
  recomputed when it is inconsistent, so the library no longer loads every scene
  (no schema bump; both caches heal themselves). Chat history renders in windows of
  60 messages with a "Show earlier messages" button. `npm run perf` seeds a project
  of about 115k words, applies a 4x CPU slowdown and times the main steps. Recorded
  numbers: library open 12 ms, outline 80 to 90 ms, largest scene 21 ms, scene chat
  52 to 74 ms, project chat 39 ms, export 525 ms, import 380 ms.
