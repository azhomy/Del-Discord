import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteMessages } from '../src/features/messages.js';
import { collectFreshMessages } from '../src/features/fresh-messages.js';
import { createMessageCollection } from '../src/features/message-collection.js';
import { normalizeCleanupOptions } from '../src/features/message-filters.js';
import { cleanupForumThread } from '../src/features/forum-threads.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const channelId = '123456789012345678', guildId = '234567890123456789';
const message = (id, extra = {}) => ({ id, channel_id: channelId, author: { id: 'self' }, type: 0, content: 'hello', attachments: [], pinned: false, ...extra });
const base = { token: 'test', authorId: 'self', guildId: '@me', channelId, freshHistory: true, collectAll: true, skipConfirm: true, log: () => {}, stopCheck: () => false };
function setup(t) {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  for (const [key, value] of [['document', { title: 'Test' }], ['location', { pathname: `/channels/@me/${channelId}` }]]) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
}

test('each run scans fresh history and finds new messages even when search stays empty', async t => {
  setup(t);
  const requests = [], writes = [], progress = [], logs = [];
  let latest;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (options.method === 'DELETE') { writes.push(url.split('/').at(-1)); return new Response(null, { status: 204 }); }
    if (url.includes('/search')) return Response.json({ messages: [], total_results: 0 });
    if (url.includes('/messages?')) return Response.json(latest && !new URL(url).searchParams.has('before') ? [latest] : []);
    return Response.json(latest);
  });
  const options = { ...base, progress: (...values) => progress.push(values), log: (_type, text) => logs.push(text) };
  assert.equal((await deleteMessages(options)).deleted, 0);
  assert.ok(logs.some(text => text.includes('No messages matched')));
  for (const id of ['200', '300']) {
    latest = message(id);
    assert.equal((await deleteMessages(options)).deleted, 1);
  }
  assert.deepEqual(writes, ['200', '300']);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/search')).length, 3);
  assert.equal(requests.filter(request => request.url.pathname.endsWith('/messages') && !request.url.searchParams.has('before')).length, 3);
  assert.ok(requests.filter(request => request.url.pathname.endsWith('/messages') || request.url.pathname.endsWith('/search')).every(request => request.options.cache === 'no-store'));
  assert.equal(progress.filter(([done]) => done === 0).length, 3);
  assert.equal(options.minId, undefined);
  assert.equal(options.maxId, undefined);
});

test('fresh scan merges above indexed messages, preserves filters and oldest-first order without duplicate deletes', async t => {
  setup(t);
  const writes = [], searches = [];
  const messages = [message('400', { author: { id: 'other' } }), message('300', { pinned: true }), message('200'), message('100')];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method) { writes.push(url.split('/').at(-1)); return new Response(null, { status: 204 }); }
    if (url.includes('/search')) {
      searches.push(new URL(url));
      return Response.json({ messages: searches.length === 1 ? [[{ ...message('100'), hit: true }]] : [] });
    }
    if (url.includes('/messages?')) return Response.json(messages);
    return Response.json(messages.find(item => item.id === url.split('/').at(-1)));
  });
  const result = await deleteMessages({ ...base, order: 'asc', minId: '50', maxId: '500' });
  assert.equal(result.deleted, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(writes, ['100', '200']);
  assert.equal(searches[0].searchParams.get('min_id'), '50');
  assert.equal(searches[1].searchParams.get('min_id'), '100');
});

test('server cleanup checks fresh text channel history and respects NSFW selection', async t => {
  setup(t);
  const threadId = '567890123456789012';
  const calls = [], writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    if (options.method) { writes.push(url); return new Response(null, { status: 204 }); }
    if (url.includes('/search')) return Response.json({ messages: [] });
    if (url.endsWith('/threads/active')) return Response.json({ threads: [{ id: threadId, parent_id: channelId, type: 11, guild_id: guildId }] });
    if (url.endsWith('/channels')) return Response.json([{ id: channelId, type: 0, guild_id: guildId }, { id: '345678901234567890', type: 0, nsfw: true }, { id: '456789012345678901', type: 2 }, { id: '678901234567890123', type: 0 }]);
    if (url.includes('678901234567890123')) return new Response(null, { status: 403 });
    if (url.includes('/messages?')) return Response.json(new URL(url).searchParams.has('before') ? [] : [message(url.includes(threadId) ? '300' : '200', { channel_id: url.includes(threadId) ? threadId : channelId })]);
    return Response.json(message(url.includes(threadId) ? '300' : '200', { channel_id: url.includes(threadId) ? threadId : channelId }));
  });
  assert.equal((await deleteMessages({ ...base, guildId, channelId: undefined })).deleted, 2);
  assert.equal(writes.length, 2);
  assert.ok(!calls.some(url => url.includes('345678901234567890') || url.includes('456789012345678901')));
});

