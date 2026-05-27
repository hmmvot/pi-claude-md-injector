import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Inline Pi extension that simulates Claude Code-like `CLAUDE.md`
 * behavior inside Pi.
 *
 * Pi already loads root/ancestor `AGENTS.md` / `CLAUDE.md` files into the
 * system prompt at startup. This extension intentionally layers on top of
 * that built-in behavior to add three Claude-specific behaviors Pi does not
 * provide by itself:
 *   1. nested `CLAUDE.md` discovery driven by prompt/tool activity,
 *   2. `@`-link expansion inside `CLAUDE.md`,
 *   3. post-compaction re-nudging so relevant instructions are re-read.
 *
 * Hooks:
 *  - `before_agent_start` — instructs the agent to read the bootstrap
 *    `CLAUDE.md` files (cwd and .claude/) and any files they `@`-import
 *    (depth ≤ 5) that haven't already been read or pre-loaded by Pi in the
 *    current post-compaction segment of the session.
 *  - `tool_result` — scans direct tool target paths, plus output only for
 *    path-navigation tools (`find` / `grep` / `ls`), then walks up to `cwd`
 *    collecting `CLAUDE.md` files along the way; tells the agent to read the
 *    unread ones so per-folder rules are honored. It intentionally does not
 *    scan arbitrary `read` output, because documentation often contains path
 *    indexes that are not files the agent is actually working with.
 *
 * Optimizations / intentional limitations:
 *  - Shallow pre-scan (depth ≤ 3, excluding node_modules/.git/dist)
 *    runs once on first tool_result. If nothing is found, this session
 *    intentionally stops searching for additional nested `CLAUDE.md`
 *    files. This is a deliberate perf trade-off, not a bug.
 *  - `@`-import expansion is cached by file mtime to avoid re-reading
 *    bootstrap files on every event.
 *  - Files whose content is purely `@`-imports plus whitespace
 *    ("pure alias" stubs) are dropped from the nudge — the agent is
 *    told to read the targets directly instead, skipping a useless
 *    `read` on the alias file itself.
 *
 * Read-tracking is done by appending custom session entries
 * (`claude-md-injector-read` for tool reads, `claude-md-injector-pi-context`
 * for files Pi pre-loaded via `systemPromptOptions.contextFiles`). Lookups
 * consider only entries since the last compaction, by design. After a
 * compaction, the extension treats instruction-read state as reset and will
 * nudge the agent to read relevant instruction files again.
 *
 * Also registers a `/claude-md-injector` slash command that prints
 * status: which `CLAUDE.md` files are applicable, which were read this
 * session, which are pure aliases, and which `@`-linked files they
 * pulled in. Pass a path (`/claude-md-injector src/foo`) to inspect just
 * the files that would apply to that path.
 */

const READ_TRACK_ENTRY = 'claude-md-injector-read';
const PI_CONTEXT_TRACK_ENTRY = 'claude-md-injector-pi-context';

const LINK_DEPTH_LIMIT = 5;
const MAX_TEXT_SCAN = 1_000_000;
const MAX_DISK_CHECKS = 500;
const SHALLOW_SCAN_DEPTH = 3;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache']);
const DIRECT_TARGET_PATH_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const CONTENT_SCANNED_TOOL_RESULT_TOOLS = new Set(['find', 'grep', 'ls']);

type LinkedInstructionFile = {
    file: string;
    via: string[];
};

type InstructionBreakdown = {
    claudeFiles: string[];
    linkedFiles: LinkedInstructionFile[];
    allFiles: string[];
};

