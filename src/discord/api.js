// Del-Discord v1 — personal source modules.
import { rand, retryMs, sleep } from '../utils/timing.js';
import { waitWithSignal } from '../utils/abort.js';

export class RunStoppedError extends Error {
  constructor() { super('Stopped.'); this.name = 'RunStoppedError'; }
}

export class RateLimitError extends Error {
  constructor() { super('Repeated rate limits. Requests stopped; wait before trying again.'); this.name = 'RateLimitError'; }
}

// Serialize paced starts within this script, including retries and CDN requests.
let paceTail = Promise.resolve(), lastPacedStart = null;
async function paceRequest(interval, stopCheck, signal) {
  const previous = paceTail;
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  paceTail = previous.then(() => turn);
  try {
    await waitWithSignal(previous, signal);
    if (stopCheck()) throw new RunStoppedError();
    if (lastPacedStart !== null) {
      const wait = interval - (performance.now() - lastPacedStart);
      if (wait > 0) await waitWithSignal(sleep(wait), signal);
    }
    if (stopCheck()) throw new RunStoppedError();
    lastPacedStart = performance.now();
  } finally { release(); }
}

// A conservative shared cooldown keeps other panels from continuing to request
// with the same account while Discord asks us to wait. Nothing is persisted.
const cooldowns = new Map();
function pauseAccount(key, milliseconds) {
  const previous = cooldowns.get(key);
  const pause = Promise.all([previous, sleep(milliseconds + rand(250, 750))]).finally(() => {
    if (cooldowns.get(key) === pause) cooldowns.delete(key);
  });
  cooldowns.set(key, pause);
  return pause;
}

export async function apiFetch(url, options = {}, log = () => {}, stopCheck = () => false, { minIntervalMs = 0, maxRateLimitRetries = 2 } = {}) {
  let retries = 0;
  const account = new Headers(options.headers).get('Authorization') || new URL(url).origin;
  while (true) {
    if (stopCheck()) throw new RunStoppedError();
    let cooldown;
    // A concurrent response can extend an account's pause while this caller
    // waits. Recheck the shared pause before sending another request.
    while ((cooldown = cooldowns.get(account))) {
      await waitWithSignal(cooldown, options.signal);
      if (stopCheck()) throw new RunStoppedError();
    }
    if (minIntervalMs > 0) {
      await paceRequest(minIntervalMs, stopCheck, options.signal);
      // Another caller may have extended a cooldown while this request paced.
      if (cooldowns.has(account)) continue;
    }
    if (stopCheck()) throw new RunStoppedError();
    options.signal?.throwIfAborted();
    const response = await waitWithSignal(fetch(url, options), options.signal);
    if (response.status !== 429) {
      const reset = response.headers.get('X-RateLimit-Reset-After');
      if (response.headers.get('X-RateLimit-Remaining') === '0' && reset !== null && Number.isFinite(Number(reset)) && Number(reset) >= 0) {
        pauseAccount(account, retryMs(reset));
      }
      return response;
    }
    let body = {};
    try { body = await waitWithSignal(response.json(), options.signal) || {}; } catch {}
    const seconds = value => value !== null && value !== '' && ['number', 'string'].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) * 1000 : null;
    const header = response.headers.get('Retry-After');
    let headerDelay = seconds(header);
    // CDN responses can use HTTP dates rather than a number of seconds.
    if (headerDelay === null && header && /GMT$/i.test(header)) {
      const date = Date.parse(header);
      if (Number.isFinite(date)) headerDelay = Math.max(0, date - Date.now());
    }
    const hints = [seconds(body.retry_after), headerDelay, seconds(response.headers.get('X-RateLimit-Reset-After'))].filter(value => value !== null);
    const delay = hints.length ? Math.max(...hints) : Math.min(30000, 1500 * 2 ** retries);
    const pause = pauseAccount(account, delay);
    options.signal?.throwIfAborted();
    if (retries++ >= maxRateLimitRetries) throw new RateLimitError();
    log('warn', `Rate limited. Waiting at least ${(delay / 1000).toFixed(1)}s before retry ${retries}/${maxRateLimitRetries}...`);
    await waitWithSignal(pause, options.signal);
  }
}
