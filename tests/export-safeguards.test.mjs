import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, RateLimitError, RunStoppedError } from '../src/discord/api.js';
import { resolveToken, invalidateAuth } from '../src/discord/deleter-auth.js';
import { collectExportAttachments, createAttachmentDownloadState } from '../src/features/export-attachments.js';
import { exportConversationData } from '../src/features/export.js';

const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const item = (url, id = '1') => ({ channelId: 'channel', messages: [{ id, attachments: [{ id: 'a', filename: 'file.png', url }] }] });
const setup = t => {
  const files = [], report = [], logs = [], state = createAttachmentDownloadState();
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  return { files, report, state, log: (...args) => logs.push(args), logs };
};

test('repeated 429s stop after three attempts and retain the final shared cooldown', async t => {
  let calls = 0, release;
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    if (calls === 3) release = callback; else callback();
    return 0;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls <= 3 ? new Response('blocked', { status: 429, headers: { 'Retry-After': '5' } }) : Response.json({});
  });
  const options = { headers: { Authorization: 'bounded-retries' } };
  await assert.rejects(apiFetch('https://discord.com/api/test', options), RateLimitError);
  assert.equal(calls, 3); assert.ok(delays.every(delay => delay >= 5250));
  const next = apiFetch('https://discord.com/api/next', options);
  await tick(); assert.equal(calls, 3);
  release(); await next; assert.equal(calls, 4);
});

test('missing retry hints use increasing backoff, and JSON null cannot crash the limiter', async t => {
  let calls = 0; const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); callback(); return 0; });
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(null, { status: 429 }); });
  await assert.rejects(apiFetch('https://discord.com/api/fallback', { headers: { Authorization: 'fallback-retries' } }), RateLimitError);
  assert.equal(calls, 3); assert.equal(delays.length, 3);
  assert.ok(delays[0] >= 1750 && delays[1] >= 3250 && delays[2] >= 6250);
});

test('pacing serializes API and CDN starts, including concurrent callers, and Stop prevents a waiting request', async t => {
  const calls = [], timers = [];
  let stopped = false;
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return Response.json({}); });
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  await apiFetch('https://discord.com/api/first', {}, () => {}, () => false, { minIntervalMs: 1000 });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { timers.push({ callback, delay }); return 0; });
  const next = apiFetch('https://cdn.discordapp.com/file', {}, () => {}, () => false, { minIntervalMs: 1000 });
  const cancelled = apiFetch('https://discord.com/api/cancelled', {}, () => {}, () => stopped, { minIntervalMs: 1000 });
  await tick(); assert.equal(calls.length, 1); assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0 && timers[0].delay <= 1000);
  stopped = true; timers[0].callback();
  await next; await assert.rejects(cancelled, RunStoppedError);
  assert.deepEqual(calls, ['https://discord.com/api/first', 'https://cdn.discordapp.com/file']);
});

test('attachment cache shares successful and failed URLs across conversations without repeating downloads', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => { calls++; return url.includes('/bad') ? new Response('', { status: 403 }) : new Response('bytes'); });
  await collectExportAttachments(item('https://cdn.discordapp.com/file?ex=1&is=2&hm=old'), context);
  await collectExportAttachments(item('https://cdn.discordapp.com/file?hm=new&ex=3&is=4', '2'), context);
  await collectExportAttachments(item('https://cdn.discordapp.com/bad'), context);
  await collectExportAttachments(item('https://cdn.discordapp.com/bad', '3'), context);
  assert.equal(calls, 2); assert.equal(context.files.length, 1);
  assert.deepEqual(context.report.map(entry => entry.status), ['downloaded', 'reused', 'failed', 'failed']);
  assert.equal(context.report[1].path, context.report[0].path);
  assert.equal(context.state.consecutiveFailures, 1);
});

test('three consecutive failures stop subsequent attachment requests while recording skipped files', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 403 }); });
  for (let i = 0; i < 5; i++) await collectExportAttachments(item(`https://cdn.discordapp.com/${i}`, String(i)), context);
  assert.equal(calls, 3); assert.equal(context.files.length, 0);
  assert.deepEqual(context.report.map(entry => entry.status), ['failed', 'failed', 'failed', 'skipped', 'skipped']);
  assert.match(context.report[4].error, /Three consecutive/);
});

test('retry exhaustion suspends all subsequent attachment requests for the export', async t => {
  const context = setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ retry_after: 0 }, { status: 429 }); });
  await collectExportAttachments(item('https://cdn.discordapp.com/limited'), context);
  await collectExportAttachments(item('https://media.discordapp.net/other', '2'), context);
  assert.equal(calls, 3); assert.deepEqual(context.report.map(entry => entry.status), ['failed', 'skipped']);
});

test('message export aborts on repeated throttling and never advances to another page', async t => {
  setup(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ retry_after: 0 }, { status: 429 }); });
  await assert.rejects(exportConversationData({ token: 'stop-message-export', channelId: '1', log: () => {} }), RateLimitError);
  assert.equal(calls, 3);
});

test('strict export authentication uses bounded retries and stops immediately on an invalid token', async t => {
  setup(t); invalidateAuth(); t.after(invalidateAuth);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ retry_after: 0 }, { status: 429 }); });
  await assert.rejects(resolveToken('export-auth', { strict: true }), RateLimitError);
  assert.equal(calls, 3);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 401 }); });
  assert.equal(await resolveToken('invalid-auth', { strict: true }), null); assert.equal(calls, 4);
});