function getLinkedFiles(filePath: string, cwd: string, depth = 0, visited: Set<string> = new Set()): string[] {
    if (depth >= LINK_DEPTH_LIMIT || visited.has(filePath)) return [];
    visited.add(filePath);

    const links: string[] = [];
    try {
        if (!fs.existsSync(filePath)) return [];
        const content = fs.readFileSync(filePath, 'utf8');
        const regex = /@([\w./\\-]+)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            const linkPath = match[1];
            if (!linkPath) continue;

            // Claude-style `@` references should resolve relative to the file
            // that contains them. Fall back to cwd only for legacy/root-level
            // references that were authored with that assumption.
            let target = path.resolve(path.dirname(filePath), linkPath);
            if (!fs.existsSync(target)) {
                target = path.resolve(cwd, linkPath);
            }

            if (fs.existsSync(target) && fs.statSync(target).isFile() && !visited.has(target)) {
                links.push(target);
                links.push(...getLinkedFiles(target, cwd, depth + 1, visited));
            }
        }
    } catch {
        // ignore read errors
    }
    return links;
}

// Cache transitive @-import expansion by (filePath, cwd), invalidated when the
// top file's mtime changes. Tradeoff: if a transitively-linked file changes but
// the top file doesn't, the cache stays stale until the top file is touched or
// the process restarts. CLAUDE.md changes mid-session are vanishingly rare.
const linkedFilesCache = new Map<string, { mtimeMs: number; result: string[] }>();

function getLinkedFilesCached(filePath: string, cwd: string): string[] {
    let mtimeMs: number;
    try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
        return [];
    }

    const key = `${filePath}|${cwd}`;
    const cached = linkedFilesCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs) return cached.result;

    const result = getLinkedFiles(filePath, cwd);
    linkedFilesCache.set(key, { mtimeMs, result });
    return result;
}

// Detect a file whose content is only `@`-imports plus whitespace ("pure alias").
// Such files add no information of their own — the nudge skips them and tells
// the agent to read the @-targets directly. Cached by mtime.
const pureAliasCache = new Map<string, { mtimeMs: number; pure: boolean }>();

function isPureAliasFile(filePath: string): boolean {
    let mtimeMs: number;
    try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
        return false;
    }

    const cached = pureAliasCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.pure;

    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return false;
    }

    const stripped = content.replace(/@[\w./\\-]+/g, '').trim();
    const pure = stripped.length === 0;
    pureAliasCache.set(filePath, { mtimeMs, pure });
    return pure;
}

function findLastCompaction(entries: any[]): any | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === 'compaction') return entries[i];
    }
    return undefined;
}

function getEntriesSinceLastCompaction(entries: any[]): any[] {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === 'compaction') {
            return entries.slice(i + 1);
        }
    }
    return entries;
}

function normalizePathForCompare(targetPath: string, cwd?: string): string {
    const resolved = cwd ? path.resolve(cwd, targetPath) : path.resolve(targetPath);
    return resolved.replace(/\\/g, '/').toLowerCase();
}

