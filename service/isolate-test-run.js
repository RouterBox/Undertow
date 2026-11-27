// Loaded by `npm test` (node --import) before any test file, in every test process.
// Points the files the service writes in place (Keeper ledger, logs) at a temp dir,
// so a test run never touches the live service's state. Set before any module
// computes its paths at import time.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'undertow-test-'));
process.env.UNDERTOW_KEEPER_LEDGER = join(dir, 'keeper-ledger.json');
process.env.UNDERTOW_LOG_DIR = join(dir, 'logs');
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
