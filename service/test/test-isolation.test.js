// A test run must not write the live service's files (Keeper ledger, logs).
// `npm test` loads isolate-test-run.js, which points both at a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { resolve, sep } from 'path';

import { LEDGER_PATH } from '../daemons/keeper.js';

const underTmp = (p) => resolve(p).startsWith(resolve(tmpdir()) + sep);

test('the Keeper ledger resolves under the temp dir during tests, not service/', () => {
  assert.ok(underTmp(LEDGER_PATH), `LEDGER_PATH is ${LEDGER_PATH}`);
});

test('the log directory override points under the temp dir during tests', () => {
  assert.ok(process.env.UNDERTOW_LOG_DIR, 'UNDERTOW_LOG_DIR is not set');
  assert.ok(underTmp(process.env.UNDERTOW_LOG_DIR), `UNDERTOW_LOG_DIR is ${process.env.UNDERTOW_LOG_DIR}`);
});