function tryRealpath(targetPath: string): string {
    try {
        return fs.realpathSync.native(targetPath);
    } catch {
        try {
            return fs.realpathSync(targetPath);
        } catch {
            return path.resolve(targetPath);
        }
    }
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
    const comparableTarget = fs.existsSync(targetPath) ? tryRealpath(targetPath) : path.resolve(targetPath);
    const comparableRoot = fs.existsSync(rootPath) ? tryRealpath(rootPath) : path.resolve(rootPath);
    const relative = path.relative(comparableRoot, comparableTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getPathWalkStart(targetPath: string, cwd: string): string | undefined {
    const resolved = path.resolve(cwd, targetPath).replace(/[/\\]+$/, '');
    const candidate = resolved.length > 0 ? resolved : path.resolve(cwd);

    if (fs.existsSync(candidate)) {
        if (!isPathWithinRoot(candidate, cwd)) return undefined;
        return fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
    }

    const parent = path.dirname(candidate);
    if (!isPathWithinRoot(parent, cwd)) return undefined;
    return parent;
}

function matchesRequestedPath(requestedPath: string | undefined, file: string, cwd: string): boolean {
    if (!requestedPath) return false;
    return normalizePathForCompare(requestedPath, cwd) === normalizePathForCompare(file);
}

function toolBatchReadIncludesFile(input: any, file: string, cwd: string): boolean {
    const calls = Array.isArray(input?.calls) ? input.calls : [];
    for (const call of calls) {
        const toolName = call?.tool ?? call?.name;
        if (toolName !== 'read') continue;

        const requestedPath = call?.args?.path ?? call?.path ?? call?.arguments?.path;
        if (matchesRequestedPath(requestedPath, file, cwd)) return true;
    }
    return false;
}

function wasFileReadThisSession(entries: any[], file: string, cwd: string): boolean {
    const normalizedFile = normalizePathForCompare(file);

    return entries.some((e) => {
        if (e.type === 'custom' && (e.customType === READ_TRACK_ENTRY || e.customType === PI_CONTEXT_TRACK_ENTRY)) {
            const trackedPath = typeof e.data?.path === 'string' ? normalizePathForCompare(e.data.path) : '';
            return trackedPath === normalizedFile;
        }

        if (e.type !== 'message' || e.message?.role !== 'toolResult') return false;

        if (e.message.toolName === 'read') {
            return matchesRequestedPath(e.message.input?.path, file, cwd);
        }

        if (e.message.toolName === 'tool_batch') {
            return toolBatchReadIncludesFile(e.message.input, file, cwd);
        }

        return false;
    });
}

function collectPiContextPaths(contextFiles: Array<{ path: string; content?: string }> | undefined): string[] {
    const paths = new Set<string>();
    for (const file of contextFiles ?? []) {
        if (typeof file?.path === 'string' && file.path.length > 0) {
            paths.add(path.resolve(file.path).replace(/\\/g, '/'));
        }
    }
    return Array.from(paths);
}

function collectReadPathsFromToolInput(toolName: string | undefined, input: any, cwd: string): string[] {
    return collectDirectToolTargetPaths(toolName, input, cwd, 'read');
}

function getNestedToolInput(call: any): any {
    return call?.args ?? call?.arguments ?? call;
}

function collectDirectToolTargetPaths(
    toolName: string | undefined,
    input: any,
    cwd: string,
    onlyToolName?: string,
): string[] {
    const targetPaths = new Set<string>();

    function addToolTarget(candidateToolName: string | undefined, candidateInput: any) {
        if (!candidateToolName) return;
        if (onlyToolName && candidateToolName !== onlyToolName) return;
        if (!DIRECT_TARGET_PATH_TOOLS.has(candidateToolName)) return;

        const requestedPath = candidateInput?.path;
        if (typeof requestedPath === 'string') {
            targetPaths.add(path.resolve(cwd, requestedPath).replace(/\\/g, '/'));
        }
    }

    if (toolName === 'tool_batch') {
        const calls = Array.isArray(input?.calls) ? input.calls : [];
        for (const call of calls) {
            addToolTarget(call?.tool ?? call?.name, getNestedToolInput(call));
        }
    } else {
        addToolTarget(toolName, input);
    }

    return Array.from(targetPaths);
}

function shouldScanToolResultContent(toolName: string | undefined, input: any): boolean {
    if (!toolName) return false;
    if (CONTENT_SCANNED_TOOL_RESULT_TOOLS.has(toolName)) return true;

    if (toolName !== 'tool_batch') return false;

    const calls = Array.isArray(input?.calls) ? input.calls : [];
    return calls.length > 0 && calls.every((call: any) => {
        const nestedTool = call?.tool ?? call?.name;
        return CONTENT_SCANNED_TOOL_RESULT_TOOLS.has(nestedTool);
    });
}

function getBootstrapClaudeFiles(cwd: string): string[] {
    const candidates = [path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')];
    return candidates.filter((file, index, array) => fs.existsSync(file) && array.indexOf(file) === index);
}

// Shallow recursive scan for CLAUDE.md files up to a given depth.
// Skips node_modules, .git, dist, etc. Returns resolved absolute paths.
function shallowScanClaudeMds(dir: string, depth: number, skipDirs: Set<string>, found: Set<string>): void {
    if (depth < 0) return;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.isFile() && entry.name === 'CLAUDE.md') {
            found.add(path.resolve(path.join(dir, entry.name)));
        } else if (entry.isDirectory()) {
            if (skipDirs.has(entry.name)) continue;
            shallowScanClaudeMds(path.join(dir, entry.name), depth - 1, skipDirs, found);
        }
    }
}

function getTextToScanFromToolResultContent(message: any): string {
    let textToScan = '';

    const content = message?.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block?.type === 'text' && block?.text) {
                textToScan += block.text + '\n';
            }
        }
    } else if (typeof content === 'string') {
        textToScan += content + '\n';
    }

    if (textToScan.length > MAX_TEXT_SCAN) {
        textToScan = textToScan.slice(0, MAX_TEXT_SCAN);
    }

    return textToScan;
}

