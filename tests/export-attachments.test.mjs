import test from 'node:test';
import assert from 'node:assert/strict';
import { collectExportAttachments, createAttachmentDownloadState } from '../src/features/export-attachments.js';
import { createZipBudget, filesToZip, ZipCapacityError } from '../src/utils/zip.js';
import { RunStoppedError } from '../src/discord/api.js';

const conversation = { channelId: 'channel', messages: [{ id: 'message', raw: { attachments: [
  { id: '1', filename: '../photo.png', url: 'https://cdn.discordapp.com/attachments/a' },
  { id: '2', filename: '../photo.png', url: 'https://cdn.discordapp.com/attachments/b' },
  { id: '3', filename: 'expired.png', url: 'https://cdn.discordapp.com/attachments/expired' },
] } }] };

test('attachment downloads preserve binary files, isolate credentials and report failures without losing other files', async t => {
  const calls = [], files = [], report = [], logs = [];
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('expired') ? new Response('', { status: 404 }) : new Response(bytes);
  });
  await collectExportAttachments(conversation, { files, report, log: (...args) => logs.push(args) });
  assert.equal(files.length, 2); assert.notEqual(files[0].name, files[1].name);
  assert.ok(files.every(file => !file.name.split('/').includes('..')));
  assert.deepEqual(new Uint8Array(await files[0].blob.arrayBuffer()), bytes);
  assert.deepEqual(report.map(item => item.status), ['downloaded', 'downloaded', 'failed']);
  assert.equal(report[2].path, null); assert.match(report[2].error, /404/);
  assert.ok(logs.some(([level]) => level === 'warn'));
  assert.ok(calls.every(({ options }) => !options.headers && options.credentials === 'omit'));
});

test('stopping during an attachment response prevents saving it and requesting subsequent attachments', async t => {
  let stopped = false, calls = 0;
  const files = [], report = [];
  t.mock.method(globalThis, 'fetch', async () => { calls++; stopped = true; return new Response('data'); });
  await assert.rejects(collectExportAttachments(conversation, { files, report, log: () => {}, stopCheck: () => stopped }), RunStoppedError);
  assert.equal(calls, 1); assert.equal(files.length, 0); assert.equal(report.length, 0);
});

const attachment = (id, extra = {}) => ({ id, filename: 'photo.png', url: `https://cdn.discordapp.com/attachments/${id}`, ...extra });

test('forwarded attachments get distinct paths and report sources while reusing downloaded files', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const requests = [], files = [], report = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return new Response(url); });
  const data = { channelId: 'channel', messages: [{ id: 'message', raw: {
    attachments: [attachment('top')],
    message_snapshots: [
      { message: { attachments: [attachment('snapshot-a'), attachment('top', { url: 'https://cdn.discordapp.com/attachments/top?hm=fresh' })] } },
      { message: { attachments: [attachment('snapshot-b')] } },
    ],
  } }] };
  await collectExportAttachments(data, { files, report, budget: createZipBudget(), log: () => {} });
  assert.equal(requests.length, 3);
  assert.deepEqual(files.map(file => file.name), [
    'attachments/channel/message/1-photo.png',
    'attachments/channel/message/snapshots/1/1-photo.png',
    'attachments/channel/message/snapshots/2/1-photo.png',
  ]);
  assert.deepEqual(report.map(item => item.source), [
    'attachments', 'message_snapshots[0].message.attachments', 'message_snapshots[0].message.attachments', 'message_snapshots[1].message.attachments',
  ]);
  assert.deepEqual(report.map(item => item.status), ['downloaded', 'downloaded', 'reused', 'downloaded']);
  assert.equal(report[2].path, report[0].path);
  assert.equal(await files[1].blob.text(), attachment('snapshot-a').url);
});

test('thread starter attachments are downloaded without expanding ordinary reply references', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const requests = [], files = [], report = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return new Response('starter'); });
  const data = { channelId: 'thread', messages: [
    { id: 'starter', raw: { type: 21, attachments: [], referenced_message: { attachments: [attachment('starter-file')] } } },
    { id: 'reply', raw: { type: 19, attachments: [], referenced_message: { attachments: [attachment('out-of-range')] } } },
  ] };
  await collectExportAttachments(data, { files, report, log: () => {} });
  assert.deepEqual(requests, [attachment('starter-file').url]);
  assert.equal(files[0].name, 'attachments/thread/starter/referenced-message/1-photo.png');
  assert.equal(report[0].source, 'referenced_message.attachments');
  assert.equal(report[0].messageId, 'starter');
});

test('thread starters preserve forwarded files from their referenced parent without following its replies', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const requests = [], files = [], report = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return new Response('forward'); });
  const data = { channelId: 'thread', messages: [{ id: 'starter', raw: {
    type: 21, attachments: [], referenced_message: {
      type: 0, attachments: [], message_snapshots: [{ message: { attachments: [attachment('parent-forward')] } }],
      referenced_message: { attachments: [attachment('unrelated-reply')] },
    },
  } }] };
  await collectExportAttachments(data, { files, report, log: () => {} });
  assert.deepEqual(requests, [attachment('parent-forward').url]);
  assert.equal(files[0].name, 'attachments/thread/starter/referenced-message/snapshots/1/1-photo.png');
  assert.equal(report[0].source, 'referenced_message.message_snapshots[0].message.attachments');
});

