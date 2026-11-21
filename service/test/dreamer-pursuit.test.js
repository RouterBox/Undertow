// Dreamer pursuit detection: the judge's transcript excerpt, judging an entry once,
// and one outcome per neuron per entry.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize, buildTranscriptExcerpt } from '../daemons/dreamer.js';

// `responses` is consumed one per Stop: an array = flash_results, null = failed call,
// a string = raw (possibly unparseable) response text.
function harness({ entries, responses, feedback }) {
  const calls = [];
  const logs = [];
  const prompts = [];
  const session = { activeTopics: [], pendingFlashes: entries, explicitFeedback: feedback };
  const deps = {
    req_body: { session_id: 's1' },
    session,
    runCypher: async (q, p) => { calls.push({ q, p }); return []; },
    callAnthropic: async (model, system, user) => {
      prompts.push(user);
      const r = responses.shift();
      if (r === null || r === undefined) return null;
      const text = typeof r === 'string' ? r : JSON.stringify({ insights: [], updates: [], train_of_thought: [], flash_results: r });
      return { model: 'claude-sonnet-5', response: { content: [{ text }] } };
    },
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: (...a) => logs.push(a)
  };
  const count = (name, re) => calls.filter(c => c.p && c.p.name === name && re.test(c.q)).length;
  return { deps, session, calls, logs, prompts, count };
}

// An entry as haiku/both mode pushes it: crafted flashes, no per-flash neuron mapping.
function haikuEntry(flashes, neurons, domains = {}) {
  return {
    turn: Date.now(), flashes, sourceNeurons: neurons,
    neuronDomains: Object.fromEntries(neurons.map(n => [n, domains[n] !== false])),
    neuronDaemons: Object.fromEntries(neurons.map(n => [n, 'vector']))
  };
}

// An entry as curated/raw mode pushes it: one flash line per neuron.
function mappedEntry(neurons, domains = {}) {
  return { ...haikuEntry(neurons.map(n => `${n}: flash ${n}`), neurons, domains), flashNeurons: neurons };
}

const DISMISS_RE = /times_dismissed = n\.times_dismissed \+ 1/;
const PURSUE_RE = /times_pursued = n\.times_pursued \+ 1/;

// --- A: transcript excerpt ---

const jsonl = (...objs) => objs.map(o => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n');
const userLine = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistantLine = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });
const ENVELOPE_TAIL = [
  { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['x'.repeat(900)] } },
  { type: 'api-request', id: 'req_1', params: { filler: 'y'.repeat(900) } },
  { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'BLOB COPY SHOULD NOT APPEAR' }] } },
  { type: 'last-prompt', lastPrompt: 'z'.repeat(400) },
  { type: 'custom-title', customTitle: 'a made-up title' },
  { type: 'permission-mode', permissionMode: 'default' }
];

