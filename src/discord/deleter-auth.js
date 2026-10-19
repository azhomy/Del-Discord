// Del-Discord v1 — personal source modules.
import { API, AUTH_CACHE_TTL } from '../config.js';
import { tokenCandidates } from './token.js';
import { apiFetch, RunStoppedError } from './api.js';
import { waitWithSignal } from '../utils/abort.js';

export let authCache = null;

export async function validateToken(token, { log = () => {}, stopCheck = () => false, strict = false, signal } = {}) {
  if (!token) return null;
  try {
    const r = await apiFetch(`${API}/users/@me`, { headers: { Authorization: token }, signal }, log, stopCheck, { minIntervalMs: 1000 });
    if (stopCheck()) throw new RunStoppedError();
    if (!r.ok) {
      if (strict && r.status !== 401) throw new Error(`Authorization check failed with HTTP ${r.status}. Export stopped.`);
      return null;
    }
    return await waitWithSignal(r.json(), signal);
  } catch (error) {
    if (strict || error instanceof RunStoppedError) throw error;
    return null;
  }
}

export function invalidateAuth() {
  authCache = null;
}

export async function resolveToken(preferred = '', requestOptions = {}) {
  requestOptions.signal?.throwIfAborted();
  if (requestOptions.stopCheck?.()) throw new RunStoppedError();
  const now = Date.now();
  if (
    authCache &&
    now - authCache.at < AUTH_CACHE_TTL &&
    (!preferred || preferred === authCache.token)
  ) {
    return authCache.identity;
  }

  const candidates = [];
  const seen = new Set();
  const add = token => {
    if (token && !seen.has(token)) {
      seen.add(token);
      candidates.push(token);
    }
  };

  add(preferred);
  for (const token of tokenCandidates()) add(token);

  for (const token of candidates) {
    const user = await validateToken(token, requestOptions);
    if (user?.id) {
      const identity = { token, user };
      authCache = { at: now, token, identity };
      return identity;
    }
    if (requestOptions.strict) break;
  }

  invalidateAuth();
  return null;
}