test('forwarded attachments retain capacity checks and cancellation before saving files', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  let requests = 0, stopped = false;
  t.mock.method(globalThis, 'fetch', async () => { requests++; stopped = true; return new Response('file'); });
  const files = [], report = [], file = attachment('snapshot', { size: 0xffffffff });
  const data = { channelId: 'channel', messages: [{ id: 'message', raw: {
    attachments: [], message_snapshots: [{ message: { attachments: [file, attachment('next')] } }],
  } }] };
  const context = { files, report, budget: createZipBudget(), log: () => {}, stopCheck: () => stopped };
  await assert.rejects(collectExportAttachments(data, context), ZipCapacityError);
  assert.equal(requests, 0);
  file.size = 4;
  await assert.rejects(collectExportAttachments(data, context), RunStoppedError);
  assert.equal(requests, 1); assert.equal(files.length, 0); assert.equal(report.length, 0);
});

test('stored ZIP preserves Unicode paths, binary payloads, checksums and central-directory offsets', async () => {
  const payloads = [new Blob(['123456789']), new Blob([new Uint8Array([0, 255, 128])]), new Blob([])];
  const files = ['messages.json', 'attachments/😀.png', 'empty'].map((name, index) => ({ name, blob: payloads[index] }));
  const zip = await filesToZip(files), bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer), decoder = new TextDecoder();
  assert.equal(zip.type, 'application/zip');
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), 3);
  let central = view.getUint32(end + 16, true);
  for (const [index, file] of files.entries()) {
    assert.equal(view.getUint32(central, true), 0x02014b50);
    const offset = view.getUint32(central + 42, true), length = view.getUint16(central + 28, true);
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(decoder.decode(bytes.slice(central + 46, central + 46 + length)), file.name);
    assert.equal(view.getUint16(offset + 6, true), 0x800);
    assert.equal(view.getUint32(offset + 18, true), file.blob.size);
    assert.deepEqual(bytes.slice(offset + 30 + length, offset + 30 + length + file.blob.size), new Uint8Array(await file.blob.arrayBuffer()));
    if (index === 0) assert.equal(view.getUint32(offset + 14, true), 0xcbf43926);
    assert.equal(view.getUint32(central + 16, true), view.getUint32(offset + 14, true));
    central += 46 + length;
  }
  assert.equal(central, end);
  await assert.rejects(filesToZip(files, () => true), RunStoppedError);
  await assert.rejects(filesToZip([{ name: 'large', blob: { size: 0xffffffff } }]), /4 GB/);
});

test('ZIP validation yields and can stop before reading file payloads', async t => {
  let clock = 0, stopped = false, turns = 0, reads = 0;
  t.mock.method(performance, 'now', () => clock += 10);
  t.mock.method(globalThis, 'setTimeout', callback => { turns++; stopped = true; callback(); return 0; });
  const blob = { size: 1, slice: () => { reads++; throw new Error('Payload should not be read'); } };
  await assert.rejects(filesToZip([{ name: 'a', blob }, { name: 'b', blob }], () => stopped), RunStoppedError);
  assert.equal(turns, 1); assert.equal(reads, 0);
});

test('empty ZIP entries yield and remain cancellable after validation', async t => {
  const files = ['a', 'b', 'c'].map(name => ({ name, blob: new Blob([]) }));
  let clockReads = 0, stopped = false, turns = 0;
  // Validation takes less than one frame; entry creation consumes the budget.
  t.mock.method(performance, 'now', () => ++clockReads <= files.length + 1 ? 0 : 10);
  t.mock.method(globalThis, 'setTimeout', callback => { turns++; stopped = true; callback(); return 0; });
  await assert.rejects(filesToZip(files, () => stopped), RunStoppedError);
  assert.equal(turns, 1);
});

for (const status of ['reused', 'skipped']) test(`${status} attachments yield and stop without making network requests`, async t => {
  let clockReads = 0, stopped = false, turns = 0, requests = 0;
  t.mock.method(performance, 'now', () => ++clockReads <= 3 ? 0 : 10);
  t.mock.method(globalThis, 'setTimeout', callback => { turns++; stopped = true; callback(); return 0; });
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('No download expected'); });
  const state = createAttachmentDownloadState(), files = [], report = [];
  if (status === 'skipped') state.suspendedReason = 'Attachment requests suspended.';
  else state.cache.set('https://cdn.discordapp.com/file', { status: 'downloaded', path: 'attachments/file', size: 1 });
  const data = { channelId: '1', messages: [{ id: '2', attachments: Array.from({ length: 3 }, () => ({
    filename: 'file.png', url: 'https://cdn.discordapp.com/file',
  })) }] };
  await assert.rejects(collectExportAttachments(data, { state, files, report, log: () => {}, stopCheck: () => stopped }), RunStoppedError);
  assert.equal(turns, 1); assert.equal(requests, 0); assert.equal(files.length, 0);
  assert.equal(report.length, 1); assert.equal(report[0].status, status);
});

test('ZIP checksums remain correct across bounded payload slices', async () => {
  const payload = Uint8Array.from({ length: 65536 * 2 + 7 }, (_, index) => index * 31 & 255);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const zip = await filesToZip([{ name: 'binary', blob: new Blob([payload]) }]);
  const view = new DataView(await zip.arrayBuffer());
  assert.equal(view.getUint32(14, true), (crc ^ 0xffffffff) >>> 0);
  assert.equal(view.getUint32(18, true), payload.length);
});
