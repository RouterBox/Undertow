// vault.js — markdown folder / Obsidian vault importer (feature/vault-sync)
//
// One shared importer powers four features:
//   1. POST /undertow/ingest-vault  — import a folder of .md files (one neuron per note)
//   2. Obsidian awareness           — frontmatter (title/type/tier/event_date/summary)
//      and [[wikilinks]], which become SYNAPSE edges with zero LLM cost
//   3. The vaultwatch daemon        — re-imports single files on change (supersession)
//   4. Reverse-tapestry             — human edits to an exported tapestry vault
//      supersede the underlying neurons (see reverseTapestry below)
//
// Idempotency: a content-hash ledger (service/vault-ledger.json, gitignored)
// maps absolute file path → {hash, neuron}. Unchanged files are skipped;
// changed files supersede their neuron rather than overwrite it.

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { nsPredicate, livePredicate } from './namespaces.js';
import { supersedeNeuron } from './supersede.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(__dirname, 'vault-ledger.json');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash']);

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

async function loadLedgerAsync() {
  if (!existsSync(LEDGER_PATH)) return { files: {} };
  try { return JSON.parse(await readFile(LEDGER_PATH, 'utf8')); }
  catch { return { files: {} }; }
}
async function saveLedger(ledger) {
  await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 1)).catch(() => {});
}

async function* walkMd(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walkMd(join(dir, entry.name));
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      yield join(dir, entry.name);
    }
  }
}

