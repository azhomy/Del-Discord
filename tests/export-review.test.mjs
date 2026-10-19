import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { apiFetch, RunStoppedError } from '../src/discord/api.js';
import { sleep } from '../src/utils/timing.js';
import { collectExportAttachments, createAttachmentDownloadState } from '../src/features/export-attachments.js';
import { exportConversationData } from '../src/features/export.js';
import { filesToZip } from '../src/utils/zip.js';
import { askExportSelection } from '../src/ui/export-selection.js';

const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const instantTimers = t => t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
const message = id => ({ id, attachments: [] });

test('abort exits a long cooldown promptly without clearing the shared server delay', async t => {
  const timers = [], controller = new AbortController(); let calls = 0;
  t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return 0; });
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ retry_after: 3600 }, { status: 429 }) : Response.json({}));
  const options = { headers: { Authorization: 'review-cancel-cooldown' } };
  const pending = apiFetch('https://discord.com/api/cooldown', { ...options, signal: controller.signal });
  await tick(); assert.equal(timers.length, 1);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const next = apiFetch('https://discord.com/api/next', options);
  await tick(); assert.equal(calls, 1);
  timers[0](); await next; assert.equal(calls, 2);
});

test('abort reaches an in-flight fetch and cancels an attachment body without saving it', async t => {
  instantTimers(t);
  const controller = new AbortController(); let signalSeen, bodyStarted = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signalSeen = options.signal;
    return { ok: true, status: 200, headers: new Headers(), blob: () => { bodyStarted = true; return new Promise(() => {}); } };
  });
  const files = [], report = [];
  const task = collectExportAttachments({ channelId: '1', messages: [{ id: '2', attachments: [{ url: 'https://cdn.discordapp.com/file', filename: 'file.png' }] }] },
    { files, report, log: () => {}, signal: controller.signal });
  await tick(); assert.equal(bodyStarted, true); assert.equal(signalSeen, controller.signal);
  controller.abort(); await assert.rejects(task, RunStoppedError);
  assert.equal(files.length, 0); assert.equal(report.length, 0);
});

test('abort also interrupts a fetch that has not delivered headers', async t => {
  const controller = new AbortController(); let abortSeen = false;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { abortSeen = true; reject(signal.reason); }, { once: true });
  }));
  const task = apiFetch('https://discord.com/api/hanging', { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(task, { name: 'AbortError' });
  assert.equal(abortSeen, true);
});

test('HTTP-date and reset-after retry hints are honored, and invalid hints keep exponential fallback', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const delays = []; let count = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { delays.push(ms); callback(); return 0; });
  t.mock.method(globalThis, 'fetch', async () => ++count === 1 ? new Response('', { status: 429, headers: {
    'Retry-After': new Date(now + 20000).toUTCString(), 'X-RateLimit-Reset-After': '25'
  } }) : Response.json({}));
  await apiFetch('https://discord.com/api/date', { headers: { Authorization: 'review-date' } });
  assert.ok(delays[0] >= 25250 && delays[0] <= 25750);
  count = 0; delays.length = 0;
  t.mock.method(globalThis, 'fetch', async () => ++count <= 2 ? Response.json({ retry_after: 'invalid' }, { status: 429, headers: { 'Retry-After': 'invalid' } }) : Response.json({}));
  await apiFetch('https://discord.com/api/invalid', { headers: { Authorization: 'review-invalid-hints' } });
  assert.ok(delays[0] >= 1750 && delays[1] >= 3250);
});

test('long sleeps are split rather than overflowing the browser timer', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { timers.push({ callback, ms }); return 0; });
  const task = sleep(2147484647);
  assert.equal(timers[0].ms, 2147483647); timers[0].callback(); await tick();
  assert.equal(timers[1].ms, 1000); timers[1].callback(); await task;
});

test('a fresh signed URL can recover an attachment whose expired URL was already tried', async t => {
  instantTimers(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => { calls++; return url.includes('hm=expired') ? new Response('', { status: 403 }) : new Response('file'); });
  const context = { files: [], report: [], state: createAttachmentDownloadState(), log: () => {} };
  for (const [index, signature] of ['expired', 'fresh', 'another-fresh'].entries()) {
    await collectExportAttachments({ channelId: '1', messages: [{ id: String(index + 1), attachments: [{ filename: 'x'.repeat(100) + '.png', url: `https://cdn.discordapp.com/path/file?hm=${signature}` }] }] }, context);
  }
  assert.equal(calls, 2); assert.equal(context.files.length, 1);
  assert.deepEqual(context.report.map(item => item.status), ['failed', 'downloaded', 'reused']);
  assert.ok(context.files[0].name.endsWith('.png'));
  assert.equal(context.state.consecutiveFailures, 0);
});

