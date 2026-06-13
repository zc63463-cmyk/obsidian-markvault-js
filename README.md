# MarkVault-JS

A powerful annotation plugin for Obsidian. MarkVault-JS keeps your highlights, bold, underlines, notes, tags, and custom fields **inside your Markdown files**, while using a fast local sharded-JSON index for queries and the sidebar.

## Features

- 🎨 **Multi-style annotations**: Highlight, Bold, Underline
- 📝 **Annotation notes**: Attach notes/comments to any annotation
- 🏷️ **Tags**: Organize annotations with tags
- 🧩 **Custom fields & templates** (Phase 3): Add structured metadata like `category=定义` or `importance=高`
- 📦 **Block & span annotations**: Annotate code blocks, formulas, images, tables, and multi-segment text
- 📊 **Sidebar panel**: Browse, search, filter, batch-edit, export, and view statistics
- 🔗 **Click-to-jump**: Click any annotation card to jump to its source text
- 🧭 **Reading mode support**: Create and edit annotations directly in Obsidian’s reading/preview mode
- 💾 **Sharded JSON + Markdown storage**: Annotations live in your notes; a local JSON shard index keeps queries fast
- 🔄 **Offset recovery**: Multi-layer algorithm keeps annotations accurate after edits
- 🛠️ **Maintenance commands**: Force sync, rebuild database, and clean orphan annotations

## Storage Architecture

MarkVault-JS stores annotation data in two places:

1. **Markdown source files** — inline `<mark>` tags for inline annotations, and `%%markvault:%%` anchors for block/span annotations.
2. **Sharded JSON index** — one `.json` file per note under the vault’s plugin data folder, used for fast querying, statistics, and custom fields.

> **Note**: MarkVault-JS no longer uses IndexedDB. If you are upgrading from an older version, run **"Rebuild annotation database"** from the command palette to migrate.

## Installation

1. Download or build the latest release
2. Extract/copy the plugin into your vault’s `.obsidian/plugins/markvault-js/` directory
3. Enable **MarkVault-JS** in Obsidian → Settings → Community Plugins

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm test         # run annotation store tests
```

## Useful Commands

Open the Obsidian command palette (`Ctrl/Cmd + P`) and search for:

- **Highlight / Bold / Underline selection**
- **Annotate current block** — for code/math/image blocks
- **Annotate and add note**
- **Force sync current file annotations**
- **Rebuild annotation database** — use after external Markdown edits or migration
- **Clean orphan annotations** — remove DB entries whose Markdown source no longer exists

## Version

Current plugin version: **3.0.0**
