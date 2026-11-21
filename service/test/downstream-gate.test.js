import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gateRun, resetGates } from '../downstream-gate.js';

beforeEach(() => resetGates());

test('first run is allowed and runs the function', async () => {
  let ran = 0;
  const r = gateRun('spider:', 1000, async () => { ran++; return 'ok'; }, () => 0);
  assert.equal(await r.promise, 'ok');
  assert.equal(ran, 1);
});

test('a second trigger while the first is in flight is skipped', async () => {
  let release;
  const first = gateRun('spider:', 0, () => new Promise(res => { release = res; }), () => 0);
  await Promise.resolve(); // let the first run start
  let ran = 0;
  const second = gateRun('spider:', 0, async () => { ran++; }, () => 0);
  assert.equal(second.skipped, 'in-flight');
  assert.equal(ran, 0);
  release();
  await first.promise;
});

test('a trigger inside the cooldown is skipped, one after it runs', async () => {
  let t = 1000;
  const now = () => t;
  await gateRun('spider:', 300, async () => {}, now).promise;
  t = 1299;
  assert.equal(gateRun('spider:', 300, async () => {}, now).skipped, 'cooldown');
  t = 1300;
  const again = gateRun('spider:', 300, async () => 'ran', now);
  assert.equal(await again.promise, 'ran');
});

test('the cooldown counts from the end of the run, not its start', async () => {
  let t = 0;
  const now = () => t;
  await gateRun('spider:', 100, async () => { t = 500; }, now).promise;
  t = 550;
  assert.equal(gateRun('spider:', 100, async () => {}, now).skipped, 'cooldown');
});

test('keys are independent', async () => {
  let release;
  const a = gateRun('spider:', 1000, () => new Promise(res => { release = res; }), () => 0);
  await Promise.resolve();
  const b = gateRun('spider:bench', 1000, async () => 'b', () => 0);
  const c = gateRun('janitor:', 1000, async () => 'c', () => 0);
  assert.equal(await b.promise, 'b');
  assert.equal(await c.promise, 'c');
  release();
  await a.promise;
});

test('a failed run releases the gate and still starts the cooldown', async () => {
  let t = 0;
  const now = () => t;
  const r = gateRun('spider:', 100, async () => { throw new Error('boom'); }, now);
  await assert.rejects(r.promise, /boom/);
  t = 50;
  assert.equal(gateRun('spider:', 100, async () => {}, now).skipped, 'cooldown');
  t = 100;
  assert.ok(gateRun('spider:', 100, async () => {}, now).promise);
});
