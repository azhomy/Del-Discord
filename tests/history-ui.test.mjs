import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const { outputFiles } = await build({ entryPoints: ['src/ui/history.js'], bundle: true, format: 'iife', globalName: 'HistoryUI', write: false, loader: { '.html': 'text', '.css': 'text' } });
const self = '123456789012345678';
const userId = '234567890123456789';
const channel = '345678901234567890';
function mount(t, history) {
  const dom = new JSDOM('<div id="container"><div id="dmd-progress-dock"></div></div>', { url: 'https://discord.com', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.localStorage.setItem('del_discord_v1_history', JSON.stringify(history));
  dom.window.localStorage.setItem('token', JSON.stringify('token-for-history-test-at-least-20-chars'));
  dom.window.Headers = Headers;
  dom.window.fetch = async () => { throw new Error('Unexpected Discord request.'); };
  dom.window.setTimeout = callback => { callback(); return 0; };
  dom.window.eval(outputFiles[0].text);
  const ui = dom.window.HistoryUI.initHistory(dom.window.document.querySelector('#container'));
  return { dom, ui, $: selector => dom.window.document.querySelector(selector) };
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('cached names without custom avatars render and page without identity or user requests', async t => {
  const history = {};
  for (let i = 0; i < 25; i++) history[`u:${i}`] = { userId: String(i), channelId: String(i + 100), name: `Person ${String(i).padStart(2, '0')}`, username: `@person${i}`, avatar: '', verifiedSent: true, sentCount: 1 };
  const { dom, ui, $ } = mount(t, history);
  let requests = 0;
  dom.window.fetch = async () => { requests++; return Response.json({ id: self }); };
  ui.activate();
  $('#dmh-next').click();
  await settle();
  assert.equal(requests, 0);
  assert.equal($('#dmh-page').textContent, 'Page 2 of 3');
  assert.equal($('#dmh-list .dmh-name').textContent, 'Person 10');
  $('#dmh-search').value = 'PERSON 24';
  $('#dmh-search').dispatchEvent(new dom.window.Event('input'));
  assert.equal($('#dmh-page').textContent, 'Page 1 of 1');
  assert.equal($('#dmh-list .dmh-name').textContent, 'Person 24');
});

test('missing users do not repeat failed name requests on every activation', async t => {
  const { dom, ui } = mount(t, { [`u:${userId}`]: { userId, channelId: channel, verifiedSent: true, sentCount: 3 } });
  const requests = [];
  dom.window.fetch = async url => {
    requests.push(url);
    return url.endsWith('/users/@me') ? Response.json({ id: self }) : new Response(null, { status: 404 });
  };
  ui.activate(); await settle();
  ui.activate(); await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(url => url.endsWith(`/users/${userId}`)).length, 1);
});

test('a page change during a name request resolves the newly visible page', async t => {
  const history = {};
  for (let i = 0; i < 11; i++) history[`u:${i}`] = { userId: String(i), channelId: String(i + 100), dmRank: i, name: i === 0 || i === 10 ? '' : `Person ${i}`, username: i === 0 || i === 10 ? '' : `@person${i}`, verifiedSent: true, sentCount: 1 };
  const { dom, ui, $ } = mount(t, history);
  let release;
  const requests = [];
  dom.window.fetch = async url => {
    requests.push(url);
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    if (url.endsWith('/users/0')) return new Promise(resolve => { release = () => resolve(Response.json({ id: '0', username: 'zero' })); });
    return Response.json({ id: '10', username: 'ten' });
  };
  ui.activate(); await settle();
  assert.equal(typeof release, 'function');
  $('#dmh-next').click();
  release(); await settle();
  assert.equal($('#dmh-list .dmh-name').textContent, 'ten');
  assert.equal(requests.filter(url => url.endsWith('/users/10')).length, 1);
});

test('partial user profiles retain their retry delay when merging replaces the history entry', async t => {
  const { dom, ui, $ } = mount(t, { [`u:${userId}`]: { userId, channelId: channel, verifiedSent: true, sentCount: 3 } });
  const requests = [];
  dom.window.fetch = async url => {
    requests.push(url);
    return url.endsWith('/users/@me') ? Response.json({ id: self }) : Response.json({ id: userId, global_name: 'Partial profile' });
  };
  ui.activate(); await settle();
  assert.equal($('#dmh-list .dmh-name').textContent, 'Partial profile');
  ui.activate(); await settle();
  assert.equal(requests.length, 2);
});

test('clearing history during name resolution cannot restore the cleared entries', async t => {
  const { dom, ui, $ } = mount(t, { [`u:${userId}`]: { userId, channelId: channel, verifiedSent: true, sentCount: 3 } });
  let release;
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    return new Promise(resolve => { release = () => resolve(Response.json({ id: userId, username: 'late result' })); });
  };
  ui.activate(); await settle();
  assert.equal(typeof release, 'function');
  $('#dmh-clear').click();
  $('.dmd-confirm-actions .dmd-red').click(); await settle();
  release(); await settle();
  assert.equal($('#dmh-list').querySelectorAll('.dmh-row').length, 0);
  assert.equal(dom.window.localStorage.getItem('del_discord_v1_history'), '{}');
});

test('clearing history during verification discards the arriving result and remaining requests', async t => {
  const { dom, $ } = mount(t, {});
  let release;
  const requests = [];
  dom.window.fetch = async url => {
    requests.push(url);
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    if (url.endsWith('/users/@me/channels')) return Response.json([
      { id: channel, type: 1, recipients: [{ id: userId, username: 'First' }] },
      { id: '456789012345678901', type: 1, recipients: [{ id: '567890123456789012', username: 'Second' }] }
    ]);
    return new Promise(resolve => { release = () => resolve(Response.json({ total_results: 2 })); });
  };
  const refresh = $('#dmh-refresh').onclick(); await settle();
  assert.equal(typeof release, 'function');
  $('#dmh-clear').click();
  $('.dmd-confirm-actions .dmd-red').click(); await settle();
  release(); await refresh;
  assert.equal(requests.length, 3);
  assert.equal($('#dmh-list').querySelectorAll('.dmh-row').length, 0);
  assert.equal(dom.window.localStorage.getItem('del_discord_v1_history'), '{}');
  assert.equal($('#dmh-refresh').disabled, false);
});

test('refresh rate-limit failures retain completed results and show why verification stopped', async t => {
  const { dom, $ } = mount(t, {});
  let limitedRequests = 0, laterRequests = 0;
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    if (url.endsWith('/users/@me/channels')) return Response.json([
      { id: channel, type: 1, recipients: [{ id: userId, username: 'Verified' }] },
      { id: '456789012345678901', type: 1, recipients: [{ id: '567890123456789012', username: 'Limited' }] },
      { id: '678901234567890123', type: 1, recipients: [{ id: '789012345678901234', username: 'Later' }] },
    ]);
    if (url.includes(channel)) return Response.json({ total_results: 2 });
    if (url.includes('456789012345678901')) { limitedRequests++; return Response.json({ retry_after: 0 }, { status: 429 }); }
    laterRequests++; throw new Error('Later conversations must not be requested');
  };
  await assert.doesNotReject($('#dmh-refresh').onclick());
  assert.equal(limitedRequests, 3); assert.equal(laterRequests, 0);
  assert.match($('#dmh-summary').textContent, /Repeated rate limits/);
  assert.equal($('#dmh-list .dmh-name').textContent, 'Verified');
  const saved = JSON.parse(dom.window.localStorage.getItem('del_discord_v1_history'));
  assert.equal(saved[`u:${userId}`].sentCount, 2);
  assert.equal($('#dmh-refresh').disabled, false);
});

