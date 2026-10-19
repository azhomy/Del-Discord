import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationToBlob, conversationsToCsv } from '../src/features/export.js';
import { RunStoppedError } from '../src/discord/api.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { parseCsv } from '../src/utils/csv.js';
import { toSnowflake } from '../src/utils/messages.js';

const conversation = count => ({
  exportedAt: '2026-10-09T12:00:00.000Z', guildId: '@me', channelId: '123456789012345678',
  label: 'A "quoted" conversation', range: { after: null, before: null }, messageCount: count,
  messages: Array.from({ length: count }, (_, index) => ({
    id: String(123456789012345678n + BigInt(index)), content: `row ${index}: 😀 "line"\n` + 'contents '.repeat(200),
    attachments: [{ filename: 'image.png', url: 'https://example.invalid/image.png' }],
    embeds: [], reactions: [], mentions: [], referencedMessage: null
  }))
});

test('chunked JSON export preserves complete metadata, message bodies and empty conversations', async () => {
  for (const count of [0, 120]) {
    const data = conversation(count);
    const blob = await conversationToBlob(data);
    assert.equal(blob.type, 'application/json;charset=utf-8');
    assert.deepEqual(JSON.parse(await blob.text()), data);
  }
});

test('chunked CSV exports combine with one header and preserve quoted multiline UTF-8 data', async () => {
  const data = [conversation(120), conversation(0), conversation(2)];
  const blobs = await Promise.all(data.map((item, index) => conversationToBlob(item, { format: 'csv', includeCsvHeader: index === 0 })));
  assert.equal(blobs[1].size, 0);
  const combined = new Blob([blobs[0], '\r\n', blobs[2]]);
  assert.equal(await combined.text(), conversationsToCsv(data));
});

test('large serialization yields to the event loop and cancellation discards the artifact', async t => {
  let stopped = false, turns = 0, clock = 0;
  t.mock.method(performance, 'now', () => clock += 10);
  t.mock.method(globalThis, 'setTimeout', callback => { turns++; stopped = true; callback(); return 0; });
  await assert.rejects(conversationToBlob(conversation(120), { stopCheck: () => stopped }), RunStoppedError);
  assert.equal(turns, 1);
  await assert.rejects(conversationToBlob(conversation(0), { stopCheck: () => true }), RunStoppedError);
});

for (const withAttachments of [false, true]) test(`bundled queue CSV export applies dates and attachment toggle (${withAttachments})`, async t => {
  const emptyChannel = '234567890123456789', dataChannel = '345678901234567890';
  const after = '2026-01-01T00:00', before = '2026-02-01T00:00';
  const messageId = toSnowflake('2026-01-15T00:00'), requests = [];
  const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/@me/${dataChannel}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, downloads = [], methods = [];
  dom.window.Blob = Blob;
  dom.window.TextEncoder = TextEncoder;
  const attachmentCalls = [];
  dom.window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  dom.window.setTimeout = callback => { callback(); return 0; };
  dom.window.localStorage.setItem('del_discord_v1_queue', JSON.stringify([
    { guildId: '@me', channelId: emptyChannel, label: 'Empty' },
    { guildId: '@me', channelId: dataChannel, label: 'With text' },
  ]));
  dom.window.fetch = async (url, options) => {
    methods.push(options?.method || 'GET');
    if (url.startsWith('https://cdn.discordapp.com/')) { attachmentCalls.push(options); return new Response(new Uint8Array([0, 255, 128])); }
    if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
    const request = new URL(url);
    requests.push(request);
    if (request.pathname.includes(dataChannel) && request.searchParams.get('before') === toSnowflake(before)) return Response.json([{
      id: messageId, type: 0, content: '😀, "quote"\nnext line', author: { id: 'self' }, poll: { question: { text: 'Which?' } }, attachments: [{ id: 'file', filename: 'photo.png', url: 'https://cdn.discordapp.com/attachments/file/photo.png' }],
    }]);
    return Response.json([]);
  };
  vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  doc.querySelector('#dmd-token').value = 'export-test';
  const task = doc.querySelector('#dmd-multi-export').onclick();
  for (let attempt = 0; attempt < 100 && !doc.querySelector('.dmd-export-list'); attempt++) await new Promise(resolve => setImmediate(resolve));
  const popup = doc.querySelector('.dmd-confirm-box');
  assert.ok(popup);
  popup.querySelector('.dmd-export-list').previousElementSibling.click();
  for (const [id, value] of [['minId', after], ['maxId', before]]) {
    const input = popup.querySelector(`#dmd-export-${id}`);
    input.value = value; input.dispatchEvent(new dom.window.Event('input'));
  }
  popup.querySelector('input[value="csv"]').click();
  assert.equal(popup.querySelector('#dmd-export-attachments').checked, false);
  if (withAttachments) popup.querySelector('#dmd-export-attachments').click();
  popup.querySelectorAll('.dmd-confirm-actions button')[1].click();
  await task;
  assert.equal(downloads.length, 1);
  let csv = downloads[0];
  if (withAttachments) {
    assert.equal(csv.type, 'application/zip');
    const bytes = new Uint8Array(await csv.arrayBuffer()), view = new DataView(bytes.buffer), entries = new Map();
    for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
      const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true);
      const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + length));
      const start = offset + 30 + length;
      entries.set(name, bytes.slice(start, start + size)); offset = start + size;
    }
    csv = new Blob([[...entries].find(([name]) => name.endsWith('.csv'))[1]]);
    assert.deepEqual(entries.get(`attachments/${dataChannel}/${messageId}/1-photo.png`), new Uint8Array([0, 255, 128]));
    const report = JSON.parse(new TextDecoder().decode(entries.get('attachments.json')));
    assert.equal(report[0].status, 'downloaded'); assert.equal(report[0].size, 3);
    assert.equal(attachmentCalls.length, 1); assert.equal(attachmentCalls[0].credentials, 'omit');
    assert.equal(attachmentCalls[0].headers, undefined);
  } else {
    assert.equal(csv.type, 'text/csv;charset=utf-8'); assert.equal(attachmentCalls.length, 0);
  }
  const rows = parseCsv(await csv.text());
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], dataChannel);
  assert.equal(rows[1][2], 'With text');
  assert.equal(rows[1][8], '😀, "quote"\nnext line');
  assert.equal(JSON.parse(rows[1][rows[0].indexOf('messageData')]).poll.question.text, 'Which?');
  assert.equal(requests[0].searchParams.get('before'), toSnowflake(before));
  assert.equal(requests[1].searchParams.get('before'), toSnowflake(before));
  assert.equal(requests[2].searchParams.get('before'), messageId);
  assert.equal(JSON.parse(dom.window.localStorage.getItem('del_discord_v1_queue')).length, 2);
  assert.ok(methods.every(method => method === 'GET'));
});

