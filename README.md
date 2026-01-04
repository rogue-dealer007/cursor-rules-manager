# Cursor Rules Manager ⚡

A beautiful local UI for managing Cursor AI rules. Stop the AI from fucking things up by enforcing which files it must read.

![Cursor Rules Manager](https://img.shields.io/badge/Cursor-Rules%20Manager-6366f1?style=for-the-badge)

## Features

- 🌍 **Global Rules**: Define rules that apply to ALL your projects
- 📂 **Project Rules**: Create `.cursor/rules/*.mdc` files per project
- 🔥 **Must-Read Files**: Force AI to read specific files before doing anything
- 🔍 **Auto-scan Projects**: Automatically finds your Cursor/Git projects
- ✨ **Beautiful UI**: Dark mode, modern design, zero friction

## Quick Start

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/cursor-rules-manager.git
cd cursor-rules-manager

# Install
npm install

# Run
npm start

# Open http://localhost:3847
```

## How It Works

1. **Add scan paths** in Settings (e.g., `~/code`, `~/projects`)
2. **Click a project** to manage its rules
3. **Create rules** with the "Must Read Files" picker
4. Rules are saved as `.cursor/rules/*.mdc` files in your projects

## Rule Format

Rules use `.mdc` format (Markdown + YAML frontmatter):

```markdown
---
description: "Core project rules"
alwaysApply: true
---

# Files You MUST Read

Before doing ANYTHING, you MUST read and understand these files:

- `src/lib/db.ts`
- `src/types/index.ts`

**DO NOT proceed without reading these files first.**

# Instructions

- Use the existing database utilities
- Follow the type definitions
```

## Config Location

Config is stored in `~/.cursor-rules-manager/`:
- `global-rules.md` - Your global rules
- `projects.json` - Scan paths and settings

## License

MIT
