#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = resolve(rootDir, 'claude-md-injector.ts');
const extensionsDir = process.env.PI_AGENT_EXTENSIONS_DIR
  ? resolve(process.env.PI_AGENT_EXTENSIONS_DIR)
  : join(homedir(), '.pi', 'agent', 'extensions');
const target = join(extensionsDir, 'claude-md-injector.ts');

if (!existsSync(source) || !statSync(source).isFile()) {
  console.error(`Source extension not found: ${source}`);
  process.exit(1);
}

mkdirSync(extensionsDir, { recursive: true });
copyFileSync(source, target);

console.log(`Installed claude-md-injector extension:`);
console.log(`  ${source}`);
console.log(`-> ${target}`);
console.log('Restart pi or run /reload to load the new extension.');
