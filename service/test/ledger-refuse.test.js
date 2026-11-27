// A test run that skips isolate-test-run.js (a bare `node --test`) leaves
// UNDERTOW_KEEPER_LEDGER unset. The Keeper must then neither read nor write its
// default ledger file. Runs the Keeper from a temp copy, so its default ledger
// path is a temp file and a regression cannot touch service/keeper-ledger.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const serviceDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'undertow-ledger-refuse-'));
  mkdirSync(join(dir, 'daemons'));
  copyFileSync(join(serviceDir, 'daemons', 'keeper.js'), join(dir, 'daemons', 'keeper.js'));
  copyFileSync(join(serviceDir, 'agent-roster.js'), join(dir, 'agent-roster.js'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const ledger = join(dir, 'keeper-ledger.json'); // the copy's default ledger path
  writeFileSync(ledger, JSON.stringify({ saved_at: '2026-01-01T00:00:00.000Z', sessions: { seeded: { tier: 'conscious', lastSeen: Date.now() } } }));
  // Init the Keeper, report how many sessions it loaded, then make a change that persists at once.
  const probe = `import keeper from './daemons/keeper.js';
keeper.init();
console.log('LOADED=' + keeper.snapshot().ledgerSize);
keeper.setKind('probe-session', 'human');`;
  writeFileSync(join(dir, 'probe.mjs'), probe);
  writeFileSync(join(dir, 'probe.test.mjs'), `import './probe.mjs';\nimport { test } from 'node:test';\ntest('probe', () => {});\n`);
  return { dir, ledger };
}

// The parent is itself a test run: give the child a clean env.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.UNDERTOW_KEEPER_LEDGER;
  return env;
}

test('a bare `node --test` without UNDERTOW_KEEPER_LEDGER neither reads nor writes the default ledger', () => {
  const { dir, ledger } = setup();
  try {
    const before = { body: readFileSync(ledger, 'utf8'), mtime: statSync(ledger).mtimeMs };
    const r = spawnSync(process.execPath, ['--test', 'probe.test.mjs'], { cwd: dir, env: childEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /LOADED=0/, 'the seeded ledger file was loaded');
    assert.match(r.stdout + r.stderr, /ledger kept in memory/);
    assert.equal(readFileSync(ledger, 'utf8'), before.body, 'the ledger file was rewritten');
    assert.equal(statSync(ledger).mtimeMs, before.mtime);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a test run the Keeper still loads and writes the default ledger', () => {
  const { dir, ledger } = setup();
  try {
    const r = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, env: childEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /LOADED=1/);
    assert.doesNotMatch(r.stdout + r.stderr, /ledger kept in memory/);
    assert.ok(JSON.parse(readFileSync(ledger, 'utf8')).sessions['probe-session'], 'the change was not persisted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
