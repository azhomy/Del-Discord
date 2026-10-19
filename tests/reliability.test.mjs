import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { removeReactions } from '../src/features/reactions.js';
import { runState } from '../src/utils/run-state.js';
import { API } from '../src/config.js';
import { retryMs } from '../src/utils/timing.js';
import { apiFetch } from '../src/discord/history-api.js';
import { exportConversationData } from '../src/features/export.js';
import { observeDiscordPage } from '../src/discord/page-observer.js';
import { findDiscordToolbar } from '../src/discord/toolbar.js';

function setGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

const exportOptions = { token: 'test', guildId: '@me', channelId: 'channel', log: () => {} };
const message = id => ({ id, timestamp: '2026-01-01', content: id, type: 0 });

test('both panels use v10 and rate-limit delays remain seconds at all magnitudes', async t => {
  assert.equal(API, 'https://discord.com/api/v10');
  assert.equal(retryMs(0.5), 500);
  assert.equal(retryMs(1000), 1000000);
  assert.equal(retryMs('2.5'), 2500);
  assert.equal(retryMs(-1), 1500);
  assert.equal(retryMs(undefined), 1500);
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { waits.push(delay); callback(); return 0; });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? Response.json({ retry_after: 1000 }, { status: 429 }) : Response.json({ ok: true }));
  assert.equal((await apiFetch(`${API}/test`)).ok, true);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 1000250 && waits[0] <= 1000750);
});

test('export deduplicates overlapping pages and preserves unique ascending messages', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    if (urls.length > 3) throw new Error('Export should stop on a nonadvancing page');
    return Response.json(urls.length === 1 ? [message('300'), message('200'), message('200')] : urls.length === 2 ? [message('200'), message('100')] : []);
  });
  const result = await exportConversationData(exportOptions);
  assert.deepEqual(result.messages.map(message => message.id), ['100', '200', '300']);
  assert.equal(result.messageCount, 3);
  assert.equal(new URL(urls[1]).searchParams.get('before'), '200');
  assert.equal(new URL(urls[2]).searchParams.get('before'), '100');
});

test('export cancellation during rate limiting prevents another request', async t => {
  let stopped = false, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ retry_after: 0.1 }, { status: 429 }); });
  t.mock.method(globalThis, 'setTimeout', callback => { if (calls) stopped = true; callback(); return 0; });
  const result = await exportConversationData({ ...exportOptions, stopCheck: () => stopped });
  assert.equal(calls, 1);
  assert.equal(result.messageCount, 0);
});

test('export cancellation while fetching ignores the arriving page', async t => {
  let stopped = false;
  t.mock.method(globalThis, 'fetch', async () => { stopped = true; return Response.json([message('100')]); });
  const result = await exportConversationData({ ...exportOptions, stopCheck: () => stopped });
  assert.equal(result.messageCount, 0);
});

test('both panels share one page observer and burst mutations run once per frame', t => {
  let created = 0, notify, disconnected = 0;
  const frames = [];
  setGlobal(t, 'document', { body: {} });
  setGlobal(t, 'MutationObserver', class {
    constructor(callback) { created++; notify = callback; }
    observe() {}
    disconnect() { disconnected++; }
  });
  setGlobal(t, 'requestAnimationFrame', callback => frames.push(callback));
  let first = 0, second = 0;
  const removeFirst = observeDiscordPage(() => first++);
  const removeSecond = observeDiscordPage(() => second++);
  t.after(() => { removeFirst(); removeSecond(); });
  notify(); notify(); notify();
  assert.equal(created, 1);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(first, 1);
  assert.equal(second, 1);
  removeFirst();
  notify(); frames.shift()();
  assert.equal(first, 1);
  assert.equal(second, 2);
  removeSecond();
  assert.equal(disconnected, 1);
});

test('toolbar discovery measures each candidate once and selects the visible header', t => {
  const dom = new JSDOM('<header><div role="toolbar"><button></button></div></header><div class="toolbar-hidden"></div>');
  t.after(() => dom.window.close());
  setGlobal(t, 'document', dom.window.document);
  setGlobal(t, 'innerWidth', 1000);
  const visible = dom.window.document.querySelector('[role="toolbar"]');
  const hidden = dom.window.document.querySelector('.toolbar-hidden');
  let measured = 0;
  visible.getBoundingClientRect = () => { measured++; return { width: 500, height: 40, top: 20, right: 900 }; };
  hidden.getBoundingClientRect = () => { measured++; return { width: 0, height: 0, top: 0, right: 0 }; };
  Object.defineProperty(visible, 'offsetParent', { get: () => visible.parentElement });
  assert.equal(findDiscordToolbar(), visible);
  assert.equal(measured, 2);
});


test('reaction cancellation during rate limiting prevents another request', async t => {
  t.after(() => { runState.reactionStopped = false; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ retry_after: 0.1 }, { status: 429 }); });
  t.mock.method(globalThis, 'setTimeout', callback => { runState.reactionStopped = true; callback(); return 0; });
  const logs = [];
  await removeReactions({ token: 'test', channelId: 'channel', scanLimit: 2, log: (...args) => logs.push(args) });
  assert.equal(calls, 1);
  assert.equal(logs.at(-1)[0], 'warn');
});


test('export validates ranges before requests and applies dates across paginated messages', async t => {
  const { toSnowflake } = await import('../src/utils/messages.js');
  const minId = '2026-01-01T00:00', maxId = '2026-02-01T00:00';
  const lower = BigInt(toSnowflake(minId)), upper = BigInt(toSnowflake(maxId));
  const urls = [];
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return Response.json(urls.length === 1
      ? [message(String(upper)), message(String(upper - 1n))]
      : [message(String(lower + 1n)), message(String(lower)), message(String(lower - 1n))]);
  });
  await assert.rejects(exportConversationData({ ...exportOptions, minId: 'invalid' }), /valid date/);
  await assert.rejects(exportConversationData({ ...exportOptions, minId: maxId, maxId: minId }), /earlier/);
  assert.equal(urls.length, 0);
  const result = await exportConversationData({ ...exportOptions, minId, maxId });
  assert.deepEqual(result.messages.map(item => item.id), [String(lower + 1n), String(upper - 1n)]);
  assert.deepEqual(result.range, { after: minId, before: maxId });
  assert.equal(new URL(urls[0]).searchParams.get('before'), String(upper));
  assert.equal(urls.length, 2);
});