test('excerpt: returns the prompt, assistant reply and tool calls when the file tail is envelope lines', () => {
  const raw = jsonl(
    userLine('What colour is the old barn?'),
    assistantLine({ type: 'text', text: 'OLD TURN REPLY' }),
    userLine('How do we tune the kettle thermostat?'),
    assistantLine({ type: 'thinking', thinking: 'SECRET THINKING' }),
    assistantLine({ type: 'text', text: 'Let me check the kettle config.' }),
    assistantLine({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/kettle/config.yaml' } }),
    userLine([{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL RESULT BODY' }]),
    '{ this line is not json',
    userLine('META NOTE', { isMeta: true }),
    assistantLine({ type: 'text', text: 'The thermostat hysteresis is two degrees, so raise the setpoint.' }),
    ...ENVELOPE_TAIL
  );
  // The old behaviour (last 2000 raw chars) saw none of the reply.
  assert.ok(!raw.slice(-2000).includes('hysteresis'));

  const excerpt = buildTranscriptExcerpt(raw);
  assert.match(excerpt, /^User: How do we tune the kettle thermostat\?/);
  assert.match(excerpt, /Assistant: Let me check the kettle config\./);
  assert.match(excerpt, /\[tool\] Read: \{"file_path":"\/kettle\/config\.yaml"\}/);
  assert.match(excerpt, /Assistant: The thermostat hysteresis is two degrees/);
  for (const absent of ['OLD TURN REPLY', 'old barn', 'SECRET THINKING', 'TOOL RESULT BODY', 'META NOTE', 'BLOB COPY', 'made-up title']) {
    assert.ok(!excerpt.includes(absent), `excerpt must not contain "${absent}"`);
  }
});

test('excerpt: capped, keeping the END of the assistant text; injected flashes are stripped', () => {
  const raw = jsonl(
    userLine('Summarise the lighthouse report.'),
    assistantLine({ type: 'text', text: `START-MARKER ${'filler '.repeat(2000)} END-MARKER` }),
    assistantLine({ type: 'text', text: '[UNDERTOW-FLASH] (1 flash)\n  ~ echoed memory line\n\nAfter the block.' }),
    ...ENVELOPE_TAIL
  );
  const excerpt = buildTranscriptExcerpt(raw);
  assert.ok(excerpt.length <= 6000);
  assert.match(excerpt, /^User: Summarise the lighthouse report\./);
  assert.ok(excerpt.includes('END-MARKER') && excerpt.endsWith('After the block.'));
  assert.ok(!excerpt.includes('START-MARKER'));
  assert.ok(!excerpt.includes('echoed memory line'), 'ouroboros guard still applied');
});

test('excerpt: null for text that is not JSONL or holds no messages (caller falls back)', () => {
  assert.equal(buildTranscriptExcerpt('just a plain text transcript\nwith two lines'), null);
  assert.equal(buildTranscriptExcerpt(jsonl(...ENVELOPE_TAIL)), null);
  assert.equal(buildTranscriptExcerpt(''), null);
});

// --- B: an entry is judged at one Stop only ---

test('an entry judged at one Stop is not sent or counted at the next Stop', async () => {
  const h = harness({
    entries: [haikuEntry(['kettle flash'], ['A'])],
    responses: [
      [{ flash_text: 'kettle flash', status: 'dismissed' }],
      [{ flash_text: 'kettle flash', status: 'dismissed' }] // even if the model repeats it
    ]
  });
  await handleSummarize(h.deps);
  assert.ok(h.prompts[0].includes('kettle flash'));
  assert.equal(h.count('A', DISMISS_RE), 1);
  assert.equal(h.session.pendingFlashes.length, 1, 'entry is kept, only marked');
  assert.equal(h.session.pendingFlashes[0].judged, true);

  await handleSummarize(h.deps);
  assert.ok(!h.prompts[1].includes('kettle flash'), 'judged flash is not sent again');
  assert.ok(h.prompts[1].includes('[none]'));
  assert.equal(h.count('A', DISMISS_RE), 1, 'no second dismissal');
});

test('a failed or unparseable Anthropic response leaves the entry unjudged', async () => {
  const h = harness({
    entries: [haikuEntry(['kettle flash'], ['A'])],
    responses: [null, 'not json {', 'no json object here', [{ flash_text: 'kettle flash', status: 'dismissed' }]]
  });
  for (let stop = 0; stop < 3; stop++) {
    await handleSummarize(h.deps);
    assert.ok(!h.session.pendingFlashes[0].judged, `stop ${stop}: still unjudged`);
    assert.equal(h.count('A', DISMISS_RE), 0);
  }
  await handleSummarize(h.deps);
  assert.ok(h.prompts[3].includes('kettle flash'), 'flash is sent again after the failures');
  assert.equal(h.session.pendingFlashes[0].judged, true);
  assert.equal(h.count('A', DISMISS_RE), 1);
});

// --- C: one outcome per neuron per entry ---

test('an entry with several flashes dismisses each neuron at most once', async () => {
  const h = harness({
    entries: [haikuEntry(['flash one', 'flash two', 'flash three'], ['A', 'B'])],
    responses: [[
      { flash_text: 'flash one', status: 'dismissed' },
      { flash_text: 'flash two', status: 'dismissed' },
      { flash_text: 'flash three', status: 'dismissed' }
    ]]
  });
  await handleSummarize(h.deps);
  assert.equal(h.count('A', DISMISS_RE), 1);
  assert.equal(h.count('B', DISMISS_RE), 1);
  assert.equal(h.calls.filter(c => /d\.dismissed/.test(c.q)).length, 2, 'daemon counter: once per neuron');
});

test('pursued beats dismissed within an entry, whatever the order', async () => {
  const h = harness({
    entries: [haikuEntry(['flash one', 'flash two', 'flash three'], ['A', 'B'])],
    responses: [[
      { flash_text: 'flash one', status: 'dismissed' },
      { flash_text: 'flash two', status: 'pursued' },
      { flash_text: 'flash three', status: 'dismissed' }
    ]]
  });
  await handleSummarize(h.deps);
  for (const n of ['A', 'B']) {
    assert.equal(h.count(n, PURSUE_RE), 1, `${n} pursued once`);
    assert.equal(h.count(n, DISMISS_RE), 0, `${n} not dismissed`);
  }
});

test('with a per-flash mapping each flash outcome goes only to its own neuron', async () => {
  const h = harness({
    entries: [mappedEntry(['A', 'B', 'C'])],
    responses: [[
      { flash_text: 'A: flash A', status: 'pursued' },
      { flash_text: 'B: flash B', status: 'dismissed' }
    ]]
  });
  await handleSummarize(h.deps);
  assert.equal(h.count('A', PURSUE_RE), 1);
  assert.equal(h.count('A', DISMISS_RE), 0);
  assert.equal(h.count('B', DISMISS_RE), 1);
  assert.equal(h.count('B', PURSUE_RE), 0);
  assert.ok(!h.calls.some(c => c.p && c.p.name === 'C'), 'C had no flash result: untouched');
});

// --- explicit feedback on an already-judged entry ---

test('explicit feedback still applies to an already-judged entry', async () => {
  const h = harness({
    entries: [mappedEntry(['A', 'B'])],
    responses: [
      [{ flash_text: 'A: flash A', status: 'dismissed' }, { flash_text: 'B: flash B', status: 'dismissed' }],
      []
    ]
  });
  await handleSummarize(h.deps);
  assert.equal(h.session.pendingFlashes[0].judged, true);
  assert.equal(h.count('A', DISMISS_RE), 1);

  // Feedback arrives after the entry was judged (POST /undertow/feedback).
  h.session.explicitFeedback = { A: { verdict: 'used', note: '', ts: 1 } };
  await handleSummarize(h.deps);
  assert.equal(h.count('A', PURSUE_RE), 1, 'feedback applied through the judged entry');
  assert.equal(h.count('A', DISMISS_RE), 1, 'no extra dismissal for A');
  assert.equal(h.count('B', DISMISS_RE), 1, 'B (no feedback) not re-judged');
  assert.deepEqual(h.session.explicitFeedback, {}, 'consumed feedback is cleared');
});

// --- D: the per-flash log says what happened ---

test('non-pursued log line reports what actually happened', async () => {
  const detailFor = (h, text) => h.logs.find(l => l[2] === `pursuit: ✗ "${text}"`)?.[3]?.detail;

  const cross = harness({
    entries: [mappedEntry(['A'], { A: false })],
    responses: [[{ flash_text: 'A: flash A', status: 'dismissed' }]]
  });
  await handleSummarize(cross.deps);
  assert.equal(cross.count('A', DISMISS_RE), 0);
  assert.match(detailFor(cross, 'A: flash A'), /1 cross-project neuron\(s\) skipped, no penalty/);
  assert.doesNotMatch(detailFor(cross, 'A: flash A'), /times_dismissed/);

  const same = harness({
    entries: [mappedEntry(['A'])],
    responses: [[{ flash_text: 'A: flash A', status: 'dismissed' }, { flash_text: 'unknown flash', status: 'dismissed' }]]
  });
  await handleSummarize(same.deps);
  assert.match(detailFor(same, 'A: flash A'), /times_dismissed \+1 on 1 neuron\(s\)/);
  assert.match(detailFor(same, 'unknown flash'), /nothing applied/);
});