/** Minimal frontmatter parser: `key: value` lines between leading --- markers. */
function parseNote(raw, filePath) {
  let fm = {};
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/);
      if (kv) fm[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  const name = (fm.title || basename(filePath, '.md')).trim().slice(0, 120);
  // flash: frontmatter summary, else first non-heading prose line
  let flash = fm.summary || fm.description || '';
  if (!flash) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('```')) continue;
      flash = t.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/[*_`>]/g, '').trim();
      break;
    }
  }
  flash = (flash || name).slice(0, 140);
  const eventDate = typeof fm.event_date === 'string' && DATE_RE.test(fm.event_date) ? fm.event_date : (typeof fm.date === 'string' && DATE_RE.test(fm.date) ? fm.date : null);
  // wikilinks: [[Target]], [[Target|alias]], [[Target#heading]]
  const links = [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)]
    .map((x) => x[1].trim()).filter((t) => t && t.length <= 120);
  return {
    name,
    flash,
    body: body.trim().slice(0, 4000),
    nodeType: (fm.node_type || fm.type || 'note').slice(0, 30),
    tier: ['T1_index', 'T2_working', 'T3_archive'].includes(fm.tier) ? fm.tier : 'T2_working',
    eventDate,
    links: [...new Set(links)],
  };
}

/** Import (or re-import) a single markdown file. Returns an action string. */
export async function importFile({ filePath, namespace = null, project = 'vault', runCypher, embedNeuron, randomUUID: uuid = randomUUID, log, ledger }) {
  const abs = resolve(filePath);
  const raw = await readFile(abs, 'utf8');
  const hash = sha256(raw);
  const prior = ledger.files[abs];
  if (prior && prior.hash === hash) return { action: 'unchanged', name: prior.neuron };

  const note = parseNote(raw, abs);
  const existing = await runCypher(
    `MATCH (n:Neuron {name: $name}) WHERE ${nsPredicate('n')} AND n.superseded IS NULL RETURN n.name LIMIT 1`,
    { name: note.name, ns: namespace }
  );

  let action;
  if (existing.length > 0) {
    // Changed note → supersede the current version (never overwrite)
    await supersedeNeuron({
      runCypher, randomUUID: uuid, log,
      name: note.name, ns: namespace,
      flash: note.flash, body: note.body, eventDate: note.eventDate,
      reason: `vault note changed: ${basename(abs)}`
    });
    action = 'superseded';
  } else {
    await runCypher(`
      CREATE (n:Neuron {
        uid: $uid, name: $name, node_type: $type, tier: $tier,
        flash_summary: $flash, body: $body,
        source: 'vault', source_path: $path,
        decay_score: 50, base_score: 50,
        times_surfaced: 0, times_pursued: 0, times_dismissed: 0,
        created_at: datetime(), last_surfaced: datetime(),
        project: $project, namespace: $ns,
        event_date: CASE WHEN $eventDate IS NULL THEN NULL ELSE date($eventDate) END
      })
    `, {
      uid: uuid(), name: note.name, type: note.nodeType, tier: note.tier,
      flash: note.flash, body: note.body, path: abs,
      project, ns: namespace, eventDate: note.eventDate
    });
    action = 'created';
  }

  ledger.files[abs] = { hash, neuron: note.name, namespace, importedAt: new Date().toISOString() };
  embedNeuron(note.name, note.flash).catch((e) => log('vault', 'warn', `embed failed for ${note.name}: ${e.message}`));
  return { action, name: note.name, links: note.links };
}

/**
 * Import a whole folder / Obsidian vault. Wikilinks between imported notes
 * become SYNAPSE edges (source 'vault-link'). Idempotent via the hash ledger.
 */
export async function importVault({ dir, namespace = null, project, runCypher, embedNeuron, log }) {
  const root = resolve(dir);
  const st = await stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`not a directory: ${root}`);
  const proj = project || basename(root).toLowerCase();
  const ledger = await loadLedgerAsync();
  const t0 = Date.now();

  const counts = { created: 0, superseded: 0, unchanged: 0, failed: 0, edges: 0 };
  const linkPairs = []; // [sourceName, targetName]

  for await (const file of walkMd(root)) {
    try {
      const r = await importFile({ filePath: file, namespace, project: proj, runCypher, embedNeuron, log, ledger });
      counts[r.action]++;
      for (const target of r.links || []) linkPairs.push([r.name, target]);
    } catch (e) {
      counts.failed++;
      log('vault', 'warn', `import failed for ${file}: ${e.message}`);
    }
  }
  await saveLedger(ledger);

  // Wikilinks → SYNAPSE edges (both ends must exist in the namespace; skip dupes)
  for (const [src, tgt] of linkPairs) {
    if (src === tgt) continue;
    const res = await runCypher(`
      MATCH (a:Neuron {name: $src}) WHERE ${nsPredicate('a')}
      MATCH (b:Neuron {name: $tgt}) WHERE ${nsPredicate('b')}
      AND NOT (a)-[:SYNAPSE]-(b)
      CREATE (a)-[:SYNAPSE { weight: 0.5, edge_type: 'associative',
                             context: 'wikilink', created_at: datetime(),
                             source: 'vault-link' }]->(b)
      RETURN 1 AS created
    `, { src, tgt, ns: namespace }).catch(() => []);
    if (res.length > 0) counts.edges++;
  }

  const elapsed = Date.now() - t0;
  log('vault', 'info', `vault import ${root}: ${JSON.stringify(counts)} in ${elapsed}ms`);
  return { ...counts, dir: root, namespace, project: proj, elapsed };
}

// --- Reverse-tapestry -------------------------------------------------------
// Tapestry exports the graph as an Obsidian vault and records a manifest
// (file → neuron name + content hash). A human edits pages in Obsidian;
// this walks the manifest, finds changed pages, parses the edited flash/body
// back out of the tapestry page format, and SUPERSEDES the neuron.

function parseTapestryPage(raw) {
  const flashMatch = raw.match(/^> (.+)$/m);
  // body sits between the first "---" separator line and "## Connections" (or EOF)
  let body = null;
  const sep = raw.indexOf('\n---\n');
  if (sep !== -1) {
    let after = raw.slice(sep + 5);
    const connIdx = after.indexOf('## Connections');
    if (connIdx !== -1) after = after.slice(0, connIdx);
    body = after.trim();
  }
  return { flash: flashMatch ? flashMatch[1].trim() : null, body };
}

export async function reverseTapestry({ vaultPath, runCypher, embedNeuron, log }) {
  const root = resolve(vaultPath);
  const manifestPath = join(root, 'meta', 'tapestry-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`no tapestry manifest at ${manifestPath} — run a tapestry export first`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const counts = { superseded: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const entry of manifest.pages || []) {
    const abs = join(root, entry.file);
    const raw = await readFile(abs, 'utf8').catch(() => null);
    if (raw === null) { counts.missing++; continue; }
    if (sha256(raw) === entry.hash) { counts.unchanged++; continue; }

    try {
      const edited = parseTapestryPage(raw);
      if (!edited.flash && !edited.body) { counts.failed++; continue; }
      const ok = await supersedeNeuron({
        runCypher, randomUUID, log,
        name: entry.neuron, ns: null,
        flash: edited.flash || undefined, body: edited.body || undefined,
        reason: `edited in tapestry vault: ${entry.file}`
      });
      if (ok) {
        counts.superseded++;
        entry.hash = sha256(raw); // accept the edit as the new baseline
        embedNeuron(entry.neuron, edited.flash || '').catch(() => {});
        log('vault', 'info', `reverse-tapestry SUPERSEDED: ${entry.neuron}`);
      } else counts.missing++;
    } catch (e) {
      counts.failed++;
      log('vault', 'warn', `reverse-tapestry failed for ${entry.file}: ${e.message}`);
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  log('vault', 'info', `reverse-tapestry: ${JSON.stringify(counts)}`);
  return counts;
}

export { sha256 };
