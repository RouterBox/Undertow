// embedding-coverage.js — how many live neurons have an embedding
//
// Counts the live graph only: the NULL namespace, current (non-superseded)
// versions. Neurons in other namespaces (benchmarks, held, a client's own) and
// archived versions are never searched by live recall, so counting them made
// the boot warning report a gap several times the real one.

import { livePredicate } from './namespaces.js';

const toNumber = (v) => (typeof v?.toNumber === 'function' ? v.toNumber() : Number(v || 0));

/** { total, embedded } for the live graph. */
export async function embeddingCoverage(runCypher) {
  const rows = await runCypher(
    `MATCH (n:Neuron) WHERE ${livePredicate('n')} RETURN count(n) AS total, count(n.embedding) AS embedded`,
    { ns: null }
  );
  return { total: toNumber(rows[0]?.total), embedded: toNumber(rows[0]?.embedded) };
}
