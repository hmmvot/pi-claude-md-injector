# CLAUDE.md Injector for pi

A pi extension that brings Claude Code-like `CLAUDE.md` behavior to pi.

pi already loads root/ancestor `AGENTS.md` and `CLAUDE.md` files into the system prompt. This extension layers on top of that built-in behavior by nudging the agent to read additional `CLAUDE.md` files and their `@` imports when they become relevant to the current task.

## Features

- Reads bootstrap instruction files from:
  - `CLAUDE.md`
  - `.claude/CLAUDE.md`
- Expands Claude-style `@path/to/file.md` imports up to depth 5.
- Resolves `@` imports relative to the file that contains the import.
- Discovers nested `CLAUDE.md` files from:
  - paths mentioned in the user prompt;
  - direct tool path inputs (`read`, `write`, `edit`, `grep`, `find`, `ls`);
  - path-navigation tool output (`find`, `grep`, `ls`).
- Avoids scanning arbitrary `read` output for paths, so documentation indexes do not accidentally trigger unrelated rules.
- Skips pure-alias `CLAUDE.md` files that contain only `@` imports and asks the agent to read the targets directly.
- Resets read tracking after compaction so relevant instructions are re-read in the new session segment.
- Provides `/claude-md-injector [path]` for status/debugging.

## Installation

### Option 1: install as a pi package

Install it directly with pi:

```bash
pi install git:github.com/hmmvot/pi-claude-md-injector
```

To pin a specific release or commit:

```bash
pi install git:github.com/hmmvot/pi-claude-md-injector@v0.1.0
```

Use `-l` for a project-local install instead of a global install:

```bash
pi install -l git:github.com/hmmvot/pi-claude-md-injector
```

### Option 2: copy the extension manually

Copy `claude-md-injector.ts` into your global pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp claude-md-injector.ts ~/.pi/agent/extensions/claude-md-injector.ts
```

Then restart pi or run:

```text
/reload
```

### Option 3: use the local install script

```bash
npm install
npm run install:pi
```

The script copies `claude-md-injector.ts` into `~/.pi/agent/extensions/claude-md-injector.ts`.

## Usage

Create instruction files in your project:

```text
CLAUDE.md
.claude/CLAUDE.md
src/CLAUDE.md
src/components/CLAUDE.md
```

Use `@` imports inside any `CLAUDE.md` file:

```md
# Project rules

@docs/coding-style.md
@.claude/testing.md
```

When pi starts or when the agent interacts with paths under folders that contain nested `CLAUDE.md` files, the extension reminds the agent to read the relevant unread instruction files.

Inspect extension state with:

```text
/claude-md-injector
/claude-md-injector src/components/Button.tsx
```

The status command shows applicable `CLAUDE.md` files, linked imports, alias files, read/unread state, and compaction information.

## Intentional limitations

These are performance trade-offs, not bugs:

- Nested discovery uses a shallow pre-scan with depth 3.
- The scan skips `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, and `.cache`.
- If the shallow scan finds no nested `CLAUDE.md` files, the extension stops searching for additional nested files for the session segment.
- `@` import expansion is cached by the top file's mtime. If a transitively linked file changes, touch the top `CLAUDE.md` or reload pi to refresh the cache.

## Development

Install dependencies and type-check:

```bash
npm install
npm run check
```

Install the local source into pi:

```bash
npm run install:pi
```

After changing the installed global extension, reload pi:

```text
/reload
```

See `AGENTS.md` for repo-specific maintenance rules.

## License

MIT. See [LICENSE](LICENSE).