test('indexed thread fallback preserves its discovered parent NSFW restriction', async t => {
  setup(t);
  const threadId = '567890123456789012';
  for (const nsfw of [true, false]) {
    for (const includeNsfw of [false, true]) {
      const histories = [], collected = createMessageCollection('desc');
      t.mock.method(globalThis, 'fetch', async url => {
        if (url.endsWith('/channels')) return Response.json([{ id: channelId, guild_id: guildId, type: 0, nsfw }]);
        if (url.endsWith('/threads/active')) return Response.json({ threads: [{ id: threadId, parent_id: channelId, guild_id: guildId, type: 11 }] });
        histories.push(url);
        return Response.json(url.includes(threadId) ? [message('300', { channel_id: threadId }), message('100', { channel_id: threadId })] : []);
      });
      await collectFreshMessages(normalizeCleanupOptions({ ...base, guildId, channelId: undefined, includeNsfw }),
        new Map([[threadId, '100']]), collected, { skipped: 0 });
      const allowed = !nsfw || includeNsfw;
      assert.equal(histories.filter(url => url.includes(threadId)).length, allowed ? 1 : 0, `parent NSFW=${nsfw}, Include NSFW=${includeNsfw}`);
      assert.deepEqual(collected.finish().map(item => item.id), allowed ? ['300'] : []);
    }
  }
});

test('indexed thread fallback preserves known guild and thread-type exclusions', async t => {
  setup(t);
  const threadId = '567890123456789012';
  for (const extra of [{ guild_id: '678901234567890123' }, { type: 0 }]) {
    const histories = [], collected = createMessageCollection('desc');
    t.mock.method(globalThis, 'fetch', async url => {
      if (url.endsWith('/channels')) return Response.json([{ id: channelId, guild_id: guildId, type: 0 }]);
      if (url.endsWith('/threads/active')) return Response.json({ threads: [{ id: threadId, parent_id: channelId, guild_id: guildId, type: 11, ...extra }] });
      histories.push(url);
      return Response.json(url.includes(threadId) ? [message('300', { channel_id: threadId }), message('100', { channel_id: threadId })] : []);
    });
    await collectFreshMessages(normalizeCleanupOptions({ ...base, guildId, channelId: undefined, includeNsfw: true }),
      new Map([[threadId, '100']]), collected, { skipped: 0 });
    assert.equal(histories.some(url => url.includes(threadId)), false);
    assert.deepEqual(collected.finish(), []);
  }
});

test('direct and selected forum cleanup honor the parent NSFW setting before reading messages', async t => {
  setup(t);
  const parentId = '345678901234567890';
  for (const type of [0, 15]) for (const nsfw of [false, true]) for (const includeNsfw of [false, true]) {
    let histories = 0, writes = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method === 'DELETE') { writes++; return new Response(null, { status: 204 }); }
      if (url.endsWith(`/channels/${channelId}`)) return Response.json({ id: channelId, type: 11, guild_id: guildId, parent_id: parentId });
      if (url.endsWith(`/channels/${parentId}`)) return Response.json({ id: parentId, type, guild_id: guildId, nsfw });
      if (url.includes('/messages?')) { histories++; return Response.json(histories === 1 ? [message('200')] : []); }
      return Response.json(message('200'));
    });
    const result = await cleanupForumThread({ ...base, guildId, includeNsfw, allowAnyThread: type === 0 });
    const allowed = !nsfw || includeNsfw;
    assert.equal(result.done, true);
    assert.equal(histories, allowed ? 2 : 0);
    assert.equal(writes, allowed ? 1 : 0);
  }
});

test('archived indexed threads resolve inherited NSFW metadata before fresh history reads', async t => {
  setup(t);
  const threadId = '567890123456789012';
  for (const discoveredParent of [false, true]) for (const nsfw of [false, true]) for (const includeNsfw of [false, true]) {
    const histories = [], metadata = [], collected = createMessageCollection('desc');
    const parent = { id: channelId, guild_id: guildId, type: 15, nsfw };
    t.mock.method(globalThis, 'fetch', async url => {
      if (url.endsWith('/channels')) return discoveredParent ? Response.json([parent]) : new Response(null, { status: 403 });
      if (url.endsWith('/threads/active')) return Response.json({ threads: [] });
      if (url.endsWith(`/channels/${threadId}`)) { metadata.push(threadId); return Response.json({ id: threadId, guild_id: guildId, parent_id: channelId, type: 11, thread_metadata: { archived: true } }); }
      if (url.endsWith(`/channels/${channelId}`)) { metadata.push(channelId); return Response.json(parent); }
      histories.push(url);
      return Response.json([message('300', { channel_id: threadId }), message('100', { channel_id: threadId })]);
    });
    await collectFreshMessages(normalizeCleanupOptions({ ...base, guildId, channelId: undefined, includeNsfw }),
      new Map([[threadId, '100']]), collected, { skipped: 0 });
    const allowed = !nsfw || includeNsfw;
    assert.deepEqual(metadata, discoveredParent ? [threadId] : [threadId, channelId]);
    assert.equal(histories.length, allowed ? 1 : 0);
    assert.deepEqual(collected.finish().map(item => item.id), allowed ? ['300'] : []);
  }
});