function sanitizePromptForPathScan(prompt: string): string {
    const withoutFencedCodeBlocks = prompt.replace(/```[\s\S]*?```/g, '\n');
    return withoutFencedCodeBlocks
        .split(/\r?\n/)
        .filter((line) => !isToolTranscriptLine(line))
        .join('\n');
}

function isToolTranscriptLine(line: string): boolean {
    return /^\s*●\s+Batch\s+\d+\/\d+\s+·/.test(line) ||
        /^\s*(?:[├└]─\s*)?Read\s+.+\s+·\s+\d+\s+lines?\s*$/.test(line) ||
        /^\s*─{3,}\s*$/.test(line);
}

function extractPotentialPaths(textToScan: string): string[] {
    const potentialPaths = new Set<string>();
    const tokens = textToScan.split(/[\s'"`\[\]{}()<>:;,|*]+/);

    for (const token of tokens) {
        const cleaned = token.replace(/^[`]+|[`]+$/g, '').replace(/[!?]+$/g, '');
        if (!cleaned || cleaned.length < 3) continue;
        if (/^(https?:\/\/|file:\/\/)/i.test(cleaned)) continue;

        const looksPathLike =
            cleaned.includes('/') ||
            cleaned.includes('\\') ||
            cleaned.startsWith('./') ||
            cleaned.startsWith('../') ||
            cleaned.startsWith('.\\') ||
            cleaned.startsWith('..\\') ||
            /^[~.]?[\w-]+\.[a-zA-Z0-9]{2,5}$/.test(cleaned);

        if (looksPathLike) {
            potentialPaths.add(cleaned);
        }
    }

    return Array.from(potentialPaths);
}

function buildInstructionBreakdown(claudeFiles: string[], cwd: string): InstructionBreakdown {
    const directClaudeFiles = Array.from(new Set(claudeFiles)).sort();
    const linkedFileSources = new Map<string, Set<string>>();

    for (const md of directClaudeFiles) {
        for (const link of getLinkedFilesCached(md, cwd)) {
            if (directClaudeFiles.includes(link)) continue;
            const sources = linkedFileSources.get(link) ?? new Set<string>();
            sources.add(md);
            linkedFileSources.set(link, sources);
        }
    }

    const linkedFiles = Array.from(linkedFileSources.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, via]) => ({ file, via: Array.from(via).sort() }));

    return {
        claudeFiles: directClaudeFiles,
        linkedFiles,
        allFiles: [...directClaudeFiles, ...linkedFiles.map((entry) => entry.file)],
    };
}

type FileDiscoveryOptions = {
    bootstrapPaths?: Set<string>;
    claudeMdCache?: Set<string>;
    existsCache?: Map<string, boolean>;
    diskBudget?: { used: number; limit: number };
};

function fileExistsWithCache(filePath: string, options: Pick<FileDiscoveryOptions, 'existsCache' | 'diskBudget'> = {}): boolean {
    const { existsCache, diskBudget } = options;
    if (!existsCache) return fs.existsSync(filePath);
    if (existsCache.has(filePath)) return existsCache.get(filePath) ?? false;
    if (diskBudget && diskBudget.used >= diskBudget.limit) return false;

    if (diskBudget) diskBudget.used += 1;
    const exists = fs.existsSync(filePath);
    existsCache.set(filePath, exists);
    return exists;
}