test('malformed and stalled pages fail explicitly rather than producing a successful partial export', async t => {
  instantTimers(t);
  const options = { channelId: '1', token: 'review-pages', log: () => {} };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ unexpected: true }));
  await assert.rejects(exportConversationData(options), /invalid message page/);
  t.mock.method(globalThis, 'fetch', async () => Response.json([message('100'), { id: null }]));
  await assert.rejects(exportConversationData(options), /malformed message/);
  t.mock.method(globalThis, 'fetch', async () => Response.json([message('100')]));
  await assert.rejects(exportConversationData(options), /pagination did not advance/);
});

test('ZIP validates the entire archive before reading any payload, and rejects unsafe paths', async () => {
  let reads = 0;
  const small = { size: 1, slice: () => { reads++; throw new Error('Payload should not be read'); } };
  await assert.rejects(filesToZip([{ name: 'small', blob: small }, { name: 'large', blob: { size: 0xffffffff } }]), /4 GB/);
  assert.equal(reads, 0);
  await assert.rejects(filesToZip([{ name: '../escape', blob: new Blob([]) }]), /Invalid ZIP file path/);
});

test('export dialog abort closes it, and ID boundaries cannot silently accept date strings', async t => {
  const dom = new JSDOM('<div id="dmd-panel"></div>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; dom.window.close(); });
  const controller = new AbortController(), doc = dom.window.document;
  const task = askExportSelection([{ channelId: '1' }], { select: false, signal: controller.signal });
  const input = doc.querySelector('#dmd-export-minId'), kind = input.previousElementSibling;
  kind.value = 'id'; kind.dispatchEvent(new dom.window.Event('change'));
  input.value = '2026-01-01'; input.dispatchEvent(new dom.window.Event('input'));
  assert.equal(doc.querySelector('.dmd-confirm-actions button:last-child').disabled, true);
  controller.abort(); assert.equal(await task, false); assert.equal(doc.querySelector('.dmd-confirm-overlay'), null);
  assert.equal(await askExportSelection([], { signal: controller.signal }), false);
});

for (const stage of ['dialog', 'cooldown', 'body', 'attachment']) test(`bundled export Stop cancels ${stage}, unlocks the panel and creates no download`, async t => {
  const channelId = '345678901234567890';
  const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/@me/${channelId}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, downloads = []; let bodyStarted = false;
  dom.window.Blob = Blob;
  dom.window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  dom.window.localStorage.setItem('del_discord_v1_queue', JSON.stringify([{ guildId: '@me', channelId, label: 'Test' }]));
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
    if (stage === 'attachment') {
      if (url.startsWith('https://cdn.discordapp.com/')) return { ok: true, status: 200, headers: new Headers(), blob: () => { bodyStarted = true; return new Promise(() => {}); } };
      return Response.json(new URL(url).searchParams.has('before') ? [] : [{ id: '456789012345678901', attachments: [{ filename: 'file.png', url: 'https://cdn.discordapp.com/file' }] }]);
    }
    if (stage === 'cooldown') { bodyStarted = true; return Response.json({ retry_after: 3600 }, { status: 429 }); }
    return { ok: true, status: 200, headers: new Headers(), json: () => { bodyStarted = true; return new Promise(() => {}); } };
  };
  vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  doc.querySelector('#dmd-token').value = 'test';
  const task = doc.querySelector('#dmd-multi-export').onclick();
  const popup = doc.querySelector('.dmd-confirm-box'); assert.ok(popup);
  if (stage !== 'dialog') {
    popup.querySelector('.dmd-export-list input').click();
    if (stage === 'attachment') popup.querySelector('#dmd-export-attachments').click();
    popup.querySelector('.dmd-confirm-actions button:last-child').click();
    for (let i = 0; i < 500 && !bodyStarted; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(bodyStarted, true, doc.querySelector('#dmd-log').textContent);
    await new Promise(resolve => setImmediate(resolve));
  }
  doc.querySelector('#dmd-multi-stop').click(); await task;
  assert.equal(downloads.length, 0);
  assert.equal(doc.querySelector('#dmd-multi-export').disabled, false);
  assert.equal(doc.querySelector('#dmd-multi-stop').disabled, true);
  assert.equal(doc.querySelector('.dmd-confirm-overlay'), null);
});


test('cancelling a middle pacing waiter does not let a later request bypass an earlier one', async t => {
  const { apiFetch: pacedFetch } = await import('../src/discord/api.js?review-pacing');
  const calls = [], timers = [], controller = new AbortController();
  t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return 0; });
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return Response.json({}); });
  const request = (path, signal) => pacedFetch(`https://discord.com/${path}`, { signal }, () => {}, () => false, { minIntervalMs: 1000 });
  await request('first');
  const earlier = request('earlier'), cancelled = request('cancelled', controller.signal), later = request('later');
  await tick(); assert.equal(timers.length, 1); assert.equal(calls.length, 1);
  controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  await tick(); assert.equal(calls.length, 1); assert.equal(timers.length, 1);
  timers[0](); await earlier; await tick();
  assert.equal(timers.length, 2); assert.equal(calls.length, 2);
  timers[1](); await later;
  assert.deepEqual(calls.map(url => url.split('/').at(-1)), ['first', 'earlier', 'later']);
});