test('bundled ZIP export includes forwarded and thread-starter files with a complete manifest', async t => {
  const channelId = '345678901234567890';
  const starterId = '456789012345678901', forwardId = '456789012345678902';
  const starter = { id: 'starter-file', filename: 'starter.bin', url: 'https://cdn.discordapp.com/attachments/starter.bin' };
  const forwarded = { id: 'forward-file', filename: 'forwarded.bin', url: 'https://cdn.discordapp.com/attachments/forwarded.bin' };
  const messages = [
    { id: forwardId, type: 0, flags: 16384, attachments: [], message_reference: { type: 1, channel_id: '234567890123456789', message_id: '456789012345678900' },
      message_snapshots: [{ message: { type: 0, content: 'Forwarded files', attachments: [forwarded, starter] } }] },
    { id: starterId, type: 21, attachments: [], referenced_message: { id: '456789012345678899', type: 0, attachments: [starter] } },
  ];
  const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/@me/${channelId}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, downloads = [], attachmentRequests = [];
  dom.window.Blob = Blob; dom.window.TextEncoder = TextEncoder;
  dom.window.setTimeout = callback => { callback(); return 0; };
  dom.window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  dom.window.fetch = async (url, options) => {
    assert.equal(options.method || 'GET', 'GET');
    if (url.startsWith('https://cdn.discordapp.com/')) {
      attachmentRequests.push(url);
      assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined);
      return new Response(Uint8Array.of(url === starter.url ? 1 : 2, 0, 255));
    }
    if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
    assert.equal(new URL(url).pathname, `/api/v10/channels/${channelId}/messages`);
    return Response.json(new URL(url).searchParams.has('before') ? [] : messages);
  };
  vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  doc.querySelector('#dmd-token').value = 'nested-export';
  const task = doc.querySelector('#dmd-export-conversation').onclick();
  const popup = doc.querySelector('.dmd-confirm-box'); assert.ok(popup);
  popup.querySelector('#dmd-export-attachments').click();
  popup.querySelector('.dmd-confirm-actions button:last-child').click();
  await task;
  assert.deepEqual(attachmentRequests, [starter.url, forwarded.url]);
  assert.equal(downloads.length, 1);
  const bytes = new Uint8Array(await downloads[0].arrayBuffer()), view = new DataView(bytes.buffer);
  const entries = new Map(), decoder = new TextDecoder();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true);
    const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + length)), start = offset + 30 + length;
    entries.set(name, bytes.slice(start, start + size)); offset = start + size;
  }
  const manifest = JSON.parse(decoder.decode(entries.get('attachments.json')));
  assert.equal(manifest.length, 3); assert.equal(entries.size, 4);
  assert.deepEqual(manifest.map(item => item.status), ['downloaded', 'downloaded', 'reused']);
  for (const item of manifest) {
    assert.equal(item.channelId, channelId);
    assert.deepEqual(entries.get(item.path), Uint8Array.of(item.attachmentId === starter.id ? 1 : 2, 0, 255));
  }
  assert.deepEqual(manifest.map(item => item.messageId), [starterId, forwardId, forwardId]);
  const saved = JSON.parse(decoder.decode([...entries].find(([name]) => name !== 'attachments.json' && name.endsWith('.json'))[1]));
  assert.equal(saved.messageCount, 2);
  assert.deepEqual(saved.messages.map(item => item.raw), [...messages].reverse());
  assert.match(doc.querySelector('#dmd-log').textContent, /2 downloaded; 0 unavailable/);
});
