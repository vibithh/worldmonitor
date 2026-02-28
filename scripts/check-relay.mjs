#!/usr/bin/env node
/**
 * Pre-push guard for scripts/ais-relay.cjs
 *
 * 1. node --check  → catches SyntaxError (bad tokens, typos)
 * 2. Smart-quote scan → catches Unicode curly quotes (U+2018/19/1C/1D)
 *    that are valid string content but break CJS at runtime
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = join(__dirname, 'ais-relay.cjs');
let failed = false;

// 1. Syntax check
console.log('[check:relay] node --check ...');
try {
  execFileSync('node', ['--check', RELAY], { stdio: 'pipe' });
} catch (e) {
  console.error('[check:relay] FAIL: SyntaxError');
  console.error(e.stderr?.toString() || e.message);
  failed = true;
}

// 2. Smart-quote scan
const src = readFileSync(RELAY, 'utf8');
const smartQuoteRe = /[\u2018\u2019\u201C\u201D]/g;
let match;
const lines = src.split('\n');
while ((match = smartQuoteRe.exec(src)) !== null) {
  const lineNum = src.slice(0, match.index).split('\n').length;
  const charName = {
    '\u2018': 'LEFT SINGLE QUOTE',
    '\u2019': 'RIGHT SINGLE QUOTE',
    '\u201C': 'LEFT DOUBLE QUOTE',
    '\u201D': 'RIGHT DOUBLE QUOTE',
  }[match[0]];
  console.error(`[check:relay] FAIL: ${charName} at line ${lineNum}: ${lines[lineNum - 1].trim().slice(0, 80)}`);
  failed = true;
}

if (failed) {
  console.error('[check:relay] ais-relay.cjs has errors — fix before pushing.');
  process.exit(1);
}
console.log('[check:relay] OK');
