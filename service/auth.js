// Optional bearer-token guard (UNDERTOW_API_TOKEN).
//
// When a token is configured, require `Authorization: Bearer <token>` on:
//   - /mcp (every method)
//   - every mutating /undertow/* request (anything but GET / HEAD / OPTIONS)
// Read-only GET routes and the bare /health ping stay open. With no token the
// guard is not installed at all, so existing callers are unaffected.

import { timingSafeEqual } from 'crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function needsToken(method, path) {
  if (path === '/mcp' || path.startsWith('/mcp/')) return true;
  return path.startsWith('/undertow/') && !SAFE_METHODS.has(method);
}

function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Express middleware; install only when a token is set. */
export function apiTokenGuard(token) {
  return (req, res, next) => {
    if (!needsToken(req.method, req.path)) return next();
    if (tokenMatches(req.get('authorization'), token)) return next();
    res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'unauthorized: missing or invalid bearer token' });
  };
}
