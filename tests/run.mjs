#!/usr/bin/env node
/**
 * Test runner — `npm test`.
 *
 * Four suites, in increasing order of what they need:
 *
 *   pixelart     pure string check, no build
 *   floorplan    TypeScript, bundled with esbuild, no browser
 *   pathfinding  TypeScript, bundled with esbuild, no browser
 *   conformance  spawns the Node bridge and drives it over WebSocket + HTTP
 *
 * The two TypeScript suites import the real modules out of `web/src` — they are
 * deliberately Phaser-free so they can run in plain Node.
 *
 * Flags:
 *   --only <name>     run one suite
 *   --bridge <port>   conformance runs against an already-running bridge on
 *                     that port instead of spawning the Node one. Use it to
 *                     prove the Python bridge behaves identically:
 *                       agent-visualizer serve --port 8790 --no-open
 *                       npm test -- --only conformance --bridge 8790
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const bridgePort = args.includes('--bridge') ? args[args.indexOf('--bridge') + 1] : null;

// Invoke esbuild's JS entry through node rather than the .bin shim: the shim
// needs a shell on Windows, and `shell: true` breaks on the space in
// "C:\Program Files\nodejs".
const esbuildJs = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');

const SUITES = [
  { name: 'pixelart', kind: 'node', file: 'tests/unit/pixelart.mjs' },
  { name: 'floorplan', kind: 'ts', file: 'tests/unit/floorplan.ts' },
  { name: 'pathfinding', kind: 'ts', file: 'tests/unit/pathfinding.ts' },
  { name: 'conformance', kind: 'node', file: 'tests/conformance.mjs' },
];

const work = mkdtempSync(path.join(tmpdir(), 'agentvis-tests-'));
const results = [];

function run(cmd, cmdArgs, env = {}) {
  return spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

try {
  for (const suite of SUITES) {
    if (only && suite.name !== only) continue;

    console.log(`\n\x1b[36m── ${suite.name} ${'─'.repeat(Math.max(0, 56 - suite.name.length))}\x1b[0m`);

    let entry = path.join(ROOT, suite.file);
    if (suite.kind === 'ts') {
      const out = path.join(work, `${suite.name}.mjs`);
      const built = run(process.execPath, [
        esbuildJs,
        entry,
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${out}`,
        '--log-level=error',
      ]);
      if (built.status !== 0) {
        results.push([suite.name, false, 'build failed']);
        continue;
      }
      entry = out;
    }

    const env = {};
    if (suite.name === 'conformance' && bridgePort) env.BRIDGE_PORT = bridgePort;

    const proc = run(process.execPath, [entry], env);
    results.push([suite.name, proc.status === 0, proc.status === 0 ? '' : `exit ${proc.status}`]);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n\x1b[36m${'═'.repeat(60)}\x1b[0m`);
for (const [name, ok, note] of results) {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${note ? `  (${note})` : ''}`);
}
const failed = results.filter((r) => !r[1]);
console.log(
  `\n${results.length - failed.length}/${results.length} suites passed` +
    (bridgePort ? `  (conformance ran against an external bridge on :${bridgePort})` : ''),
);
process.exit(failed.length ? 1 : 0);
