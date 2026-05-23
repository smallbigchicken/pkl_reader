---
name: "vscode-extension-builder"
description: "Builds a production-ready VS Code extension (scaffold → features → packaging → Marketplace publish checklist). Invoke when user asks to create/modify/publish a VS Code extension or needs TreeView/Webview/Custom Editor."
---

# VS Code Extension Builder

This skill helps you design, implement, package, and publish VS Code extensions with a practical, end-to-end workflow.

## When to Invoke

Invoke this skill when the user:
- Wants to create a new VS Code extension from scratch
- Wants to add extension features (Tree View, Commands, Webview, Custom Editor, Language features)
- Wants to package the extension to a `.vsix`
- Wants to publish the extension to VS Code Marketplace
- Is blocked by publishing prerequisites (Publisher, tokens, packaging warnings, file inclusion)

## Inputs to Collect (Ask Early)

- Extension goal and target file types (e.g. `.pkl`, `.log`, `.foo`)
- Default UX: Tree View, Custom Editor, Commands, or combination
- Runtime dependencies (Node only, Python helper, other CLI)
- Target platforms (VS Code only / VS Code + others)
- Publishing intent (Marketplace vs internal vs `.vsix` only)

## Implementation Playbook

### 1) Scaffold (TypeScript)

Required contributions in `package.json`:
- `activationEvents`
- `contributes.commands`
- `contributes.viewsContainers` / `contributes.views` (if Tree View)
- `contributes.customEditors` (if Custom Editor)
- `contributes.configuration` (user settings)

Suggested file layout:
- `src/extension.ts` (activation entry)
- `dist/extension.js` (compiled output)
- `media/` (webview assets)
- `resources/` (icons)
- Optional runtime helper: `python/` or `bin/`

### 2) Feature Patterns

Tree View:
- Provide a `TreeDataProvider` with a stable node model (id/path/label/type)
- Add `refresh` command and auto-refresh based on active editor selection

Custom Editor (readonly preview):
- Implement `CustomReadonlyEditorProvider`
- Render UI via Webview
- Use message passing (`postMessage`) to refresh, search, copy path, etc.

Runtime helper (Python/CLI):
- Spawn a separate process
- Prefer a stable JSON protocol between extension and helper
- Always surface errors as user-facing nodes/messages and log details to an `OutputChannel`

### 3) Packaging Hygiene

Add `.vscodeignore` or `package.json.files` to keep VSIX minimal:
- Exclude: `src/`, tests, local datasets, build caches
- Exclude sensitive / large files by default

Verify packaging:
- `vsce package`
- Install locally via “Install from VSIX…”

### 4) Marketplace Publishing Checklist

Prepare metadata:
- `publisher` matches Marketplace Publisher name exactly
- `repository`, `homepage`, `bugs`, `license`
- `README.md` describes install/config/usage clearly
- A proper icon (png recommended)

Publishing options:
- CLI publish: `vsce publish` (requires Marketplace publish credentials)
- Portal upload: upload `.vsix` from Marketplace manage UI

Common failure modes:
- Publisher not created / not linked to the account
- Token scope missing (Marketplace Manage)
- VSIX contains unwanted files (fix `.vscodeignore`)

## Output Expectations

When invoked, produce:
- A short architecture + file plan
- Concrete file edits with paths
- A verification plan (packaging + install + core feature checks)
- A publishing path (CLI publish or portal upload) with minimal required steps

