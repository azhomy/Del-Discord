import test from 'node:test';
import assert from 'node:assert/strict';
import { countJsonMessages } from '../src/features/history/count-json.js';
import { createHistoryView } from '../src/features/history/view.js';
import { merge, removeHistoryMatch } from '../src/features/history/model.js';
import { importPackage } from '../src/features/history/import-package.js';
import { loadHistory, saveHistory, loadState, saveState } from '../src/features/history/storage.js';

const streamed = (text, chunkSize = 1) => {
  const bytes = new TextEncoder().encode(text);
  return {
    stream: () => new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    } }),
    text: () => { throw new Error('Streaming counts must not load the complete file.'); }
  };
};

test('JSON counts stream arrays, message envelopes and singleton objects across UTF-8 and escape boundaries', async () => {
  const cases = [
    ['', 0], ['[]', 0], ['{}', 0], ['null', 0], ['1e30', 0], ['"messages"', 0],
    ['[{}, {"content":"😀, ] \\" quote","attachments":[{"a":1}]},null,true,false,-0.25e+9]', 6],
    ['{"other":[1,2,3],"messages":[{"content":"é"},{"messages":[1,2]}]}', 2],
    ['{"\\u006des\\u0073ages":[1,2,3]}', 3],
    ['{"messages":[1,2],"messages":[]}', 0],
    ['{"messages":[1,2],"messages":null}', 1],
    ['{"messages":null,"messages":[1,2]}', 2],
    ['{"id":"123456789012345678","content":"single message"}', 1]
  ];
  for (const [text, expected] of cases) {
    assert.equal(await countJsonMessages(streamed(text)), expected, text);
    assert.equal(await countJsonMessages({ text: async () => text }), expected, text);
  }
});

test('streamed counts reject truncated, malformed and invalid UTF-8 JSON without accepting partial records', async () => {
  const invalid = [' ', '[', '{', '[1,]', '{"a":}', '{"a" 1}', '{"a":1,}', '[1 2]', '[01]', '[-]', '[1.]', '[1e]', '[1e+]', '[+1]', '[tru]', '[truefalse]', '["unfinished]', '["bad\\x"]', '["bad\\u00zz"]', '["raw\nnewline"]', '[] garbage', '{}{}'];
  for (const text of invalid) {
    await assert.rejects(countJsonMessages(streamed(text)), SyntaxError, text);
    await assert.rejects(countJsonMessages({ text: async () => text }), SyntaxError, text);
  }
  await assert.rejects(countJsonMessages({ stream: () => new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(0x5b, 0x22, 0xff, 0x22, 0x5d)); controller.close(); } }) }), TypeError);
});

test('JSON counters agree with parsed message counts for varied nesting and chunk sizes', async () => {
  for (let n = 0; n < 25; n++) {
    const messages = Array.from({ length: n }, (_, index) => ({ id: String(index), text: `é😀 ${'"\\\n'.repeat(index)}`, nested: [null, { messages: [1, 2], flags: [true, false] }], value: index / 3 }));
    for (const data of [messages, { messages, ignored: messages }, { message: messages }, { messages: null }]) {
      const text = JSON.stringify(data);
      const expected = Array.isArray(data) ? data.length : Array.isArray(data.messages) ? data.messages.length : Object.keys(data).length ? 1 : 0;
      assert.equal(await countJsonMessages(streamed(text, n + 1)), expected);
    }
  }
});

test('history pages and normalized searches reuse cached sorting and invalidate when entries change', () => {
  const history = {};
  merge(history, { userId: 'z', name: 'Zulu', verifiedSent: true, sentCount: 4 });
  merge(history, { userId: 'a', name: 'Alpha', verifiedSent: true, sentCount: 2 });
  merge(history, { userId: 'ranked', name: 'Bravo', dmRank: 0, verifiedSent: true, sentCount: 1 });
  merge(history, { userId: 'empty', name: 'Alpha', verifiedSent: true, sentCount: 0 });
  merge(history, { userId: 'unverified', name: 'Alpha', sentCount: 9 });
  const view = createHistoryView();
  const all = view(history);
  assert.deepEqual(all.map(item => item.userId), ['ranked', 'a', 'z']);
  assert.equal(view(history), all);
  const search = view(history, 'ALP');
  assert.equal(view(history, ' alp '), search);
  assert.deepEqual(search.map(item => item.userId), ['a']);
  merge(history, { userId: 'z', name: 'Alpine' });
  assert.deepEqual(view(history, 'alp').map(item => item.userId), ['a', 'z']);
  removeHistoryMatch(history, 'a');
  assert.deepEqual(view(history, 'alp').map(item => item.userId), ['z']);
  assert.deepEqual(view({}), []);
});

