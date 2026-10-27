// Tests for the curated flash mode helpers and the feedback verdict mapping.
// Pure functions: no Neo4j, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCuratedSelection, formatCuratedBlock, bodyPreview, verdictToOutcome,
  applyVerdictToNeuron, FEEDBACK_VERDICTS, MAX_CURATED_PICKS
} from '../daemons/curated.js';
import { QUERY_SYSTEM_PROMPT_CURATED } from '../daemons/impulse.js';

// --- parseCuratedSelection ---

test('parse: well-formed selection', () => {
  const r = parseCuratedSelection('{"selected":[{"n":2,"why":"contradicts the prompt"},{"n":5,"why":"x"}],"topics_detected":["keeper"]}', 8);
  assert.deepEqual(r.selected, [{ n: 2, why: 'contradicts the prompt' }, { n: 5, why: 'x' }]);
  assert.deepEqual(r.topics, ['keeper']);
  assert.equal(r.malformed, false);
});

test('parse: empty selection is valid, not malformed', () => {
  const r = parseCuratedSelection('{"selected":[],"topics_detected":[]}', 8);
  assert.deepEqual(r.selected, []);
  assert.equal(r.malformed, false);
});

test('parse: ignores out-of-range, duplicate, non-integer and junk entries', () => {
  const r = parseCuratedSelection('{"selected":[{"n":0},{"n":9},{"n":3,"why":"a"},{"n":3,"why":"dup"},{"n":1.5},{"n":"2","why":"str"},null,"x"]}', 8);
  assert.deepEqual(r.selected.map(s => s.n), [3, 2]);
});

test('parse: caps at the maximum number of picks', () => {
  const sel = Array.from({ length: 10 }, (_, i) => ({ n: i + 1 }));
  const r = parseCuratedSelection(JSON.stringify({ selected: sel }), 10);
  assert.equal(r.selected.length, MAX_CURATED_PICKS);
});

test('parse: tolerates prose / code fences around the JSON', () => {
  const r = parseCuratedSelection('Here you go:\n```json\n{"selected":[{"n":1,"why":"ok"}]}\n```', 3);
  assert.deepEqual(r.selected, [{ n: 1, why: 'ok' }]);
});

test('parse: malformed output is flagged and yields no picks', () => {
  for (const bad of ['', 'nothing relevant', '{"flashes":["old shape"]}', '{"selected":"3"}', '{not json}']) {
    const r = parseCuratedSelection(bad, 5);
    assert.equal(r.malformed, true, bad);
    assert.deepEqual(r.selected, []);
  }
});

// --- bodyPreview / formatCuratedBlock ---

test('bodyPreview: collapses whitespace and truncates to ~300 chars', () => {
  assert.equal(bodyPreview(''), '');
  assert.equal(bodyPreview(null), '');
  assert.equal(bodyPreview('a\n\n b'), 'a b');
  const long = bodyPreview('x'.repeat(1000));
  assert.ok(long.length <= 303 && long.endsWith('...'));
});

test('format: header, per-pick entry, handle, why, 2-line footer, no Cypher', () => {
  const block = formatCuratedBlock([
    { type: 'fact', name: 'Keeper gate', flash: 'Gates sessions by tier.', body: 'Body text here.', uid: 'abcdef12-3456-7890', why: 'prompt asks about Keeper' },
    { type: 'insight', name: 'No uid one', flash: 'Flash two.' }
  ], 14, 1234);
  const lines = block.split('\n');
  assert.equal(lines[0], '[UNDERTOW-FLASH] (2 selected from 14 candidates, 1234ms, curated)');
  assert.ok(block.includes('  [fact] Keeper gate: Gates sessions by tier.'));
  assert.ok(block.includes('    body: Body text here.'));
  assert.ok(block.includes('    handle: {name: "Keeper gate", uid: "abcdef12"}'));
  assert.ok(block.includes('    why: prompt asks about Keeper'));
  assert.ok(block.includes('    handle: {name: "No uid one"}'));
  assert.ok(!/MATCH|Query:|Cypher/i.test(block));
  assert.match(lines[lines.length - 2], /undertow_neighbors.*undertow_chase/);
  assert.match(lines[lines.length - 1], /undertow_feedback.*used, useful, irrelevant, wrong/);
});

test('prompt: curated prompt asks for numbered selection and keeps the guard rails', () => {
  assert.match(QUERY_SYSTEM_PROMPT_CURATED, /"selected"/);
  assert.match(QUERY_SYSTEM_PROMPT_CURATED, /Silence is accuracy/);
  assert.match(QUERY_SYSTEM_PROMPT_CURATED, /CONTRADICTION CHECK/);
  assert.match(QUERY_SYSTEM_PROMPT_CURATED, /STAY IN DOMAIN/);
  assert.match(QUERY_SYSTEM_PROMPT_CURATED, /NO IDENTITY BLEED/);
});

// --- feedback verdict mapping ---

test('verdictToOutcome: used/useful => pursued; irrelevant => dismissed; wrong => dismissed + review', () => {
  assert.deepEqual(verdictToOutcome('used'), { status: 'pursued', flagReview: false });
  assert.deepEqual(verdictToOutcome('useful'), { status: 'pursued', flagReview: false });
  assert.deepEqual(verdictToOutcome('irrelevant'), { status: 'dismissed', flagReview: false });
  assert.deepEqual(verdictToOutcome('wrong'), { status: 'dismissed', flagReview: true });
  assert.equal(verdictToOutcome('nope'), null);
  assert.equal(verdictToOutcome(undefined), null);
  for (const v of FEEDBACK_VERDICTS) assert.ok(verdictToOutcome(v));
});

test('applyVerdictToNeuron: wrong flags review with note; used does not; unknown does nothing', async () => {
  const calls = [];
  const runCypher = async (q, p) => { calls.push({ q, p }); return []; };
  const logs = [];
  const log = (...a) => logs.push(a);

  await applyVerdictToNeuron({ runCypher, name: 'N', ns: null, verdict: 'wrong', note: 'stale', log });
  assert.ok(calls.some(c => /times_dismissed/.test(c.q)));
  const flag = calls.find(c => /needs_review = true/.test(c.q));
  assert.ok(flag && flag.p.note === 'stale');
  assert.ok(logs.some(l => l[1] === 'warn'));

  calls.length = 0;
  await applyVerdictToNeuron({ runCypher, name: 'N', ns: null, verdict: 'used', log });
  assert.ok(calls.some(c => /times_pursued/.test(c.q)));
  assert.ok(!calls.some(c => /needs_review/.test(c.q)));

  calls.length = 0;
  assert.equal(await applyVerdictToNeuron({ runCypher, name: 'N', verdict: 'bogus', log }), null);
  assert.equal(calls.length, 0);
});
