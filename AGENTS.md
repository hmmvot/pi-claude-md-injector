# CLAUDE.md Injector Extension

This repository contains the source for the pi extension `claude-md-injector`.

## What the extension does

The extension adds Claude Code-like `CLAUDE.md` behavior to pi, layered on top of pi's built-in root/ancestor `AGENTS.md` / `CLAUDE.md` context loading:

- asks the agent to read bootstrap instruction files (`CLAUDE.md` and `.claude/CLAUDE.md`) plus their `@` imports;
- discovers nested `CLAUDE.md` files from prompt paths and tool activity, so folder-specific rules are applied when working in subtrees;
- expands `@` links inside `CLAUDE.md` files up to depth 5, resolving relative to the file that contains the link;
- skips pure-alias `CLAUDE.md` files whose content is only `@` imports and nudges the agent to read the targets directly;
- resets instruction-read tracking after compaction, so relevant rules are re-read in the new session segment;
- provides `/claude-md-injector [path]` to inspect applicable files, read/unread status, alias files, and linked imports.

## Source of truth

The source of truth is the repository file:

```text
claude-md-injector.ts
```

Do not treat any developer's local/global pi installation as source of truth. Installed copies are deployment artifacts only.

## Public repository rules

- Keep all instructions portable: do not hard-code user-specific absolute paths, usernames, machine names, or private workspace locations.
- Prefer cross-platform paths and commands in docs. Use `~/.pi/agent/extensions/` for global pi examples when needed.
- Do not assume the maintainer has the extension installed globally. If local testing needs an installed copy, use `npm run install:pi`; the script installs to the current user's `~/.pi/agent/extensions/` directory, or to `$PI_AGENT_EXTENSIONS_DIR` when that environment variable is set.
- Do not push to GitHub or create/push tags unless the user explicitly asks.

## Pi package rules

- Keep this repository installable with:

  ```bash
  pi install git:github.com/hmmvot/pi-claude-md-injector
  ```

- `package.json` must keep:
  - `pi-package` in `keywords`;
  - `pi.extensions` pointing to `./claude-md-injector.ts`;
  - `license: "MIT"`;
  - correct GitHub `repository`, `bugs`, and `homepage` URLs.
- `private: true` is acceptable for GitHub/git installation. Remove it only when preparing npm registry publishing.

## Development rules

- Read pi extension docs before changing extension behavior:
  - `docs/extensions.md`
  - `docs/packages.md`
  - relevant examples under `examples/extensions/`
- Preserve intentional performance trade-offs unless explicitly changing the design:
  - shallow scan depth 3;
  - skipped dirs: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.cache`;
  - empty shallow scan early-out.
- Do not scan arbitrary `read` output for paths; only direct tool inputs and path-navigation tool results (`find`, `grep`, `ls`) should drive nested `CLAUDE.md` discovery.
- Keep read-tracking semantics intact: custom session entries track files read by tools and files preloaded by pi, and only entries since the last compaction count.

## Validation rules

Before committing changes, run:

```bash
npm run check
npm pack --dry-run
```

If package install behavior changed, also test:

```bash
npm run install:pi
```

Before releasing, confirm:

- working tree is clean;
- `main` contains the release commit;
- README install commands match the actual package source;
- README tag examples correspond to an existing release tag.
