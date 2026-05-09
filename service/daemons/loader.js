import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'daemon-config.json');

let config = null;

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch {
    config = { daemons: {}, global: {} };
  }
  return config;
}

export function getConfig() {
  return config || { daemons: {}, global: {} };
}

export function getDaemonConfig(name) {
  const c = getConfig();
  return c.daemons?.[name] || { enabled: false };
}

export function isDaemonEnabled(name) {
  return getDaemonConfig(name).enabled !== false;
}