test('refresh reports a failure loading open conversations instead of silently showing an empty result', async t => {
  const { dom, $ } = mount(t, {});
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    throw new Error('Connection interrupted');
  };
  await assert.doesNotReject($('#dmh-refresh').onclick());
  assert.match($('#dmh-summary').textContent, /Connection interrupted/);
  assert.equal($('#dmh-refresh').disabled, false);
});

test('clearing history before a verification failure suppresses stale error messages and saves', async t => {
  const { dom, $ } = mount(t, {});
  let fail;
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    if (url.endsWith('/users/@me/channels')) return Response.json([{ id: channel, type: 1, recipients: [{ id: userId, username: 'Person' }] }]);
    return new Promise((_resolve, reject) => { fail = () => reject(new Error('Late connection failure')); });
  };
  const refresh = $('#dmh-refresh').onclick(); await settle();
  assert.equal(typeof fail, 'function');
  $('#dmh-clear').click(); $('.dmd-confirm-actions .dmd-red').click(); await settle();
  fail(); await assert.doesNotReject(refresh);
  assert.equal($('#dmh-summary').textContent, '');
  assert.equal($('#dmh-list').querySelectorAll('.dmh-row').length, 0);
  assert.equal(dom.window.localStorage.getItem('del_discord_v1_history'), '{}');
});

for (const stage of ['identity', 'channel', 'body']) test(`clearing history during Open DM ${stage} prevents stale restoration and navigation`, async t => {
  const { dom, $ } = mount(t, { [`u:${userId}`]: { userId, channelId: channel, name: 'Person', username: 'Person', verifiedSent: true, sentCount: 3 } });
  let release, opens = 0;
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return stage === 'identity'
      ? new Promise(resolve => { release = () => resolve(Response.json({ id: self })); }) : Response.json({ id: self });
    opens++;
    if (stage === 'channel') return new Promise(resolve => { release = () => resolve(Response.json({ id: channel })); });
    if (stage === 'body') return { ok: true, status: 200, headers: new Headers(), json: () => new Promise(resolve => { release = () => resolve({ id: channel }); }) };
    return Response.json({ id: channel });
  };
  const opening = $('.dmh-button.green').onclick(); await settle();
  assert.equal(typeof release, 'function');
  $('#dmh-clear').click(); $('.dmd-confirm-actions .dmd-red').click(); await settle();
  release(); await assert.doesNotReject(opening);
  assert.equal(opens, stage === 'identity' ? 0 : 1);
  assert.equal(dom.window.localStorage.getItem('del_discord_v1_history'), '{}');
  assert.equal($('#dmh-list').querySelectorAll('.dmh-row').length, 0);
  assert.equal(dom.window.location.href, 'https://discord.com/');
});

for (const clear of [false, true]) test(`Open DM reports request errors only while its history is current (clear=${clear})`, async t => {
  const { dom, $ } = mount(t, { [`u:${userId}`]: { userId, channelId: channel, name: 'Person', username: 'Person', verifiedSent: true, sentCount: 3 } });
  let fail;
  const alerts = [];
  dom.window.alert = text => alerts.push(text);
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: self });
    return new Promise((_resolve, reject) => { fail = () => reject(new Error('Connection interrupted')); });
  };
  const opening = $('.dmh-button.green').onclick(); await settle();
  assert.equal(typeof fail, 'function');
  if (clear) { $('#dmh-clear').click(); $('.dmd-confirm-actions .dmd-red').click(); await settle(); }
  fail(); await assert.doesNotReject(opening);
  if (clear) {
    assert.deepEqual(alerts, []);
    assert.equal(dom.window.localStorage.getItem('del_discord_v1_history'), '{}');
  } else assert.match(alerts[0], /Connection interrupted/);
});
