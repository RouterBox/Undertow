// Gate for downstream daemons (Spider, Janitor) that the Stop hook triggers.
//
// The Stop hook fires after every turn, not once per session, so without a
// gate each turn starts a full run, and several sessions stopping together
// start overlapping runs over the same neurons. A run is skipped while one
// with the same key is still in flight, and for minIntervalMs after it ends.
// Skipped work is not lost: both daemons pick their work from graph state, so
// the next allowed run takes it.

const state = new Map(); // key -> { running, lastEnd }

export function gateRun(key, minIntervalMs, fn, now = Date.now) {
  let s = state.get(key);
  if (!s) { s = { running: false, lastEnd: null }; state.set(key, s); }
  if (s.running) return { skipped: 'in-flight' };
  if (s.lastEnd !== null && now() - s.lastEnd < minIntervalMs) return { skipped: 'cooldown' };
  s.running = true;
  const promise = Promise.resolve().then(fn).finally(() => {
    s.running = false;
    s.lastEnd = now();
  });
  return { promise };
}

export function resetGates() {
  state.clear();
}