test('unknown indexed metadata cannot broaden the guild or bypass denied scope checks', async t => {
  setup(t);
  const threadId = '567890123456789012';
  for (const mode of ['channel-denied', 'parent-denied', 'wrong-id', 'wrong-guild', 'wrong-type', 'wrong-parent-guild']) {
    let histories = 0;
    const logs = [];
    t.mock.method(globalThis, 'fetch', async url => {
      if (url.endsWith('/channels')) return Response.json([]);
      if (url.endsWith('/threads/active')) return Response.json({ threads: [] });
      if (url.endsWith(`/channels/${threadId}`)) return mode === 'channel-denied' ? new Response(null, { status: 403 }) : Response.json({
        id: mode === 'wrong-id' ? channelId : threadId, guild_id: mode === 'wrong-guild' ? '678901234567890123' : guildId,
        parent_id: channelId, type: mode === 'wrong-type' ? 2 : 11,
      });
      if (url.endsWith(`/channels/${channelId}`)) return mode === 'parent-denied' ? new Response(null, { status: 403 }) : Response.json({ id: channelId, guild_id: mode === 'wrong-parent-guild' ? '678901234567890123' : guildId, type: 15 });
      histories++; return Response.json([]);
    });
    const run = collectFreshMessages(normalizeCleanupOptions({ ...base, guildId, channelId: undefined, log: (_type, text) => logs.push(text) }),
      new Map([[threadId, '100']]), createMessageCollection('desc'), { skipped: 0 });
    if (mode.endsWith('denied')) { await run; assert.ok(logs.some(text => text.includes('metadata (403)'))); }
    else await assert.rejects(run, /invalid|outside|unsupported/i);
    assert.equal(histories, 0);
  }
});

