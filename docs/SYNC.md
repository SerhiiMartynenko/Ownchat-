# Optional sync: exploration

Status: exploration only, nothing is implemented. Phase 5 left sync out of the code on purpose.

## Constraints

Any sync must respect the app's principles: static hosting on GitHub Pages, no backend of ours,
the user's own keys, a phone-first PWA, and the export/import bundle as a first-class format.
It must be optional and off by default, and the app must stay fully usable offline.

## What needs syncing

- Projects, chapters and scenes (text, order, titles, summaries).
- The story bible: brief, style guide and cards, including proposed cards.
- Chat threads (project and scene).
- Scene versions: optional. They are large and device-local today; syncing them is a later extra.
- Settings are excluded: the API key and endpoint must never leave the device, and models are per-device taste.

## Options

### (a) Manual bundle through any cloud folder

Export the `.ownchat.zip` bundle to Files, iCloud Drive or any cloud folder, import it on the other device.
This exists today. Pros: no new code, works on iOS, the user controls everything. Cons: manual, and import
replaces a project, so edits on both devices are lost or must be merged by hand.

### (b) File System Access API folder (desktop Chromium)

The user picks a folder once; the app rewrites the bundle there after changes, and a cloud client syncs the folder.
Pros: automatic on desktop, no credentials. Cons: not available on iOS Safari or Firefox, needs a permission
re-grant per session, and the cloud client decides conflicts by file copy. Useful only as a desktop convenience.

### (c) The user's own GitHub repository or Gist

The app talks to the GitHub REST API from the browser with a fine-grained personal token, stored like the
OpenRouter key (local only, never in an export). It would need: a token scoped to one repository with contents
read and write, a repository chosen in Settings, and a file layout equal to the bundle (Markdown per scene and card,
plus the manifest). Pros: works from the PWA on iOS, versioned history for free, no server of ours, readable files.
Cons: GitHub rate limits (fine for one writer, but many small files need the Git Data API or batching), the token is
a sensitive secret on the device, and conflicts must be handled by the client using the ETag or blob `sha` of each
file (a write with a stale `sha` is rejected, which is a safe signal to merge). A Gist is simpler but has no folders
and is awkward for a long manuscript.

### (d) WebDAV or Nextcloud

Same shape as (c) with a different protocol. Pros: self-hosted, no vendor. Cons: most servers do not send CORS
headers a browser needs, so it usually cannot be reached from a static page without the user configuring the server.
Not worth building first.

### (e) CRDT (Yjs) over a relay

Rejected. It needs a relay server or a paid service, which breaks the no-backend principle, and it changes the data
model from plain records to CRDT documents, complicating the bundle, summaries and versions for a single-author tool.

## Conflict model

Writing is one author on a few devices, so conflicts are rare and mostly sequential. A simple model is enough:

- Per-record last-writer-wins, keyed by `updatedAt`. The unit is the record: a scene, a card, a thread, the bible.
- Scene versions are the safety net. Before a remote copy overwrites a local scene whose text differs, the local
  text is saved as a version, so nothing typed is lost.
- Deletes need tombstones (id plus deletion time), otherwise a deleted scene returns from the other device.
- The bundle manifest is the exchange format, so (a), (b) and (c) share one merge routine, which is also testable
  in Node like the existing import code.
- Chat threads merge by message id, because they only append.

What the store would need:

- A per-record revision or a change log, so the app knows what changed since the last sync.
- A sync cursor and the remote identifiers (repository, branch, file `sha` values) in the `meta/app` record.
- Tombstone records, pruned after a retention period.
- Clock care: `updatedAt` comes from the device clock, so ties and small skews are resolved toward keeping both
  (the loser becomes a version).

## Recommendation

Build (c), GitHub repository sync, as an optional phase 6 behind a Settings switch, and add (b) as a desktop
convenience that reuses the same merge routine. Keep (a) as the always-available fallback.

Rough size: a pure merge module with tests, a GitHub client (list, read, write with `sha`), the store changes above,
a Settings section and a sync status line. This is about as large as phase 3 or 4 combined, with most risk in the
store changes rather than the network code.

Risks:

- Token handling: scope it to one repository and warn that it is stored on the device.
- Data loss from a bad merge: mitigated by versions, a "sync now" that shows what will change, and the bundle export.
- Rate limits and request count on a long manuscript: sync only changed files, using the change log.
- Private manuscripts in a repository: require a private repository and say so in the UI.
- iOS background limits: sync runs when the app is open, not in the background.