function collectClaudeFilesForTarget(targetPath: string, cwd: string, options: FileDiscoveryOptions = {}): string[] {
    const { bootstrapPaths, claudeMdCache } = options;
    const discoveredClaudeFiles: string[] = [];

    try {
        let current = getPathWalkStart(targetPath, cwd);
        if (!current) return [];

        while (true) {
            if (!isPathWithinRoot(current, cwd)) break;

            const claudePath = path.join(current, 'CLAUDE.md');
            const claudePathResolved = path.resolve(claudePath);
            const claudePathNormalized = normalizePathForCompare(claudePathResolved);
            const alreadyKnown = Boolean(claudeMdCache?.has(claudePathResolved));
            const exists = alreadyKnown || fileExistsWithCache(claudePath, options);

            if (exists) {
                if (!bootstrapPaths?.has(claudePathNormalized)) {
                    discoveredClaudeFiles.push(claudePath);
                }
                claudeMdCache?.add(claudePathResolved);
            }

            if (normalizePathForCompare(current) === normalizePathForCompare(cwd)) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    } catch {
        // ignore invalid paths
    }

    return discoveredClaudeFiles.reverse();
}

function expandInstructionReadPlan(seedClaudeFiles: string[], cwd: string): string[] {
    const orderedFiles: string[] = [];
    const seenClaudeFiles = new Set<string>();
    const seenLinkedFiles = new Set<string>();

    function visitClaudeFile(claudePath: string) {
        const normalizedClaudePath = normalizePathForCompare(claudePath);
        if (seenClaudeFiles.has(normalizedClaudePath)) return;
        seenClaudeFiles.add(normalizedClaudePath);
        orderedFiles.push(claudePath);

        for (const linkedFile of getLinkedFilesCached(claudePath, cwd)) {
            visitLinkedFile(linkedFile);
        }
    }

    function visitLinkedFile(filePath: string) {
        const normalizedFilePath = normalizePathForCompare(filePath);
        if (seenLinkedFiles.has(normalizedFilePath)) return;
        seenLinkedFiles.add(normalizedFilePath);

        for (const parentClaudeFile of collectClaudeFilesForTarget(filePath, cwd)) {
            visitClaudeFile(parentClaudeFile);
        }

        orderedFiles.push(filePath);
    }

    for (const seedClaudeFile of seedClaudeFiles) {
        visitClaudeFile(seedClaudeFile);
    }

    return orderedFiles;
}

function collectLinkedInstructionCandidates(claudeFiles: Iterable<string>, cwd: string): string[] {
    const candidateInstructionFiles: string[] = [];
    const seenFiles = new Set<string>();

    function addFile(filePath: string) {
        const normalizedFilePath = normalizePathForCompare(filePath);
        if (seenFiles.has(normalizedFilePath)) return;
        seenFiles.add(normalizedFilePath);
        candidateInstructionFiles.push(filePath);
    }

    for (const claudeFile of claudeFiles) {
        addFile(claudeFile);
        for (const linkedFile of getLinkedFilesCached(claudeFile, cwd)) {
            addFile(linkedFile);
        }
    }

    return candidateInstructionFiles;
}

function filterUnreadInstructionFiles(candidateFiles: Iterable<string>, entries: any[], cwd: string): string[] {
    const unreadInstructionFiles: string[] = [];
    const seenFiles = new Set<string>();

    for (const file of candidateFiles) {
        if (isPureAliasFile(file)) continue;
        if (wasFileReadThisSession(entries, file, cwd)) continue;

        const normalizedFilePath = normalizePathForCompare(file);
        if (seenFiles.has(normalizedFilePath)) continue;
        seenFiles.add(normalizedFilePath);
        unreadInstructionFiles.push(file);
    }

    return unreadInstructionFiles;
}

function buildInstructionBreakdownForPath(targetPath: string, cwd: string, claudeMdCache: Set<string> | undefined): InstructionBreakdown {
    // If cache is confirmed empty (shallow scan found nothing), skip entirely.
    // This early-out is intentional: the extension trades away deep-only nested
    // discovery for a one-time fast negative check per session.
    if (claudeMdCache !== undefined && claudeMdCache.size === 0) {
        return { claudeFiles: [], linkedFiles: [], allFiles: [] };
    }

    const bootstrapPaths = new Set(getBootstrapClaudeFiles(cwd).map((file) => normalizePathForCompare(file)));
    const applicableClaudeFiles = collectClaudeFilesForTarget(targetPath, cwd, { bootstrapPaths, claudeMdCache });
    return buildInstructionBreakdown(applicableClaudeFiles, cwd);
}

function formatStatusLine(file: string, cwd: string, entries: any[]): string {
    const relPath = path.relative(cwd, file).replace(/\\/g, '/');
    const status = wasFileReadThisSession(entries, file, cwd) ? 'read' : 'unread';
    const aliasTag = isPureAliasFile(file) ? ' (alias)' : '';
    return `- [${status}] ${relPath}${aliasTag}`;
}

function formatStatusReport(args: string, ctx: ExtensionCommandContext, claudeMdCache: Set<string> | undefined): string {
    const cwd = ctx.cwd;
    const branchEntries = ctx.sessionManager.getBranch();
    const entriesSinceCompaction = getEntriesSinceLastCompaction(branchEntries);
    const lastCompaction = findLastCompaction(branchEntries);

    const bootstrapClaudeFiles = getBootstrapClaudeFiles(cwd);
    const rootBreakdown: InstructionBreakdown = bootstrapClaudeFiles.length > 0
        ? buildInstructionBreakdown(bootstrapClaudeFiles, cwd)
        : { claudeFiles: [], linkedFiles: [], allFiles: [] };
    const bootstrapPaths = new Set(rootBreakdown.allFiles.map((f) => f.toLowerCase()));

    // From cache: only show files that were actually read this session
    const readFromCache: string[] = [];
    if (claudeMdCache && claudeMdCache.size > 0) {
        for (const file of claudeMdCache) {
            if (bootstrapPaths.has(file.toLowerCase())) continue;
            if (wasFileReadThisSession(entriesSinceCompaction, file, cwd)) {
                readFromCache.push(file);
            }
        }
    }
    readFromCache.sort();

    const lines: string[] = [];
    lines.push('# CLAUDE.md Injector Status');
    lines.push('');
    lines.push(`- cwd: ${cwd.replace(/\\/g, '/')}`);
    if (claudeMdCache !== undefined && claudeMdCache.size === 0) {
        lines.push('- early out: enabled (this session will not search for additional CLAUDE.md files)');
    }
    if (lastCompaction) {
        lines.push(`- last compaction: ${lastCompaction.timestamp ?? 'unknown'} (${lastCompaction.id ?? 'no-id'})`);
    } else {
        lines.push('- last compaction: none in current branch');
    }
    lines.push(`- entries since last compaction: ${entriesSinceCompaction.length}`);

    lines.push('');
    lines.push('## CLAUDE.md files');
    if (rootBreakdown.claudeFiles.length === 0 && readFromCache.length === 0) {
        lines.push('- none');
    } else {
        for (const file of rootBreakdown.claudeFiles) {
            lines.push(formatStatusLine(file, cwd, entriesSinceCompaction));
        }
        for (const file of readFromCache) {
            lines.push(formatStatusLine(file, cwd, entriesSinceCompaction));
        }
    }

    lines.push('');
    lines.push('## links');
    if (rootBreakdown.linkedFiles.length === 0) {
        lines.push('- none');
    } else {
        for (const entry of rootBreakdown.linkedFiles) {
            const via = entry.via.map((file) => path.relative(cwd, file).replace(/\\/g, '/')).join(', ');
            lines.push(`${formatStatusLine(entry.file, cwd, entriesSinceCompaction)} <- ${via}`);
        }
    }

    const targetArg = args.trim();
    if (targetArg) {
        const pathScopedBreakdown = buildInstructionBreakdownForPath(targetArg, cwd, claudeMdCache);
        lines.push('');
        lines.push(`## For path: ${targetArg.replace(/\\/g, '/')}`);
        lines.push('### CLAUDE.md files');
        if (pathScopedBreakdown.claudeFiles.length === 0) {
            lines.push('- none');
        } else {
            for (const file of pathScopedBreakdown.claudeFiles) {
                lines.push(formatStatusLine(file, cwd, entriesSinceCompaction));
            }
        }
        lines.push('');
        lines.push('### links');
        if (pathScopedBreakdown.linkedFiles.length === 0) {
            lines.push('- none');
        } else {
            for (const entry of pathScopedBreakdown.linkedFiles) {
                const via = entry.via.map((file) => path.relative(cwd, file).replace(/\\/g, '/')).join(', ');
                lines.push(`${formatStatusLine(entry.file, cwd, entriesSinceCompaction)} <- ${via}`);
            }
        }
    } else {
        lines.push('');
        lines.push('Tip: run `/claude-md-injector path/to/file` to inspect path-specific files.');
    }

    return lines.join('\n');
}

export default function (pi: ExtensionAPI) {
        // Bootstrap files cache (cwd/CLAUDE.md, cwd/.claude/CLAUDE.md)
        let cachedCwd: string | null = null;
        let cachedBootstrapFiles: string[] = [];

        function getCachedBootstrapClaudeFiles(cwd: string): string[] {
            if (cwd === cachedCwd) return cachedBootstrapFiles;
            cachedCwd = cwd;
            cachedBootstrapFiles = getBootstrapClaudeFiles(cwd);
            return cachedBootstrapFiles;
        }

        // Shallow-scan cache — set once on first tool_result, never changes:
        //   undefined  = not yet scanned
        //   empty Set  = scanned, nothing found → permanent early-out
        //   populated  = scanned, contains all CLAUDE.md found within depth 3
        //
        // This is intentionally a perf trade-off: if the first shallow scan
        // finds nothing, the extension treats the repo as "no nested CLAUDE.md
        // worth chasing this session" and stops doing expensive follow-up
        // discovery. Deep-only CLAUDE.md trees are therefore intentionally not
        // supported unless a bootstrap file or shallow hit exists.
        let claudeMdCache: Set<string> | undefined = undefined;

        function ensureClaudeMdCache(cwd: string): Set<string> {
            if (claudeMdCache === undefined) {
                const found = new Set<string>();
                shallowScanClaudeMds(cwd, SHALLOW_SCAN_DEPTH, SKIP_DIRS, found);
                claudeMdCache = found;
            }
            return claudeMdCache;
        }

        pi.registerCommand('claude-md-injector', {
            description: 'Show CLAUDE.md injector status for this session',
            handler: async (args, ctx) => {
                const content = formatStatusReport(args, ctx, claudeMdCache);
                pi.sendMessage(
                    {
                        customType: 'claude-md-injector-status',
                        content,
                        display: true,
                    },
                    { triggerTurn: false },
                );
            },
        });

        pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
            // Pi already preloads root/ancestor context files into the system
            // prompt. We track them here so this extension can layer nested
            // discovery and `@`-link expansion on top without re-nudging for
            // files Pi has already supplied.
            for (const contextPath of collectPiContextPaths(event.systemPromptOptions?.contextFiles)) {
                pi.appendEntry(PI_CONTEXT_TRACK_ENTRY, { path: contextPath });
            }

            const bootstrapClaudeFiles = getCachedBootstrapClaudeFiles(ctx.cwd);
            const bootstrapPaths = new Set(bootstrapClaudeFiles.map((file) => normalizePathForCompare(file)));

            // Phase 1: scan the prompt for file paths, but ignore pasted code
            // blocks and tool transcripts. A transcript line like
            // "├─ Read Tools/CLAUDE.md · 28 lines" is evidence of a past tool
            // result, not evidence that the current task is about Tools/.
            // We intentionally allow non-existent target paths here so prompts
            // like "create src/foo.ts" still inherit the nearest applicable
            // CLAUDE.md from parent dirs.
            const promptScopedClaudeFiles: string[] = [];
            const promptToScan = sanitizePromptForPathScan(event.prompt ?? '');
            for (const promptPath of extractPotentialPaths(promptToScan)) {
                promptScopedClaudeFiles.push(
                    ...collectClaudeFilesForTarget(promptPath, ctx.cwd, { bootstrapPaths }),
                );
            }

            const bootstrapReadPlan = expandInstructionReadPlan(bootstrapClaudeFiles, ctx.cwd);
            const promptReadPlan = expandInstructionReadPlan(promptScopedClaudeFiles, ctx.cwd);
            ensureClaudeMdCache(ctx.cwd);

            // Bootstrap instructions stay first so root context remains stable,
            // then prompt-scoped nested instructions add specificity.
            const entries = getEntriesSinceLastCompaction(ctx.sessionManager.getBranch());
            const unreadInstructionFiles = filterUnreadInstructionFiles(
                [...bootstrapReadPlan, ...promptReadPlan],
                entries,
                ctx.cwd,
            );

            if (unreadInstructionFiles.length > 0) {
                const filesList = unreadInstructionFiles
                    .map((file) => `- ${path.relative(ctx.cwd, file).replace(/\\/g, '/')}`)
                    .join('\n');
                return {
                    message: {
                        customType: 'claude-md-injector-read-reminder',
                        content: `Before answering, read these instruction files:\n${filesList}`,
                        display: false,
                    },
                };
            }
            return;
        });

        pi.on('tool_result', async (event: ToolResultEvent, ctx: ExtensionContext) => {
            const claudeFileCache = ensureClaudeMdCache(ctx.cwd);

            // By design, an empty shallow cache disables further nested discovery
            // for the rest of the session segment.
            if (claudeFileCache.size === 0) return;

            const cwd = ctx.cwd;
            const existsCache = new Map<string, boolean>();
            const diskBudget = { used: 0, limit: MAX_DISK_CHECKS };
            const toolScopedClaudeFiles: string[] = [];

            for (const readPath of collectReadPathsFromToolInput(event.toolName, event.input, cwd)) {
                pi.appendEntry(READ_TRACK_ENTRY, { path: readPath });
            }

            for (const targetPath of collectDirectToolTargetPaths(event.toolName, event.input, cwd)) {
                if (diskBudget.used >= diskBudget.limit) break;
                toolScopedClaudeFiles.push(
                    ...collectClaudeFilesForTarget(targetPath, cwd, {
                        claudeMdCache: claudeFileCache,
                        existsCache,
                        diskBudget,
                    }),
                );
            }

            if (shouldScanToolResultContent(event.toolName, event.input)) {
                const textToScan = getTextToScanFromToolResultContent(event);
                const potentialPaths = extractPotentialPaths(textToScan);

                for (const potentialPath of potentialPaths) {
                    if (diskBudget.used >= diskBudget.limit) break;
                    toolScopedClaudeFiles.push(
                        ...collectClaudeFilesForTarget(potentialPath, cwd, {
                            claudeMdCache: claudeFileCache,
                            existsCache,
                            diskBudget,
                        }),
                    );
                }
            }

            if (toolScopedClaudeFiles.length === 0) return;

            const candidateInstructionFiles = collectLinkedInstructionCandidates(toolScopedClaudeFiles, cwd);
            const entries = getEntriesSinceLastCompaction(ctx.sessionManager.getBranch());
            const unreadInstructionFiles = filterUnreadInstructionFiles(candidateInstructionFiles, entries, cwd).sort();

            if (unreadInstructionFiles.length === 0) return;

            const newContent = Array.isArray(event.content)
                ? [...event.content]
                : [{ type: 'text' as const, text: String(event.content) }];

            let appendText = '\n\n---\n**[Extension: CLAUDE.md Injector]**\n';
            appendText += 'CRITICAL: The following instruction files are applicable to the paths you just interacted with and are still unread in this session:\n';
            for (const md of unreadInstructionFiles) {
                const relPath = path.relative(cwd, md).replace(/\\/g, '/');
                appendText += `- ${relPath}\n`;
            }
            appendText += '\nYOU MUST READ THESE FILES IMMEDIATELY using the `read` tool.';

            newContent.push({ type: 'text' as const, text: appendText });
            return { content: newContent };
        });
}