test('bundled direct thread cleanup requires Include NSFW before reading or previewing its messages', async t => {
  const parentId = '345678901234567890';
  for (const includeNsfw of [false, true]) {
    const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/${guildId}/${channelId}`, runScripts: 'outside-only', pretendToBeVisual: true });
    t.after(() => dom.window.close());
    dom.window.setTimeout = callback => { callback(); return 0; };
    let histories = 0, writes = 0;
    const target = message('200', { content: 'Message in an NSFW parent' });
    dom.window.fetch = async (url, options) => {
      if (options?.method === 'DELETE') { writes++; return new Response(null, { status: 204 }); }
      if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
      if (url.endsWith(`/channels/${channelId}`)) return Response.json({ id: channelId, type: 11, guild_id: guildId, parent_id: parentId });
      if (url.endsWith(`/channels/${parentId}`)) return Response.json({ id: parentId, type: 0, guild_id: guildId, nsfw: true });
      if (url.includes('/messages?')) { histories++; return Response.json(histories === 1 ? [target] : []); }
      if (url.endsWith('/messages/200')) return Response.json(target);
      return Response.json([]);
    };
    vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
    const doc = dom.window.document;
    doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    doc.querySelector('#dmd-token').value = 'test';
    doc.querySelector('#dmd-nsfw').checked = includeNsfw;
    const run = doc.querySelector('#dmd-start').onclick();
    if (includeNsfw) {
      for (let count = 0; count < 300 && !doc.querySelector('.dmd-confirm-box'); count++) await Promise.resolve();
      const preview = doc.querySelector('.dmd-confirm-box');
      assert.ok(preview);
      assert.match(preview.textContent, /Message in an NSFW parent/);
      assert.equal(writes, 0);
      preview.querySelector('.dmd-red').click();
    }
    await run;
    assert.equal(histories, includeNsfw ? 2 : 0);
    assert.equal(writes, includeNsfw ? 1 : 0);
    if (!includeNsfw) {
      assert.equal(doc.querySelector('.dmd-confirm-box'), null);
      assert.match(doc.querySelector('#dmd-log').textContent, /parent is NSFW/);
    }
  }
});

test('rebuilt userscript scans again after an empty run and previews an unindexed new message', async t => {
  const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/@me/${channelId}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  dom.window.setTimeout = callback => { callback(); return 0; };
  let latest, searches = 0, historyStarts = 0;
  const writes = [];
  dom.window.fetch = async (url, options) => {
    if (options?.method === 'DELETE') { writes.push(url); return new Response(null, { status: 204 }); }
    if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
    if (url.endsWith(`/channels/${channelId}`)) return Response.json({ id: channelId, type: 1 });
    if (url.includes('/search')) { searches++; return Response.json({ messages: [], total_results: 0 }); }
    if (url.includes('/messages?')) {
      const firstPage = !new URL(url).searchParams.has('before');
      if (firstPage) historyStarts++;
      return Response.json(latest && firstPage ? [latest] : []);
    }
    return Response.json(latest);
  };
  vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
  const doc = dom.window.document;
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  doc.querySelector('#dmd-token').value = 'test';
  await doc.querySelector('#dmd-start').onclick();
  assert.match(doc.querySelector('#dmd-log').textContent, /No messages matched/);
  latest = message('200', { content: 'new message since loading the script' });
  const run = doc.querySelector('#dmd-start').onclick();
  for (let count = 0; count < 200 && !doc.querySelector('.dmd-confirm-box'); count++) await Promise.resolve();
  const popup = doc.querySelector('.dmd-confirm-box');
  assert.ok(popup);
  assert.match(popup.textContent, /new message since loading the script/);
  assert.equal(writes.length, 0);
  popup.querySelector('.dmd-red').click();
  await run;
  assert.equal(searches, 2);
  assert.equal(historyStarts, 2);
  assert.equal(writes.length, 1);
});

test('fresh scan failure or stop prevents changes to collected search matches', async t => {
  setup(t);
  for (const mode of ['failure', 'stop', 'malformed', 'stalled']) {
    let searches = 0, stopped = false, writes = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method) writes++;
      if (url.includes('/search')) return Response.json({ messages: searches++ ? [] : [[{ ...message('100'), hit: true }]] });
      if (mode === 'stop') stopped = true;
      if (mode === 'failure') return new Response(null, { status: 403 });
      if (mode === 'malformed') return Response.json({ messages: [] });
      return Response.json([message('200')]);
    });
    const run = deleteMessages({ ...base, stopCheck: () => stopped });
    if (mode === 'stop') assert.equal((await run).stopped, true);
    else await assert.rejects(run, /Fresh message scan failed|invalid message history|did not advance/);
    assert.equal(writes, 0);
  }
});

test('fresh channel history respects NSFW filtering and rejects a mismatched server', async t => {
  setup(t);
  let actualGuild = guildId, historyReads = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/search')) return Response.json({ messages: [] });
    if (url.endsWith(`/channels/${channelId}`)) return Response.json({ id: channelId, guild_id: actualGuild, type: 0, nsfw: true });
    historyReads++;
    return Response.json([]);
  });
  assert.equal((await deleteMessages({ ...base, guildId })).deleted, 0);
  assert.equal(historyReads, 0);
  await deleteMessages({ ...base, guildId, includeNsfw: true });
  assert.equal(historyReads, 1);
  actualGuild = '345678901234567890';
  await assert.rejects(deleteMessages({ ...base, guildId, includeNsfw: true }), /outside the selected server/);
  assert.equal(historyReads, 1);
});

test('forbidden server discovery preserves indexed matches and scans their channels for newer messages', async t => {
  setup(t);
  const second = '345678901234567890';
  for (const denied of ['threads', 'channels', 'both']) {
    const writes = [], logs = [], histories = [];
    let pages = 0;
    const indexed = Array.from({ length: 13 }, (_value, index) => message(String(200 + index), { channel_id: second }));
    const fresh = message('300', { channel_id: second });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method === 'DELETE') { writes.push(url.split('/').at(-1)); return new Response(null, { status: 204 }); }
      if (url.includes('/search')) return Response.json({ messages: pages++ ? [] : indexed.map(item => [{ ...item, hit: true }]) });
      if (url.endsWith('/channels')) return denied !== 'threads' ? new Response(null, { status: 403 }) : Response.json([{ id: second, type: 0, guild_id: guildId }]);
      if (url.endsWith('/threads/active')) return denied !== 'channels' ? new Response(null, { status: 403 }) : Response.json({ threads: [] });
      if (url.endsWith(`/channels/${second}`)) return Response.json({ id: second, type: 0, guild_id: guildId });
      if (url.includes('/messages?')) { histories.push(url); return Response.json([fresh, indexed.at(-1)]); }
      return Response.json([fresh, ...indexed].find(item => item.id === url.split('/').at(-1)));
    });
    const result = await deleteMessages({ ...base, guildId, channelId: undefined, log: (type, text) => logs.push({ type, text }) });
    assert.equal(result.done, true);
    assert.equal(result.deleted, 14);
    assert.equal(new Set(writes).size, 14);
    assert.equal(histories.length, 1);
    assert.ok(histories[0].includes(second));
    assert.ok(logs.some(entry => entry.type === 'warn' && entry.text.includes('discovery (403)')));
  }
});

test('server discovery authentication and malformed response errors still prevent all changes', async t => {
  setup(t);
  for (const mode of ['unauthorized', 'invalid', 'unavailable']) {
    let searches = 0, writes = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method) writes++;
      if (url.includes('/search')) return Response.json({ messages: searches++ ? [] : [[{ ...message('200'), hit: true }]] });
      if (url.endsWith('/channels')) return Response.json([{ id: channelId, type: 0, guild_id: guildId }]);
      return mode === 'invalid' ? Response.json({}) : new Response(null, { status: mode === 'unauthorized' ? 401 : 503 });
    });
    await assert.rejects(deleteMessages({ ...base, guildId, channelId: undefined }), /Fresh message scan failed|invalid active thread list/);
    assert.equal(writes, 0);
  }
});

test('bundled Server and Queue cleanup continues after channel deletion when discovery returns 403', async t => {
  for (const mode of ['server', 'queue']) {
    for (const denied of ['threads', 'channels']) {
      const second = '345678901234567890';
      const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/${guildId}/${channelId}`, runScripts: 'outside-only', pretendToBeVisual: true });
      t.after(() => dom.window.close());
      dom.window.setTimeout = callback => { callback(); return 0; };
      dom.window.localStorage.setItem('del_discord_v1_queue', JSON.stringify([{ kind: 'server', guildId, channelId: `server:${guildId}`, label: 'Server' }]));
      const first = message('100');
      const remaining = Array.from({ length: 13 }, (_value, index) => message(String(200 + index), { channel_id: second }));
      const writes = [];
      dom.window.fetch = async (url, options) => {
        if (options?.method === 'DELETE') { writes.push(url.split('/').at(-1)); return new Response(null, { status: 204 }); }
        if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
        if (url.endsWith(`/channels/${channelId}`)) return Response.json({ id: channelId, type: 0, guild_id: guildId });
        if (url.endsWith(`/channels/${second}`)) return Response.json({ id: second, type: 0, guild_id: guildId });
        if (url.includes('/search')) {
          const params = new URL(url).searchParams;
          const matches = params.has('max_id') ? [] : params.has('channel_id') ? [first] : remaining;
          return Response.json({ messages: matches.map(item => [{ ...item, hit: true }]), total_results: matches.length });
        }
        if (url.endsWith('/channels')) return denied === 'channels' ? new Response(null, { status: 403 }) : Response.json([{ id: channelId, type: 0, guild_id: guildId }, { id: second, type: 0, guild_id: guildId }]);
        if (url.endsWith('/threads/active')) return denied === 'threads' ? new Response(null, { status: 403 }) : Response.json({ threads: [] });
        if (url.includes('/messages?')) return Response.json([]);
        return Response.json([first, ...remaining].find(item => item.id === url.split('/').at(-1)));
      };
      vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
      const doc = dom.window.document;
      doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
      doc.querySelector('#dmd-token').value = 'test';
      const approve = async run => {
        for (let count = 0; count < 300 && !doc.querySelector('.dmd-confirm-box'); count++) await Promise.resolve();
        assert.ok(doc.querySelector('.dmd-confirm-box'));
        doc.querySelector('.dmd-confirm-box .dmd-red').click();
        await run;
      };
      await approve(doc.querySelector('#dmd-start').onclick());
      assert.deepEqual(writes, ['100']);
      if (mode === 'server') {
        doc.querySelector('#dmd-message-modes [data-mode="server"]').click();
        await approve(doc.querySelector('#dmd-start').onclick());
      } else {
        doc.querySelector('[data-view="multi"]').click();
        await doc.querySelector('#dmd-multi-start').onclick();
        assert.equal(doc.querySelector('#dmd-multi-count').textContent, '0 queued');
      }
      assert.equal(writes.length, 14);
      assert.equal(new Set(writes).size, 14);
      assert.match(doc.querySelector('#dmd-log').textContent, /discovery \(403\)/);
      assert.doesNotMatch(doc.querySelector('#dmd-log').textContent, /Fresh message scan failed/);
    }
  }
});
