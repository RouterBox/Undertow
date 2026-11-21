// Dreamer tags the neurons it creates with the session's project.
// Uses stubbed runCypher / callAnthropic, so no Neo4j or network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleSummarize } from '../daemons/dreamer.js';

function harness({ cwd, currentProject } = {}) {
  const calls = [];
  const session = { activeTopics: [], pendingFlashes: [], explicitFeedback: {} };
  if (currentProject) session.currentProject = currentProject;
  const deps = {
    req_body: { session_id: 's1', cwd },
    session,
    runCypher: async (q, p) => { calls.push({ q, p }); return []; },
    callAnthropic: async () => ({
      model: 'claude-sonnet-5',
      response: { content: [{ text: JSON.stringify({
        insights: [{ name: 'Gate design', node_type: 'insight', flash_summary: 'One run at a time', body: 'Two sentences of body. Enough to pass.' }],
        updates: [], train_of_thought: ['gate design work', 'cooldown tuning'], flash_results: []
      }) }] }
    }),
    embedNeuron: async () => {}, randomUUID: () => 'u',
    isDaemonEnabled: () => false, getDaemonConfig: () => ({}),
    wonder: {}, spider: {}, janitor: {}, prowler: {},
    log: () => {}
  };
  const creates = () => calls.filter(c => /CREATE \(n:Neuron/.test(c.q));
  return { deps, session, creates };
}

test('insight and topic neurons get the project derived from cwd', async () => {
  const h = harness({ cwd: 'C:\\Work\\MyRepo' });
  await handleSummarize(h.deps);
  const created = h.creates();
  assert.equal(created.length, 3, 'one insight and two topic neurons');
  for (const c of created) {
    assert.match(c.q, /project: \$project/);
    assert.equal(c.p.project, 'c:\\work\\myrepo');
  }
  assert.equal(h.session.currentProject, 'c:\\work\\myrepo');
});

test('a project already set on the session wins over cwd', async () => {
  const h = harness({ cwd: 'C:\\Other', currentProject: 'openclaw' });
  await handleSummarize(h.deps);
  for (const c of h.creates()) assert.equal(c.p.project, 'openclaw');
});

test('without cwd or session project the neuron is tagged general', async () => {
  const h = harness();
  await handleSummarize(h.deps);
  const created = h.creates();
  assert.ok(created.length > 0);
  for (const c of created) assert.equal(c.p.project, 'general');
});
