// strip-injections.js — the ouroboros guard, shared.
//
// Undertow's own injected flashes are recorded into session transcripts, so
// any consumer that summarizes or memorizes transcript text must strip the
// injected blocks first or the graph re-memorizes its own output (memory
// echo). Originally fixed in Dreamer (cea051d); exported here so historical
// ingestion gets the same protection.

export function stripUndertowInjections(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*\[UNDERTOW-(FLASH|SESSION-START|REHYDRATE)\]/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^(Haiku interpretation:|Raw neurons:|Neuron handles:|Undertow context:)/.test(line) ||
          /^\s*[~\-]\s/.test(line) || /^\s{2,}\S/.test(line) || line.trim() === '') {
        continue; // still inside the injected block
      }
      inBlock = false;
    }
    out.push(line);
  }
  return out.join('\n');
}
