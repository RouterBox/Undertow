// LLM provider seam.
//
// Every model call in Undertow goes through this module: the service routes,
// the daemons (via the injected `callAnthropic`, which is `callLLM` below) and
// the historical ingestor. It owns two things:
//
//   1. Model resolution — which model id each role uses (env-overridable).
//   2. The provider — the thing that actually sends a request. The built-in
//      provider is Anthropic (@anthropic-ai/sdk). A deployment can supply its
//      own provider module without forking core (UNDERTOW_LLM_PROVIDER_MODULE).
//
// Env is read lazily (at call time), because ESM imports are evaluated before
// the importing module runs dotenv.config().
//
// Provider plugin contract
// ------------------------
// UNDERTOW_LLM_PROVIDER_MODULE points at an ESM module (absolute path, or
// relative to this service/ directory) that exports:
//
//   export async function createMessage({ model, system, userContent, maxTokens, thinking })
//
// and resolves to an Anthropic-Messages-shaped object:
//
//   { content: [{ type: 'text', text: '...' }], stop_reason?, usage? }
//
// `thinking` is either undefined or { type: 'disabled' }; providers without a
// thinking concept can ignore it. To get the built-in retry/fallback, throw an
// error with `status = 429` (rate limited) or `status = 529` (overloaded).
// An optional `export const name = '...'` labels the provider in logs.

import Anthropic from '@anthropic-ai/sdk';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defaults preserve the ids Undertow has always used.
export const DEFAULT_MODELS = Object.freeze({
  query: 'claude-haiku-5-5',      // flash selection, evaluations, session start, spider
  ingest: 'claude-haiku-5-5',     // Gobble / external / URL / file / historical ingest
  summarize: 'claude-sonnet-5',   // Dreamer turn summaries, Wonder deep analysis
});

const ROLE_ENV = Object.freeze({
  query: 'UNDERTOW_QUERY_MODEL',
  ingest: 'UNDERTOW_INGEST_MODEL',
  summarize: 'UNDERTOW_SUMMARIZE_MODEL',
});

/** Resolve the model id for a role: 'query' | 'ingest' | 'summarize' | 'fallback'. */
export function resolveModel(role, env = process.env) {
  if (role === 'fallback') {
    // Historically the fallback is the query model (Haiku).
    return env.UNDERTOW_FALLBACK_MODEL || resolveModel('query', env);
  }
  if (!(role in DEFAULT_MODELS)) throw new Error(`unknown model role: ${role}`);
  return env[ROLE_ENV[role]] || DEFAULT_MODELS[role];
}

/** Haiku 5.5 and Sonnet 5 think by default and burn small max_tokens budgets before writing any text. */
export function shouldDisableThinking(model) {
  return model.startsWith('claude-haiku') || model.startsWith('claude-sonnet-5');
}

/** Built-in Anthropic provider. */
export function createAnthropicProvider(env = process.env) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.UNDERTOW_LLM_BASE_URL ? { baseURL: env.UNDERTOW_LLM_BASE_URL } : {}),
    // Identity-linked ("All workspaces") API keys require the workspace to act in.
    defaultHeaders: env.ANTHROPIC_WORKSPACE_ID
      ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID }
      : undefined,
  });
  return {
    name: 'anthropic',
    createMessage({ model, system, userContent, maxTokens, thinking }) {
      return client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        system,
        messages: [{ role: 'user', content: userContent }],
      });
    },
  };
}

/** Build the configured provider (does not cache). */
export async function loadProvider(env = process.env) {
  const modulePath = env.UNDERTOW_LLM_PROVIDER_MODULE;
  if (modulePath) {
    const abs = isAbsolute(modulePath) ? modulePath : resolve(__dirname, modulePath);
    const mod = await import(pathToFileURL(abs).href);
    const createMessage = mod.createMessage || mod.default?.createMessage;
    if (typeof createMessage !== 'function') {
      throw new Error(`UNDERTOW_LLM_PROVIDER_MODULE (${modulePath}) must export createMessage()`);
    }
    return { name: mod.name || mod.default?.name || `module:${modulePath}`, createMessage };
  }
  const provider = (env.UNDERTOW_LLM_PROVIDER || 'anthropic').toLowerCase();
  if (provider === 'anthropic') return createAnthropicProvider(env);
  throw new Error(`unknown UNDERTOW_LLM_PROVIDER "${provider}" — use "anthropic" or set UNDERTOW_LLM_PROVIDER_MODULE`);
}

/** True when the configured provider is the built-in Anthropic one (needs ANTHROPIC_API_KEY). */
export function usesAnthropicProvider(env = process.env) {
  return !env.UNDERTOW_LLM_PROVIDER_MODULE && (env.UNDERTOW_LLM_PROVIDER || 'anthropic').toLowerCase() === 'anthropic';
}

let providerPromise = null;
/** The process-wide provider, created on first use. */
export function getProvider() {
  if (!providerPromise) {
    providerPromise = loadProvider().catch(e => { providerPromise = null; throw e; });
  }
  return providerPromise;
}

/** Test hook: drop the cached provider. */
export function resetProvider() { providerPromise = null; }

/**
 * Resilient call with retry + model fallback. Returns { response, model } or
 * null on failure (callers treat null as "no answer"). Callers read
 * response.content[0].text, so text blocks are moved to the front.
 *
 * Signature matches the historical callAnthropic(model, system, userContent, maxTokens).
 */
export async function callLLM(model, system, userContent, maxTokens = 500, { log = () => {}, provider } = {}) {
  const maxRetries = 2;
  const fallbackModel = resolveModel('fallback');
  let currentModel = model;
  let p = provider;
  if (!p) {
    try { p = await getProvider(); } catch (e) {
      log('api', 'error', `LLM provider unavailable: ${e.message}`);
      return null;
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const message = await p.createMessage({
        model: currentModel,
        system,
        userContent,
        maxTokens,
        thinking: shouldDisableThinking(currentModel) ? { type: 'disabled' } : undefined,
      });
      const blocks = Array.isArray(message.content) ? message.content : [];
      if (!blocks.some(b => b?.type === 'text' && b.text)) {
        log('api', 'warn', `${currentModel} returned no text block`, {
          detail: `stop_reason=${message.stop_reason} types=${blocks.map(b => b?.type).join(',') || 'none'} out_tokens=${message.usage?.output_tokens}`
        });
      }
      message.content = [...blocks.filter(b => b?.type === 'text'), ...blocks.filter(b => b?.type !== 'text')];
      return { response: message, model: currentModel };
    } catch (e) {
      const isOverloaded = e.status === 529 || e.message?.includes('Overloaded') || e.message?.includes('overloaded');
      const isRateLimit = e.status === 429;

      if (isOverloaded || isRateLimit) {
        if (attempt < maxRetries) {
          // First retry: wait and try same model
          if (attempt === 0) {
            const delay = 2000 + Math.random() * 1000;
            log('api', 'warn', `${currentModel} ${e.status} — retrying in ${Math.round(delay)}ms`);
            await new Promise(r => setTimeout(r, delay));
          }
          // Second retry: fall back to cheaper model
          if (attempt === 1 && currentModel !== fallbackModel) {
            currentModel = fallbackModel;
            log('api', 'warn', `falling back to ${fallbackModel}`);
          }
        } else {
          log('api', 'error', `all retries exhausted for ${model} (${e.status})`);
          return null;
        }
      } else {
        log('api', 'error', `${currentModel}: ${e.message}`);
        return null;
      }
    }
  }
  return null;
}
