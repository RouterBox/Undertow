// vaultwatch.js — hot watch-folder daemon (feature/vault-sync)
//
// Watches configured markdown folders and re-imports notes as they change.
// A changed note supersedes its neuron (never overwrites); a new note becomes
// a new neuron; unchanged saves are skipped by the content-hash ledger.
//
// daemon-config.json:
//   "vaultwatch": {
//     "enabled": false,
//     "watches": [ { "dir": "C:/notes", "namespace": null, "project": "notes" } ],
//     "debounceMs": 2000
//   }

import { watch } from 'fs';
import { stat, readFile } from 'fs/promises';
import { resolve, join } from 'path';
import { getDaemonConfig } from './loader.js';
import { importFile } from '../vault.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(__dirname, '..', 'vault-ledger.json');

const watchers = [];
const timers = new Map(); // absolute file path → debounce timer

async function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { files: {} };
  try { return JSON.parse(await readFile(LEDGER_PATH, 'utf8')); }
  catch { return { files: {} }; }
}

export default {
  name: 'vaultwatch',
  type: 'input',
  description: 'Watch markdown folders and re-import notes on change (supersession on edit)',
  defaultEnabled: false,

  /** Start all configured watchers. Call once at server boot. */
  start({ runCypher, embedNeuron, log }) {
    const cfg = getDaemonConfig('vaultwatch');
    if (!cfg.enabled || !Array.isArray(cfg.watches) || cfg.watches.length === 0) return { watching: 0 };
    const debounceMs = cfg.debounceMs || 2000;

    for (const w of cfg.watches) {
      const dir = resolve(w.dir);
      let watcher;
      try {
        watcher = watch(dir, { recursive: true }, (event, filename) => {
          if (!filename || !filename.toLowerCase().endsWith('.md')) return;
          const abs = join(dir, filename);
          clearTimeout(timers.get(abs));
          timers.set(abs, setTimeout(async () => {
            timers.delete(abs);
            const st = await stat(abs).catch(() => null);
            if (!st || !st.isFile()) return; // deleted or renamed away — leave the neuron
            try {
              const ledger = await loadLedger();
              const r = await importFile({
                filePath: abs, namespace: w.namespace ?? null, project: w.project,
                runCypher, embedNeuron, log, ledger
              });
              if (r.action !== 'unchanged') {
                const { writeFile } = await import('fs/promises');
                await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 1)).catch(() => {});
                log('vault', 'info', `vaultwatch ${r.action}: ${r.name} (${filename})`);
              }
            } catch (e) {
              log('vault', 'warn', `vaultwatch import failed for ${filename}: ${e.message}`);
            }
          }, debounceMs));
        });
      } catch (e) {
        log('vault', 'warn', `vaultwatch could not watch ${dir}: ${e.message}`);
        continue;
      }
      watchers.push(watcher);
      log('vault', 'info', `vaultwatch watching ${dir}${w.namespace ? ` → namespace ${w.namespace}` : ' → live graph'}`);
    }
    return { watching: watchers.length };
  },

  stop() {
    for (const w of watchers) { try { w.close(); } catch {} }
    watchers.length = 0;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  },
};