test('history identifier changes retire old lookups without removing the updated conversation', () => {
  const history = {};
  merge(history, { userId: 'person', channelId: 'old-channel', verifiedSent: true, sentCount: 4 });
  merge(history, { userId: 'person', channelId: 'current-channel' });
  removeHistoryMatch(history, '', 'old-channel');
  assert.equal(history['u:person'].channelId, 'current-channel');

  // A later channel-only import for the retired ID is a separate entry.
  merge(history, { channelId: 'old-channel', verifiedSent: true, sentCount: 2 });
  assert.deepEqual(Object.keys(history).sort(), ['c:old-channel', 'u:person']);
  assert.equal(history['u:person'].sentCount, 4);
  removeHistoryMatch(history, '', 'current-channel');
  assert.deepEqual(Object.keys(history), ['c:old-channel']);

  // Adding and replacing a recipient still moves both current lookups.
  merge(history, { userId: 'first-recipient', channelId: 'old-channel' });
  merge(history, { userId: 'second-recipient', channelId: 'old-channel' });
  removeHistoryMatch(history, 'first-recipient');
  assert.deepEqual(Object.keys(history), ['u:second-recipient']);
  removeHistoryMatch(history, '', 'old-channel');
  assert.deepEqual(history, {});
});

test('large chunks are decoded in bounded slices while retaining complete message counts', async t => {
  const json = JSON.stringify([{ content: 'é😀"\\'.repeat(100000) }, { id: '123456789012345678' }]);
  const lengths = [];
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, 'decode', function (bytes, options) {
    if (bytes) lengths.push(bytes.byteLength);
    return decode.call(this, bytes, options);
  });
  assert.equal(await countJsonMessages(new Blob([json])), 2);
  assert.equal(await countJsonMessages({ text: async () => json }), 2);
  assert.ok(lengths.length > 1);
  assert.ok(lengths.every(length => length <= 64 * 1024));
});

function storageFor(t) {
  const values = new Map(), writes = [];
  const frames = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push(key); values.set(key, value); } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement() {
      const frame = { style: {}, setAttribute() {}, contentWindow: { localStorage: storage } };
      frames.push(frame); return frame;
    },
    body: { appendChild(frame) { frame.isConnected = true; } }
  } });
  t.after(() => {
    for (const frame of frames) frame.isConnected = false;
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete globalThis.document;
  });
  return { writes };
}

test('history state writes skip identical renders and preserve changed page or search state', t => {
  const { writes } = storageFor(t);
  saveState({ page: 0, query: '', packageInfo: null });
  saveState({ page: 0, query: '', packageInfo: null });
  assert.equal(writes.length, 1);
  saveState({ page: 1, query: 'user', packageInfo: null });
  assert.equal(writes.length, 2);
  assert.deepEqual(loadState(), { page: 1, query: 'user', packageInfo: null });
});

test('package imports cache duplicate folder counts and retain saved evidence when message files are malformed', async t => {
  storageFor(t);
  const history = {};
  const person = '123456789012345678', channel = '234567890123456789';
  const badChannel = '345678901234567890';
  merge(history, { channelId: badChannel, sentCount: 7, verifiedSent: true });
  const elements = new Map();
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); };
  const channelFile = (id, name = 'channel.json') => ({ webkitRelativePath: `messages/c${id}/${name}`, text: async () => JSON.stringify({ id, type: 'DM', recipients: [person] }) });
  let reads = 0, info;
  const files = [
    channelFile(channel), channelFile(channel),
    { webkitRelativePath: `messages/c${channel}/messages.json`, text: async () => { reads++; return '[{},{}]'; } },
    channelFile(badChannel),
    { webkitRelativePath: `messages/c${badChannel}/messages.json`, text: async () => '[' }
  ];
  await importPackage(files, { $, getHistory: () => history, getIdentity: async () => null, setPackageInfo: value => { info = value; }, persist() {}, render() {} });
  assert.equal(reads, 1);
  assert.equal(history[`u:${person}`].sentCount, 2);
  assert.equal(history[`c:${badChannel}`].sentCount, 7);
  assert.equal(info.importedCount, 2);
  assert.equal($('#dmh-import').disabled, false);
});

test('clearing history during a package read prevents stale saves and skips later conversations', async t => {
  storageFor(t);
  let history = {}, release, completed = false, laterReads = 0;
  const elements = new Map();
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); };
  const files = [
    { webkitRelativePath: 'messages/c234567890123456789/channel.json', text: () => new Promise(resolve => { release = () => resolve('{"id":"234567890123456789","type":"DM"}'); }) },
    { webkitRelativePath: 'messages/c234567890123456789/messages.json', text: async () => { laterReads++; return '[{}]'; } },
    { webkitRelativePath: 'messages/c345678901234567890/channel.json', text: async () => { laterReads++; return '{"id":"345678901234567890","type":"DM"}'; } }
  ];
  const imported = importPackage(files, { $, getHistory: () => history, getIdentity: async () => null, setPackageInfo: () => { completed = true; }, persist: () => { completed = true; }, render: () => { completed = true; } });
  await Promise.resolve();
  assert.equal(typeof release, 'function');
  history = {}; saveHistory(history);
  release(); await imported;
  assert.equal(laterReads, 0);
  assert.equal(completed, false);
  assert.deepEqual(loadHistory(), {});
  assert.equal($('#dmh-import').disabled, false);
});
