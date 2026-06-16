# MarkVault-JS

A powerful annotation plugin for **Obsidian**. MarkVault-JS keeps your highlights, bold, underlines, notes, tags, relations, and custom fields **inside your Markdown files**, backed by a fast sharded-JSON index with a rich relation graph.

## Features

- **Multi-style annotations**: Highlight (`<mark>`), Bold (`<b>`), Underline (`<u>`) — all rendered inline in Reading mode
- **Annotation notes & tags**: Attach notes and tags to any annotation
- **4 annotation types**: Inline (text selection), Block (code/math/image/table), Span (cross-segment), Region (free-range)
- **Relation system**: 16 active + 14 passive relation types across 6 semantic dimensions (Taxonomic, Argumentative, Referential, Comparative, Causal, Temporal, Part-whole)
- **Relation graph**: Interactive force-directed graph visualization with semantic color palette, curvature routing, and chip-grouped rendering
- **Custom fields & templates**: Add structured metadata like `category=定义` or `importance=高`
- **Sidebar panel**: Browse, search, filter, batch-edit, export, view statistics, and manage relations
- **Click-to-jump**: Click any annotation card to jump to its source text
- **Reading mode support**: Create and edit annotations directly in Obsidian's reading/preview mode
- **Sharded JSON + Markdown storage**: Annotations live in your notes; a local JSON shard index keeps queries fast
- **Offset recovery**: Multi-layer algorithm keeps annotations accurate after edits
- **W3C Web Annotation compatible**: Import/export annotations using the W3C Web Annotation Data Model
- **Maintenance commands**: Force sync, rebuild database, clean orphan annotations, and W3C import/export

## Storage Architecture

MarkVault-JS stores annotation data in two places:

1. **Markdown source files** — inline `<mark>`, `<b>`, `<u>` tags for inline annotations; `%%markvault:%%` anchors for block/span/region annotations
2. **Sharded JSON index** — one `.json` file per note under the vault's plugin data folder, used for fast querying, statistics, relations, and custom fields

> **Note**: MarkVault-JS does not use IndexedDB. If you are upgrading from an older version that did, run **"Rebuild annotation database"** from the command palette to migrate.

## Installation

### From GitHub Releases

1. Go to [Releases](https://github.com/zc63463-cmyk/obsidian-markvault-js/releases) and download the latest release
2. Extract the zip into your vault's `.obsidian/plugins/markvault-js/` directory
3. Enable **MarkVault-JS** in Obsidian → Settings → Community Plugins
4. Restart Obsidian

### Manual Build

```bash
npm install
npm run build
```

Copy the built files into `.obsidian/plugins/markvault-js/`.

## Development

```bash
npm install          # install dependencies
npm run dev           # watch build (development)
npm run build         # production build + type check
npm test              # run full test suite (379 tests)
```

## Useful Commands

Open the Obsidian command palette (`Ctrl/Cmd + P`) and search for:

| Command | Description |
|---|---|
| **Highlight / Bold / Underline selection** | Annotate selected text |
| **Annotate current block** | Annotate code/math/image blocks |
| **Annotate region** | Free-range region annotation |
| **Annotate and add note** | Create annotation with attached note |
| **Force sync current file** | Recover annotation offsets after edits |
| **Rebuild annotation database** | Full DB rebuild (use after migration or external edits) |
| **Clean orphan annotations** | Remove DB entries whose Markdown source no longer exists |
| **Export W3C Annotations** | Export as W3C Web Annotation JSON |
| **Import W3C Annotations** | Import from W3C Web Annotation JSON |

## Relation Types

MarkVault-JS supports 30 built-in relation types organized into 6 semantic groups:

- **Taxonomic**: generalizes, specializes, elaborates, exemplifies, illustrates
- **Argumentative**: supports, contradicts, proves, refutes, questions
- **Referential**: cites, quotes, comments-on, responds-to
- **Comparative**: compares, contrasts-with, analogizes-to
- **Causal**: causes, enables, results-from
- **Temporal**: precedes, follows
- **Part-whole**: part-of, has-part
- **Passive**: generalized-by, specialized-in, elaborated-by, exemplified-by, illustrated-by, supported-by, contradicted-by, proved-by, refuted-by, questioned-by, cited-by, quoted-by, commented-by, responded-by

## Tech Stack

- TypeScript 5.7 + ESBuild
- Obsidian SDK ^1.7.2
- force-graph (relation graph visualization)
- 12 inverted indexes for query performance
- Schema-first type system with 30 built-in relation kinds

## Version History

| Plugin Version | Min App Version | Notes |
|---|---|---|
| 5.0.0 | 1.7.2 | Semantic graph v5.12, codebase refactor (P2), bug fixes BUG-8~11 |
| 4.x | 1.5.0 | Relation graph, sharded JSON migration |
| 3.x | 0.15.0 | Sharded JSON architecture |
| 2.x | 0.15.0 | Early feature development |
| 1.x | 0.15.0 | Initial release |

## License

[MIT](LICENSE)

## Author

[Jiang](https://github.com/zc63463-cmyk)
