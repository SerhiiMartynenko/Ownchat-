# Ownchat Writing Tool: Design

Status: phases 1 to 3 are implemented under `write/` (live at `/Ownchat-/write/`); later phases are still design. Branch: `claude/ai-writing-tool-planning-fowkbw`.

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
edits.

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
the rolling summary (section 4). Any message has "save as card" and "save as
scene note". The current scene is always in context for a scene thread.

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
- **Scene**: block editor (main writing surface). Floating button opens the
  scene's chat thread as a sheet over the editor so text stays visible.
- **Chat**: current thread with the context meter at the top.
- **Bible**: cards by type, Proposed section on top.
- **Settings**: API key, writing model, utility model, reasoning effort, proxy
  endpoint, storage status, export.

Desktop: Outline, Scene and Chat/Bible side by side.

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
   long manuscripts, optional sync exploration.

## 13. Implementation policy

Code for every phase is written by subagents running on Opus-class or lower
models (Opus for design-sensitive modules, Sonnet for mechanical work). The
top-level session only briefs, reviews and verifies. Each phase ends with the
app usable on the phone PWA and with `node --test` passing for any new
pure-logic modules (context budgeting, diff, export/import).

## Implementation notes (phases 1 to 3)

Deviations from the design above:

- The brief and the style guide live on the bible record. A project points at its
  bible and chat thread through `bibleId` and `threadId`.
- The first project adopts the phase 1 `default` bible and thread records, so
  existing data is migrated in place rather than copied.
- Scenes store `blocks[]`, built from the textarea by splitting on blank lines. Soft
  line breaks inside a paragraph are not preserved.
- The scene layer sits after the cards and before the summary. This reaches
  Anthropic's limit of 4 cache breakpoints, so phase 4 must merge markers.
- Settings stay in localStorage, not IndexedDB.
- Phase 3: the blocks surface is the default scene view, and a "Write" mode keeps the
  plain textarea for long typing; both edit the same draft and share one autosave.
  Rewrite requests are built separately from the chat context (rules + style guide +
  brief, then matched cards) and use at most 2 cache breakpoints. Versions are kept
  on the device only, capped at 30 per scene, and are not in the export bundle.
