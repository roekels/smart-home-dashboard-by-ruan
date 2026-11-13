# Brain

The household's long-term notes: a tree of notes with links between them, every earlier version kept, and a sealed
tier for sensitive notes. This Worker owns one D1 database and has no address of its own; the dashboard and the MCP
gateway reach it over service bindings.

| Caller | Entrypoint | What it gets |
| --- | --- | --- |
| Dashboard (`/home/brain`, the map) | `BrainUi` | The graph, one note, search, what changed, and the page's own writes, as the signed-in person |
| Gateway (`/brain/mcp`) | `Brain` | The 16 tools in `src/contract.ts`, held to the connection's scopes |

## Shape

- **Roots**: one per person in `household.config.json` (their first name) and one shared root, "Family" unless the
  var `BRAIN_SHARED_ROOT` says otherwise. They are made on first use.
- **Paths** are chains of titles: `Family/Home/Boiler`. Every note has one parent.
- **Links** are `[[Title]]` or `[[Path|shown text]]` in the text; `related`, `followed`, `caused_by` and `about` in
  the frontmatter are typed links. Renaming or moving a note updates the links to it in every other note.
- **Records** are dated rows on a note (a meter reading, a price), added with `record_add`.
- **Nothing is deleted.** An edit keeps the old version (`history`, `restore`); `lock_archive` freezes a note as
  long-distance memory until it is unlocked.

## Sensitive notes

A note is sensitive when it sits in a branch called `Health` or `Private`, when its parent is sensitive, or when its
frontmatter says `sensitivity: sensitive`. Its text and records are encrypted with `BRAIN_SENSITIVE_ENCRYPTION_KEY`
(AES-GCM, `packages/core/src/seal.ts`); search only knows its title.

- A **person** (the dashboard, or an AI app they connected with OAuth) reaches sensitive notes under their own root
  and the shared root, never under another person's.
- A **gateway key** reaches all roots it has the sensitive scopes for. The assistant's key has none.
- While the key is unset, sensitive notes cannot be read or written; everything else works. If the key is lost,
  those notes cannot be read again, so keep a copy where `secrets.manifest.json` says.

## Scopes

`brain.read`, `brain.create`, `brain.update`, `brain.archive` (lock and unlock), and for the sealed tier
`brain.read.sensitive` and `brain.write.sensitive`. The gateway offers them on its consent page; this Worker checks
them again on every call. Text that looks like a password, an API key or a card number is refused on every write:
note where a secret lives, never its value.

## The map

`apps/shell/web/src/modules/brain/` draws the notes as a 3D (or 2D) graph: a note is a dot in its root's colour, lines
are the tree and the links. Click a note to read or edit it, `/` searches, "New note" adds one. Changes made elsewhere
show up within 20 seconds. The graph, markdown and sanitising libraries are built into one file,
`/vendor/brain-map.js`, by the UI build and loaded only on this page; `apps/shell/web/vendor/THIRD_PARTY.md` lists what
is in it.

## Left out on purpose

File attachments, importing an existing notes folder, and a scheduled backup. `BrainUi.exportAll` returns everything a
person may read as JSON lines, for the data export module.

## Tests

`npm test` at the repository root runs `test/brain.test.ts` against an in-memory SQLite stand-in for D1
(`packages/core/test/fakes/d1.ts`). Demo mode answers the page from `demo/data/brain.json` (`demo.ts`).
