import { readFileSync, watchFile, unwatchFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, 'logs');

// 24-bit ANSI colors
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[38;2;255;0;0m';
const MAGENTA = '\x1b[35m';
const PEACH = '\x1b[38;2;255;171;145m';
const WHITE = '\x1b[37m';
const BLUE = '\x1b[34m';

let lastSize = 0;
let flashCount = 0;
let turnCount = 0;

function getLogFile() {
  return join(LOG_DIR, `undertow-${new Date().toISOString().split('T')[0]}.log`);
}

function formatEntry(entry) {
  const time = new Date(entry.ts).toLocaleTimeString();

  // ═══════════════════════════════════════
  // TURN START — big visible separator with user prompt
  // ═══════════════════════════════════════
  if (entry.endpoint === 'turn' && entry.message === 'START') {
    turnCount++;
    const prompt = entry.detail || '[no prompt]';
    const cwd = entry.cwd || '';
    const project = cwd.match(/[\/\\]github[\/\\]([^\/\\]+)/i)?.[1] || cwd;
    let output = '\n';
    output += `${MAGENTA}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}\n`;
    output += `${MAGENTA}${BOLD}║  TURN ${turnCount}${RESET}  ${DIM}${time}  ${project}${RESET}\n`;
    output += `${MAGENTA}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}\n`;
    output += `${WHITE}  ${prompt}${RESET}\n`;
    return output;
  }

  // ─── SEARCH RESULTS ───
  if (entry.endpoint === 'query' && entry.message === 'candidates') {
    const candidates = (entry.detail || '').split(' || ');
    let output = `\n${PEACH}  ┌─ ${candidates.length} candidates ──────────────────────────────────${RESET}\n`;
    for (const c of candidates) {
      output += `${PEACH}  │ ${c}${RESET}\n`;
    }
    output += `${PEACH}  └──────────────────────────────────────────────────────────${RESET}\n`;
    return output;
  }

  if (entry.endpoint === 'query' && entry.message === 'daemon hits') {
    return `${DIM}  daemons: ${entry.detail}${RESET}\n`;
  }

  if (entry.endpoint === 'query' && entry.message === 'vector search active') {
    return `${DIM}  🔍 vector search${RESET}\n`;
  }

  if (entry.endpoint === 'query' && entry.message.startsWith('keyword fallback')) {
    return `${DIM}  🔎 ${entry.message}${RESET}\n`;
  }

  if (entry.endpoint === 'query' && entry.message.startsWith('project detected')) {
    return `${DIM}  📂 ${entry.message}${RESET}\n`;
  }

  if (entry.endpoint === 'query' && entry.message.startsWith('diversity boost')) {
    return `${YELLOW}  ⚖ ${entry.message}${RESET}\n`;
  }

  // ═══ CONTEXT INJECTION — the full text injected into the agent ═══
  if (entry.endpoint === 'injection' && entry.message === 'CONTEXT INJECTED') {
    const injection = entry.detail || '';
    const lines = injection.split('\n');
    let output = `\n${CYAN}${BOLD}  ┌─ INJECTED INTO CONTEXT ─────────────────────────────────────${RESET}\n`;
    for (const line of lines) {
      output += `${CYAN}  │ ${line}${RESET}\n`;
    }
    output += `${CYAN}${BOLD}  └──────────────────────────────────────────────────────────────${RESET}\n`;
    return output;
  }

  // Flash count summary
  if (entry.endpoint === 'query' && entry.message.startsWith('completed')) {
    return `${DIM}  ⚡ ${entry.detail} in ${entry.elapsed}ms${RESET}\n`;
  }

  if (entry.endpoint === 'query' && entry.message === 'no flashes to inject') {
    return `${DIM}  ○ no flashes${RESET}\n`;
  }

  if (entry.endpoint === 'query' && entry.message === 'flow-state detected, suppressing flashes') {
    return `${YELLOW}  ⏸ flow-state: flashes suppressed${RESET}\n`;
  }

  // Research daemon
  if (entry.endpoint === 'prowler') {
    if (entry.message.startsWith('brave search')) {
      return `${PEACH}  🌐 ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('deep research:')) {
      return `${PEACH}  🌐 ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('created neuron')) {
      return `${GREEN}  🌐 ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('deep research complete')) {
      return `${GREEN}  🌐 ${entry.message}${RESET}\n`;
    }
    return null;
  }

  // ═══════════════════════════════════════
  // STOP — turn processing results
  // ═══════════════════════════════════════
  if (entry.endpoint === 'hook' && entry.message === 'Stop') {
    return `\n${BLUE}${BOLD}  ┌─ TURN PROCESSING ────────────────────────────────────────────${RESET}\n`;
  }

  if (entry.endpoint === 'toggle') {
    const color = entry.message.includes('ENABLED') ? GREEN : RED;
    return `${color}${BOLD}  ⚙ ${entry.message}${RESET}\n`;
  }

  // Ingestion (PostToolUse)
  if (entry.endpoint === 'ingest' && entry.message.startsWith('created')) {
    return `${BLUE}  │ ${GREEN}+ NEURON: ${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'ingest' && entry.message.startsWith('UPDATED')) {
    return `${BLUE}  │ ${YELLOW}↻ UPDATE: ${entry.message}${RESET}\n`;
  }

  // Summarize results — these are the mutations
  if (entry.endpoint === 'summarize' && entry.message.startsWith('train:')) {
    return `${BLUE}  │ ${MAGENTA}🧠 ${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'summarize' && entry.message.startsWith('pursuit: ✓')) {
    return `${BLUE}  │ ${GREEN}📊 ${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'summarize' && entry.message.startsWith('pursuit: ✗')) {
    return `${BLUE}  │ ${RED}📊 ${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'summarize' && entry.message.startsWith('pursuit: ○')) {
    return `${BLUE}  │ ${DIM}📊 ${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'summarize' && entry.message.startsWith('pursuit detection')) {
    return `${BLUE}  │ ${DIM}${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'summarize' && entry.message.startsWith('insight:')) {
    return `${BLUE}  │ ${GREEN}💡 INSIGHT: ${entry.message}${RESET}\n`;
  }
  if (entry.endpoint === 'summarize' && entry.message.startsWith('UPDATED:')) {
    return `${BLUE}  │ ${YELLOW}↻ ${entry.message}${RESET}\n`;
  }

  // Spider
  if (entry.endpoint === 'spider') {
    if (entry.message.includes('complete')) {
      return `${BLUE}  │ ${PEACH}🕷 ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('pruned:')) {
      return `${BLUE}  │ ${RED}🕷 PRUNED: ${entry.message}${RESET}\n`;
    }
    if (entry.message.includes('GDS scores')) {
      return `${BLUE}  │ ${PEACH}🕷 ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('edge discovery:') && !entry.message.includes('0 edges')) {
      return `${BLUE}  │ ${GREEN}🕷 ${entry.message}${RESET}\n`;
    }
    return `${BLUE}  │ ${DIM}🕷 ${entry.message}${RESET}\n`;
  }

  // Corrections
  if (entry.endpoint === 'correct') {
    const icon = entry.message.startsWith('DELETED') ? '🗑' :
                 entry.message.startsWith('DEMOTED') ? '⬇' :
                 entry.message.startsWith('UPDATED') ? '✏' : '🔧';
    return `${RED}${BOLD}  ${icon} CORRECTION: ${entry.message}${RESET} ${DIM}${entry.detail || ''}${RESET}\n`;
  }

  // Janitor daemon
  if (entry.endpoint === 'janitor') {
    if (entry.message.startsWith('cleaned')) {
      return `${BLUE}  │ ${RED}🧹 JANITOR: ${entry.message}${RESET}\n`;
    }
    if (entry.message.includes('DRY RUN')) {
      return `${BLUE}  │ ${YELLOW}🧹 JANITOR: ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('janitor complete')) {
      return `${BLUE}  │ ${PEACH}🧹 ${entry.message}${RESET}\n`;
    }
    return `${BLUE}  │ ${DIM}🧹 ${entry.message}${RESET}\n`;
  }

  // Wonder daemon
  if (entry.endpoint === 'wonder') {
    if (entry.message.startsWith('analysis:')) {
      return `${BLUE}  │ ${MAGENTA}🧠 WONDER: ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('prepared')) {
      return `${BLUE}  │ ${GREEN}🧠 WONDER: ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('serving')) {
      return `${GREEN}${BOLD}  🧠 WONDER: ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('queries:')) {
      return `${BLUE}  │ ${PEACH}🧠 WONDER: ${entry.message}${RESET}\n`;
    }
    return `${BLUE}  │ ${DIM}🧠 WONDER: ${entry.message}${RESET}\n`;
  }

  // Chase
  if (entry.endpoint === 'chase') {
    return `${GREEN}${BOLD}  🔭 CHASE: ${entry.message}${RESET} ${DIM}${entry.detail || ''}${RESET}\n`;
  }

  // URL/file ingest
  if (entry.endpoint === 'ingest-url' || entry.endpoint === 'ingest-file') {
    if (entry.message.startsWith('created')) {
      return `${GREEN}  📥 ${entry.message}${RESET}\n`;
    }
    if (entry.message.startsWith('ingesting')) {
      return `${DIM}  📥 ${entry.message}${RESET}\n`;
    }
    return null;
  }

  // Errors — always show
  if (entry.level === 'error') {
    return `${RED}  ✗ [${entry.endpoint}] ${entry.message}${RESET}\n`;
  }

  return null;
}

function processNewLines(filepath) {
  try {
    const content = readFileSync(filepath, 'utf8');
    if (content.length <= lastSize) return;

    const newContent = content.slice(lastSize);
    lastSize = content.length;

    const lines = newContent.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const output = formatEntry(entry);
        if (output) process.stdout.write(output);
      } catch {}
    }
  } catch {}
}

// Header
console.log(`${MAGENTA}${BOLD}`);
console.log(`  ╔══════════════════════════════════════╗`);
console.log(`  ║   Undertow Flash Monitor             ║`);
console.log(`  ║   The Id is watching...              ║`);
console.log(`  ╚══════════════════════════════════════╝`);
console.log(`${RESET}`);
console.log(`${DIM}  Monitoring: ${LOG_DIR}`);
console.log(`  ${CYAN}cyan${RESET}${DIM} = injected context  ${PEACH}peach${RESET}${DIM} = search/daemons  ${GREEN}green${RESET}${DIM} = mutations  ${RED}red${RESET}${DIM} = corrections/errors${RESET}`);
console.log(`${DIM}  Ctrl+C to stop${RESET}\n`);

// Initial read
let logFile = getLogFile();
try {
  lastSize = readFileSync(logFile, 'utf8').length;
} catch {
  lastSize = 0;
}

// Watch for changes
let watcher = watchFile(logFile, { interval: 500 }, () => {
  processNewLines(logFile);
});

// Check for midnight log rotation — switch to new file
setInterval(() => {
  const currentFile = getLogFile();
  if (currentFile !== logFile) {
    // Stop watching old file, start watching new one
    unwatchFile(logFile);
    logFile = currentFile;
    lastSize = 0;
    processNewLines(logFile);
    watcher = watchFile(logFile, { interval: 500 }, () => {
      processNewLines(logFile);
    });
  }
}, 60000);
