// Del-Discord v1 — personal source modules.
import { insertCss } from '../utils/insert-css.js';
import { loadHistory, loadState, saveHistory, saveState } from '../features/history/storage.js';
import { PAGE_SIZE } from '../features/history/config.js';
import { identity } from '../discord/history-auth.js';
import { affinityEntries, avatarUrl, displayName, usernameOf, users } from '../discord/users.js';
import { apiFetch } from '../discord/history-api.js';
import { API } from '../config.js';
import { merge, removeHistoryMatch } from '../features/history/model.js';
import { createHistoryView } from '../features/history/view.js';
import { sleep } from '../utils/timing.js';
import { verifyPerson } from '../features/history/verify.js';
import { importPackage } from '../features/history/import-package.js';
import { askPopup } from './history-confirm.js';
import panelHtml from './history.html';
import panelCss from './history.css';

export function initHistory(container, { deleteConversations = async () => [] } = {}) {
  if (document.getElementById('dmh-panel')) return;
  insertCss(panelCss);

  const panel = document.createElement('div');
  panel.id = 'dmh-panel';
  panel.className = 'dmd-view';
  panel.style.display = 'none';
  panel.innerHTML = panelHtml;
  container.insertBefore(panel, container.querySelector('#dmd-progress-dock'));

  const domCache = new Map();
  const $ = q => {
    if (domCache.has(q)) return domCache.get(q);
    const node = panel.querySelector(q);
    domCache.set(q, node);
    return node;
  };
  let history = loadHistory();
  const selected = new Set();
  let deleting = false;
  const selectionKey = entry => entry.channelId || entry.userId;
  const updateSelection = () => {
    $('#dmh-delete-all').hidden = selected.size === 0;
    $('#dmh-delete-all').textContent = `Delete All (${selected.size})`;
  };
  const stored = loadState();
  let page = Number.isInteger(stored.page) ? Math.max(0, stored.page) : 0;
  let query = typeof stored.query === 'string' ? stored.query : '';
  let packageInfo = stored.packageInfo && typeof stored.packageInfo === 'object' ? stored.packageInfo : null;
  let me = null, visible = [], resolving = false, resolvePending = false, refreshing = false;
  const nameAttempts = new WeakMap();
  const historyView = createHistoryView();
  $('#dmh-search').value = query;


  const persist = () => saveState({ page, query, packageInfo });
  const sourceName = s => ({ open: 'Open DM', affinity: 'Closed/cache', package: 'Data Package' })[s] || s;

  function filteredItems() {
    return historyView(history, query);
  }

  async function resolveVisibleUsers() {
    if (resolving) { resolvePending = true; return; }
    resolving = true;
    resolvePending = false;
    const resolvingHistory = history;
    const resolvingVisible = visible;
    try {
      let changed = false;
      for (const entry of resolvingVisible) {
        if (history !== resolvingHistory) break;
        if (!visible.includes(entry) || !entry.userId || (entry.name && entry.username)) continue;
        const attemptedAt = nameAttempts.get(entry);
        if (attemptedAt !== undefined && Date.now() - attemptedAt < 60000) continue;
        nameAttempts.set(entry, Date.now());
        let user = null;
        let remoteLookup = false;
        try { user = users?.getUser?.(entry.userId) || null; } catch {}
        if (!user) {
          if (!me) me = await identity();
          if (!me || history !== resolvingHistory) break;
          remoteLookup = true;
          try {
            const r = await apiFetch(`${API}/users/${entry.userId}`, { headers: { Authorization: me.token } });
            if (r.ok) user = await r.json();
          } catch {}
        }
        if (history !== resolvingHistory) break;
        if (user) {
          const resolved = merge(history, { userId: entry.userId, name: displayName(user), username: usernameOf(user), avatar: avatarUrl(user), seenAt: new Date().toISOString() });
          nameAttempts.set(resolved, Date.now());
          changed = true;
        }
        if (remoteLookup) await sleep(50);
      }
      if (changed && history === resolvingHistory) { saveHistory(history); render(false); }
    } finally {
      resolving = false;
      if (resolvePending) void resolveVisibleUsers();
    }
  }

  function render(resolveNames = true) {
    const all = filteredItems();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages - 1));
    persist();
    visible = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const list = $('#dmh-list');
    list.textContent = '';
    const fragment = document.createDocumentFragment();

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:28px;text-align:center;color:#949ba4';
      empty.textContent = query
        ? 'No matches.'
        : 'No verified sent-DM history yet. Press Refresh & Verify or import your Discord Data Package.';
      fragment.appendChild(empty);
    }

    for (const entry of visible) {
      const row = document.createElement('div'); row.className = 'dmh-row';
      let av;
      if (entry.avatar) { av = document.createElement('img'); av.className = 'dmh-av'; av.src = entry.avatar; av.alt = ''; }
      else { av = document.createElement('div'); av.className = 'dmh-fallback'; av.textContent = (entry.name || entry.username || '?').charAt(0).toUpperCase(); }
      const main = document.createElement('div'); main.className = 'dmh-main';
      const nm = document.createElement('div'); nm.className = 'dmh-name'; nm.textContent = entry.name || entry.username || (entry.userId ? `User ${entry.userId}` : `DM Channel ${entry.channelId}`);
      const sub = document.createElement('div'); sub.className = 'dmh-sub'; sub.textContent = [(entry.username && entry.username !== entry.name) ? entry.username : '', entry.userId ? `User ID: ${entry.userId}` : '', entry.channelId ? `Channel: ${entry.channelId}` : ''].filter(Boolean).join(' • ');
      const badges = document.createElement('div'); badges.className = 'dmh-badges';
      for (const source of entry.sources || []) { const b = document.createElement('span'); b.className = 'dmh-badge'; b.textContent = sourceName(source); badges.appendChild(b); }
      const count = document.createElement('span'); count.className = 'dmh-badge'; count.textContent = entry.cleanupFinishedAt ? 'Cleanup finished · refresh to verify' : entry.sentCountExact ? `You sent ${entry.sentCount}` : `You sent ${entry.sentCount}+`; badges.appendChild(count);
      main.append(nm, sub, badges);
      const actions = document.createElement('div');
      if (entry.userId) {
        const open = document.createElement('button'); open.className = 'dmh-button green'; open.textContent = 'Open DM';
        open.onclick = async () => {
          const openingHistory = history;
          try {
            const currentIdentity = me || await identity();
            if (history !== openingHistory) return;
            me = currentIdentity;
            if (!me) return alert('Could not get a valid Discord authorization token.');
            const r = await apiFetch(`${API}/users/@me/channels`, { method: 'POST', headers: { Authorization: me.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: entry.userId }) });
            if (history !== openingHistory) return;
            if (!r.ok) return alert(`Discord could not reopen this DM (HTTP ${r.status}).`);
            const ch = await r.json();
            if (history !== openingHistory) return;
            merge(history, { userId: entry.userId, channelId: ch.id, sources: ['open'], sentCount: entry.sentCount, sentCountExact: entry.sentCountExact, verifiedSent: true, seenAt: new Date().toISOString() });
            saveHistory(history); location.href = `/channels/@me/${ch.id}`;
          } catch (error) {
            if (history === openingHistory) alert(`Discord could not reopen this DM: ${error?.message || error}`);
          }
        };
        actions.appendChild(open);
      }
      const select = document.createElement('input'); select.type = 'checkbox'; select.className = 'dmh-select';
      select.checked = selected.has(selectionKey(entry)); select.disabled = deleting;
      select.setAttribute('aria-label', `Select ${entry.name || entry.username || entry.channelId || entry.userId}`);
      select.onchange = () => { if (select.checked) selected.add(selectionKey(entry)); else selected.delete(selectionKey(entry)); updateSelection(); };
      row.append(select, av, main, actions);
      fragment.appendChild(row);
    }

    list.appendChild(fragment);
    updateSelection();

    $('#dmh-page').textContent = `Page ${page + 1} of ${pages}`;
    $('#dmh-prev').disabled = page === 0; $('#dmh-next').disabled = page >= pages - 1;
    $('#dmh-page-input').max = String(pages); $('#dmh-page-input').value = String(page + 1);
    $('#dmh-summary').textContent = '';
    if (resolveNames) void resolveVisibleUsers();
  }

  async function refreshLive() {
    if (refreshing) return;
    refreshing = true; $('#dmh-refresh').disabled = true; $('#dmh-summary').textContent = 'Loading Discord DM data…';
    const refreshingHistory = history;
    let dirty = 0;
    try {
      const refreshedIdentity = await identity();
      if (history !== refreshingHistory) return;
      me = refreshedIdentity;
      if (!me) { $('#dmh-summary').textContent = 'Could not get a valid Discord authorization token.'; return; }
      const openByUser = new Map();
      const r = await apiFetch(`${API}/users/@me/channels`, { headers: { Authorization: me.token } });
      if (history !== refreshingHistory) return;
      if (!r.ok) throw new Error(`Could not load open DMs (HTTP ${r.status}).`);
      const channels = await r.json();
      if (history !== refreshingHistory) return;
      for (const ch of Array.isArray(channels) ? channels : []) {
        if (ch?.type !== 1) continue;
        const u = ch.recipients?.find?.(v => v?.id && v.id !== me.user.id);
        if (u) openByUser.set(u.id, { channelId: ch.id, user: u });
      }

      const candidates = new Map();
      for (const [userId, data] of openByUser) candidates.set(userId, { userId, channelId: data.channelId, user: data.user, wasOpen: true, dmRank: null, source: 'open' });
      for (const a of affinityEntries().filter(a => a?.otherUserId && a.otherUserId !== me.user.id && Number.isFinite(a.dmRank) && a.dmRank >= 0)) {
        const existing = candidates.get(a.otherUserId);
        if (existing) existing.dmRank = a.dmRank;
        else candidates.set(a.otherUserId, { userId: a.otherUserId, channelId: '', user: null, wasOpen: false, dmRank: a.dmRank, source: 'affinity' });
      }

      const all = [...candidates.values()];
      let done = 0;

      for (const c of all) {
        if (history !== refreshingHistory) return;
        done++;
        $('#dmh-summary').textContent = `Verifying sent-message history ${done}/${all.length}…`;

        const result = await verifyPerson(me.token, me.user.id, c.userId, c.channelId, c.wasOpen);
        if (history !== refreshingHistory) return;
        if (!result || result.count === null) {
          await sleep(200);
          continue;
        }

        if (result.count <= 0) {
          removeHistoryMatch(history, c.userId, result.channelId || c.channelId);
          dirty++;
        } else {
          let user = c.user;
          if (!user) {
            try { user = users?.getUser?.(c.userId) || null; } catch {}
          }

          merge(history, {
            userId: c.userId,
            channelId: result.channelId || c.channelId,
            name: displayName(user),
            username: usernameOf(user),
            avatar: avatarUrl(user),
            dmRank: c.dmRank,
            sources: [c.source],
            sentCount: result.count,
            sentCountExact: true,
            cleanupFinishedAt: null,
            verifiedSent: true,
            seenAt: new Date().toISOString()
          });
          dirty++;
        }

        if (dirty >= 5) {
          saveHistory(history);
          dirty = 0;
        }

        await sleep(250);
      }

      if (history !== refreshingHistory) return;
      if (dirty) saveHistory(history);
      render();
    } catch (error) {
      if (history !== refreshingHistory) return;
      if (dirty) saveHistory(history);
      render(false);
      $('#dmh-summary').textContent = `Refresh stopped: ${error?.message || error}`;
    } finally { $('#dmh-refresh').disabled = false; refreshing = false; }
  }


  function goToPage() {
    const pages = Math.max(1, Math.ceil(filteredItems().length / PAGE_SIZE));
    let requested = parseInt($('#dmh-page-input').value, 10);
    if (!Number.isFinite(requested)) requested = page + 1;
    page = Math.max(1, Math.min(pages, requested)) - 1; render();
  }

  $('#dmh-delete-all').onclick = async () => {
    if (deleting) return;
    const targets = Object.values(history).filter(entry => selected.has(selectionKey(entry)));
    if (!targets.length) return;
    deleting = true; render(false);
    try {
      const completed = await deleteConversations(targets);
      for (const entry of completed) { selected.delete(selectionKey(entry)); entry.cleanupFinishedAt = new Date().toISOString(); }
      if (completed.length) saveHistory(history);
    } finally { deleting = false; render(false); }
  };

  $('#dmh-search').oninput = e => { query = e.target.value || ''; page = 0; render(); };
  $('#dmh-refresh').onclick = refreshLive;
  $('#dmh-import').onclick = () => $('#dmh-folder').click();
  $('#dmh-folder').onchange = e => importPackage(e.target.files, { $, getHistory: () => history, getIdentity: async () => me || (me = await identity()), setPackageInfo: value => { packageInfo = value; }, persist, render });
  $('#dmh-prev').onclick = () => { page--; render(); };
  $('#dmh-next').onclick = () => { page++; render(); };
  $('#dmh-page-go').onclick = goToPage;
  $('#dmh-page-input').onkeydown = e => { if (e.key === 'Enter') goToPage(); };
  $('#dmh-clear').onclick = async () => {
    const approved = await askPopup({
      title: 'Clear saved DM history?',
      message: 'This clears the locally saved history, package cache, page, and search state. It does not delete or close Discord DMs.',
      yesText: 'Clear',
      noText: 'Cancel',
      danger: true
    });
    if (!approved) return;
    selected.clear(); history = {}; page = 0; query = ''; packageInfo = null; $('#dmh-search').value = ''; saveHistory(history); persist(); render(false);
  };

  render(false);
  return { activate: () => render() };
}
