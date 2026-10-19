import { installSavedSettings } from './saved-settings.js';
import { trashIcon } from './trash-icon.js';
import { installChannelPickers } from './channel-picker.js';
import { createQueueIdentityResolver, cleanQueueLabel } from '../discord/queue-identity.js';
import { createConversationPreviewResolver } from '../discord/conversation-preview.js';
import { resolveConversation } from '../discord/conversation.js';
import { apiFetch } from '../discord/api.js';
import { parseIdList } from '../utils/id-list.js';
import { enhanceCalendars } from './calendar.js';
import { enhanceSelects } from './select.js';
import { installIdentityPreviews } from './identity-preview.js';
import { initHistory } from './history.js';
// Del-Discord v1 — personal source modules.
import { insertCss } from '../utils/insert-css.js';
import { createLog } from './log.js';
import { currentContext, currentLabel, parseMessageReference } from '../utils/messages.js';
import { resolveToken } from '../discord/deleter-auth.js';
import { createQueue } from '../features/queue.js';
import { installPanelWindowControls } from '../utils/drag.js';
import { findDiscordToolbar } from '../discord/toolbar.js';
import { observeDiscordPage } from '../discord/page-observer.js';
import { downloadBlob, downloadTextFile, safeFilePart, timeStampForFile } from '../utils/files.js';
import { askExportSelection } from './export-selection.js';
import { askPopup } from './confirm.js';
import { runState } from '../utils/run-state.js';
import { exportConversationData, conversationToBlob } from '../features/export.js';
import { collectExportAttachments, createAttachmentDownloadState } from '../features/export-attachments.js';
import { createZipBudget, filesToZip } from '../utils/zip.js';
import { deleteMessages } from '../features/messages.js';
import { listForumThreads, cleanupForumThread } from '../features/forum-threads.js';
import { normalizeCleanupOptions } from '../features/message-filters.js';
import { runDirectMessages } from '../features/direct-messages.js';
import { parseMessageIds, importMessageIds } from '../features/message-ids.js';
import { API, MAX_REACTION_SCAN, MAX_MESSAGE_IDS } from '../config.js';
import { removeReactions } from '../features/reactions.js';
import { rand, sleep } from '../utils/timing.js';
import panelHtml from './deleter.html';
import panelCss from './deleter.css';

export function initDeleter() {
  if (document.getElementById('dmd-panel')) return;
  insertCss(panelCss);

  const btn = document.createElement('button');
  btn.id = 'dmd-toolbar-btn';
  btn.type = 'button';
  btn.title = 'Del-Discord v1 — Delete Messages';
  btn.setAttribute('aria-label', 'Delete Messages');
  btn.innerHTML = trashIcon();

  const panel = document.createElement('div');
  panel.id = 'dmd-panel';
  panel.innerHTML = panelHtml.replace('${MAX_REACTION_SCAN}', String(MAX_REACTION_SCAN));
  document.body.appendChild(panel);

  const messagesView = panel.querySelector('#dmd-messages');
  const forumsView = panel.querySelector('#dmd-forums');
  forumsView.className = 'dmd-subview'; messagesView.appendChild(forumsView);
  const queueView = panel.querySelector('#dmd-multi');
  const queueBody = document.createElement('div'); queueBody.id = 'dmd-queue-conversations';
  [...queueView.children].filter(node => node.id !== 'dmd-queue-modes').forEach(node => queueBody.appendChild(node));
  queueView.appendChild(queueBody);
  const idsView = panel.querySelector('#dmd-ids'); idsView.className = 'dmd-subview'; queueView.appendChild(idsView);
  let messageMode = 'dm', queueMode = 'multi';

  const domCache = new Map();
  const $ = q => {
    if (domCache.has(q)) return domCache.get(q);
    const node = panel.querySelector(q);
    domCache.set(q, node);
    return node;
  };

  const savedSettings = installSavedSettings(panel, { getMode: () => messageMode, setMode: value => { messageMode = value; }, onReset: () => { syncViews(); fillContext(); }, onStorageError: () => log('warn', 'Messages settings could not be saved locally. Changes may be lost on refresh.') });
  $('#dmd-clear-filters').onclick = savedSettings.clear;
  const history = initHistory(panel, { deleteConversations: entries => deleteHistoryConversations(entries) });
  const identityCache = new Map();
  const identityPreviews = installIdentityPreviews($, { cache: identityCache });
  const reactionPreviews = installIdentityPreviews($, { author: '#dmd-rx-author', guild: '#dmd-rx-guild', userBadge: '#dmd-rx-user-avatar', guildBadge: '#dmd-rx-guild-avatar', cache: identityCache });
  const queueServerPreview = installIdentityPreviews($, { author: null, guild: '#dmd-server-id', userBadge: null, guildBadge: '#dmd-server-avatar', cache: identityCache });
  enhanceSelects(panel);
  enhanceCalendars(panel);
  const channelPickers = installChannelPickers($, () => messageMode !== 'thread');
  const logBox = $('#dmd-log');
  const { log, logEntries } = createLog(logBox);

  const resolveBoundary = (messageValue, dateValue, channelId, side) => {
    const messageText = String(messageValue || '').trim();
    if (messageText) {
      const ref = parseMessageReference(messageText);
      if (!ref) throw new Error(`${side} message must be a Discord message ID or message link.`);
      if (ref.channelId && channelId && ref.channelId !== channelId) {
        log('warn', `${side} message link is for channel ${ref.channelId}, but the selected channel is ${channelId}. Using the message ID anyway.`);
      }
      return ref.messageId;
    }
    return String(dateValue || '').trim();
  };

  const getRange = channelId => ({
    minId: resolveBoundary($('#dmd-after-kind').value === 'id' ? $('#dmd-after-message').value : '', $('#dmd-after-kind').value === 'date' ? $('#dmd-after').value : '', channelId, 'After'),
    maxId: resolveBoundary($('#dmd-before-kind').value === 'id' ? $('#dmd-before-message').value : '', $('#dmd-before-kind').value === 'date' ? $('#dmd-before').value : '', channelId, 'Before')
  });

  const getCleanupOptions = channelId => normalizeCleanupOptions({
    freshHistory: true,
    ...getRange(channelId),
    authorIds: parseIdList($('#dmd-author').value, 'Author(s)'),
    action: $('#dmd-action').value, order: $('#dmd-order').value,
    overwriteText: $('#dmd-overwrite-text').value,
    content: $('#dmd-content').value, textMode: $('#dmd-text-mode').value,
    linkMode: $('#dmd-link-mode').value, fileMode: $('#dmd-file-mode').value,
    pinnedMode: $('#dmd-pinned-mode').value, includeNsfw: $('#dmd-nsfw').checked,
    filename: $('#dmd-filename').value, extensions: $('#dmd-extensions').value,
    textRegex: $('#dmd-text-regex').value, regexFlags: $('#dmd-regex-flags').value, regexMode: $('#dmd-regex-mode').value,
    assetRegex: $('#dmd-asset-regex').value, assetRegexFlags: $('#dmd-asset-regex-flags').value, assetMode: $('#dmd-asset-mode').value,
    collectAll: $('#dmd-collect-all').checked,
  });
  $('#dmd-action').onchange = () => {
    $('#dmd-overwrite-field').hidden = $('#dmd-action').value !== 'overwrite';

  };
  $('#dmd-action').onchange();
  let cleanupBusy = false;
  const setCleanupBusy = (busy, stopId) => {
    cleanupBusy = busy;
    for (const id of ['#dmd-export-conversation', '#dmd-id-import', '#dmd-id-package', '#dmd-forum-load', '#dmd-multi-export', '#dmd-forum-export', '#dmh-refresh', '#dmh-import', '#dmh-clear']) $(id).disabled = busy;
    $(stopId).disabled = !busy;
  };

  const updatePercentage = (progressId, percentId) => {
    const bar = $(progressId);
    $(percentId).textContent = `${Math.round(bar.value / Math.max(1, bar.max) * 100)}%`;
  };

  const setProgress = (value, max) => {
    max = Math.max(Number(max) || 1, Number(value) || 0, 1);
    const bar = $('#dmd-progress');
    bar.max = max; bar.value = Math.min(Number(value) || 0, max);
    $('#dmd-pct').textContent = `${Math.round(bar.value / bar.max * 100)}%`;
  };
  const setMultiProgress = (value, max, status = '') => {
    max = Math.max(Number(max) || 1, 1);
    const bar = $('#dmd-multi-progress');
    bar.max = max; bar.value = Math.min(Number(value) || 0, max);
    $('#dmd-multi-pct').textContent = `${Math.round(bar.value / bar.max * 100)}%`;
    $('#dmd-multi-status').textContent = status;
  };

  const automaticFields = new Map();
  const fillAutomatic = (id, value) => {
    const field = $(id);
    if (!field.value.trim() || field.value === automaticFields.get(id)) {
      field.value = value; automaticFields.set(id, value);
    }
  };
  for (const id of ['#dmd-guild', '#dmd-channel', '#dmd-rx-channel', '#dmd-rx-guild', '#dmd-forum-id']) {
    $(id).addEventListener('input', () => automaticFields.delete(id));
    $(id).addEventListener('change', () => automaticFields.delete(id));
  }
  const fillContext = () => {
    const ctx = currentContext();
    if (!ctx) return;
    fillAutomatic('#dmd-guild', ctx.guildId);
    fillAutomatic('#dmd-channel', ctx.channelId);
    fillAutomatic('#dmd-rx-channel', ctx.channelId);
    fillAutomatic('#dmd-rx-guild', ctx.guildId);
    void reactionPreviews.refresh('guild');
    if (ctx.guildId !== '@me') fillAutomatic('#dmd-forum-id', ctx.channelId);
    void identityPreviews.refresh('guild');
    void channelPickers.refresh();
  };
  const resolvePreview = createConversationPreviewResolver();
  let detectionVersion = 0;
  const detectVisibleConversation = async () => {
    const channelId = $('#dmd-channel').value.trim(), token = $('#dmd-token').value.trim();
    const version = ++detectionVersion;
    if (panel.style.display !== 'flex' || !token || !/^\d{15,22}$/.test(channelId) || cleanupBusy || messageMode === 'server') return;
    try {
      const detected = await resolvePreview({ token, channelId });
      if (version !== detectionVersion || cleanupBusy || messageMode === 'server' || $('#dmd-channel').value.trim() !== channelId) return;
      messageMode = detected.mode;
      fillAutomatic('#dmd-guild', detected.guildId);
      if (detected.mode === 'forums') fillAutomatic('#dmd-forum-id', detected.channelId);
      syncViews();
    } catch (error) { if (version === detectionVersion && !cleanupBusy) log('warn', error.message); }
  };

  const loadIdentity = async () => {
    const found = await resolveToken($('#dmd-token').value.trim());
    if (!found) { log('error', 'Could not find a valid Discord authorization token. Refresh Discord and press GET again.'); return null; }
    $('#dmd-token').value = found.token;
    if (!$('#dmd-author').value.trim()) $('#dmd-author').value = found.user.id;
    identityPreviews.seedUser(found.user);
    fillAutomatic('#dmd-rx-author', found.user.id);
    void reactionPreviews.refresh('user');
    void reactionPreviews.refresh('guild');
    void identityPreviews.refresh('user');
    void identityPreviews.refresh('guild');
    void channelPickers.refresh();
    log('success', `Authorization loaded for ${found.user.username || 'your account'}.`);
    void detectVisibleConversation();
    return found;
  };

  const queueIdentities = createQueueIdentityResolver();
  let refreshRunningQueue = null;
  const queue = createQueue({ $, log, onChange: () => refreshRunningQueue?.() });
  const { renderQueue } = queue;
  let decoratingQueue = false;
  const decoratedItems = new Set();
  const hydrateQueueIcons = async () => {
    const token = $('#dmd-token').value.trim();
    if (!token || decoratingQueue || cleanupBusy) return;
    decoratingQueue = true;
    try {
      for (const item of [...queue.getItems()]) {
        if (cleanupBusy) break;
        const key = `${item.guildId}/${item.channelId}`;
        if (item.icon || item.kind === 'ids' || decoratedItems.has(key)) continue;
        decoratedItems.add(key);
        queue.updateIdentity(item, await queueIdentities.resolve(item, token, log));
        await sleep(rand(350, 600));
      }
    } finally { decoratingQueue = false; }
  };


  const panelWindow = installPanelWindowControls({ panel, dragHandle: panel, resizeHandles: [$('#dmd-resize-left'), $('#dmd-resize-handle')], storage: () => localStorage, storageKey: 'del_discord_v1_deleter_geometry_compact', defaultWidth: 660, defaultRatio: 660 / 480 });

  function mountToolbarButton() {
    const toolbar = findDiscordToolbar();
    if (!toolbar) return false;
    if (btn.parentElement !== toolbar) toolbar.appendChild(btn);
    return true;
  }

  btn.onclick = async () => {
    const open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    btn.classList.toggle('open', !open);
    if (!open) {
      panelWindow.ensureGeometry(); fillContext();
      if (!$('#dmd-token').value) await loadIdentity(); else void detectVisibleConversation();
      if (queue.getItems().length && !cleanupBusy) {
        const continued = await askPopup({ title: 'Saved Queue', message: `${queue.getItems().length} queued cleanups are saved locally. Continue running them or clear the queue?`,
          yesText: 'Continue', noText: 'Clear Queue', onNo: () => queue.clear() });
        if (continued && !cleanupBusy) { panel.querySelector('[data-view="multi"]').click(); await $('#dmd-multi-start').onclick(); }
      }
    }
  };

  const syncViews = () => {
    const active = panel.querySelector('.dmd-tab.active').dataset.view;
    $('#dmd-messages').style.display = active === 'messages' ? '' : 'none';
    $('#dmd-reactions').style.display = active === 'reactions' ? '' : 'none';
    $('#dmd-multi').style.display = active === 'multi' ? '' : 'none';
    const threadMode = messageMode === 'forums' || messageMode === 'thread';
    $('#dmd-channel').previousElementSibling.textContent = messageMode === 'thread' ? 'Thread(s)' : 'Channel(s)';
    $('#dmd-channel').placeholder = messageMode === 'thread' ? 'Thread ID, thread ID' : 'Channel ID, channel ID';
    $('#dmd-thread-target').hidden = !threadMode;
    $('#dmd-channel').closest('.dmd-field').hidden = messageMode === 'server';
    $('#dmd-archived-option').hidden = messageMode !== 'forums';
    if (threadMode && $('#dmd-thread-target-kind').value !== messageMode) {
      $('#dmd-thread-target-kind').value = messageMode;
      $('#dmd-thread-target-kind').dispatchEvent(new Event('change'));
    }
    panel.querySelectorAll('#dmd-message-modes button').forEach(button => { const selected = button.dataset.mode === messageMode || (threadMode && button.dataset.mode === 'forums'); button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
    $('#dmd-forums').style.display = messageMode === 'forums' ? '' : 'none';
    $('#dmd-messages > .dmd-actions').hidden = messageMode === 'forums';
    $('#dmd-queue-conversations').hidden = queueMode === 'ids';
    $('#dmd-queue-server-inputs').hidden = queueMode !== 'server';
    $('#dmd-ids').style.display = queueMode === 'ids' ? '' : 'none';
    $('#dmh-panel').style.display = active === 'history' ? 'flex' : 'none';
    $('#dmd-progress-dock').hidden = false;
    const progressView = active === 'multi' ? (queueMode === 'server' ? 'multi' : queueMode) : active;
    panel.querySelectorAll('[data-progress-view]').forEach(area => { area.hidden = area.dataset.progressView !== progressView; });
    void channelPickers.refresh();
  };
  panel.querySelectorAll('.dmd-tab').forEach(tab => {
    tab.onclick = () => {
      panel.querySelectorAll('.dmd-tab').forEach(x => x.classList.toggle('active', x === tab)); syncViews();
      if (tab.dataset.view === 'history') history.activate();
      if (tab.dataset.view === 'multi') { renderQueue(); void hydrateQueueIcons(); }
    };
  });
  panel.querySelectorAll('#dmd-message-modes button').forEach(button => {
    button.onclick = () => {
      messageMode = button.dataset.mode === 'forums' ? $('#dmd-thread-target-kind').value : button.dataset.mode;


      void identityPreviews.refresh('guild'); syncViews(); savedSettings.save();
    };
  });
  $('#dmd-thread-target-kind').addEventListener('change', () => {
    messageMode = $('#dmd-thread-target-kind').value;
    syncViews(); savedSettings.save();
  });
  panel.querySelectorAll('#dmd-queue-modes button').forEach(button => {
    button.onclick = () => {
      queueMode = button.dataset.mode;
      panel.querySelectorAll('#dmd-queue-modes button').forEach(node => { node.classList.toggle('active', node === button); node.setAttribute('aria-pressed', String(node === button)); });
      syncViews();
    };
  });
  syncViews();

  let queuePromptOpen = false, queuePromptDone = null;
  const offerQueue = async (items, options, allowAnyThread = false, targets = null) => {
    if (queuePromptOpen) return;
    if (!items.length && !targets?.length) return log('warn', 'Select at least one conversation or message ID.');
    if (items.some(item => !item.guildId || !/^\d{15,22}$/.test(String(item.kind === 'server' ? item.guildId : item.channelId || '')))) return log('error', 'Enter valid conversation IDs before adding to the queue.');
    queuePromptOpen = true;
    let finishPrompt;
    queuePromptDone = new Promise(resolve => { finishPrompt = resolve; });
    try {
      const approved = await askPopup({ title: 'Add to Queue?', message: `Queue this ${options.action || 'delete'} cleanup with the selected filters? Starting the queue will run it without another confirmation.`,
        details: targets ? `${targets.length} message IDs` : items.map(item => item.label || item.channelId).join('\n'), yesText: 'Add to Queue', noText: 'Cancel' });
      if (!approved) return;
      const savedOptions = { ...options }; delete savedOptions.textPattern; delete savedOptions.assetPattern;
      if (targets) queue.addIdJob(targets, savedOptions);
      else {
        const jobs = [];
        for (const item of items) {
          const decorated = await queueIdentities.resolve(item, $('#dmd-token').value.trim(), log);
          jobs.push({ ...decorated, options: savedOptions, allowAnyThread, detectConversation: item.kind !== 'server' });
        }
        queue.addQueueItems(jobs);
      }
      log('info', refreshRunningQueue ? 'Cleanup added to the running queue.' : 'Cleanup queued. Press Start Queue to begin.');
    } finally { queuePromptOpen = false; finishPrompt(); queuePromptDone = null; }
  };

  const deleteHistoryConversations = async entries => {
    if (cleanupBusy) { await offerQueue(entries.map(entry => ({ guildId: '@me', channelId: entry.channelId, label: entry.name || entry.username || entry.channelId })), { action: 'delete', collectAll: true, pinnedMode: 'any' }); return []; }
    const completed = [];
    setCleanupBusy(true, '#dmh-stop'); runState.stopped = false; $('#dmh-stop').hidden = false;
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.stopped) return completed;
      const approved = await askPopup({ title: 'Are you sure?',
        message: `Delete all of your messages, including pinned messages, in ${entries.length} selected DMs? Other people's messages and the DM conversations will remain.`,
        details: entries.map(entry => entry.name || entry.username || entry.channelId || entry.userId).join('\n'),
        yesText: 'Delete All', noText: 'Cancel', danger: true });
      if (!approved || runState.stopped) return completed;
      $('#dmh-progress').max = entries.length; $('#dmh-progress').value = 0; updatePercentage('#dmh-progress', '#dmh-pct');
      for (const [index, entry] of entries.entries()) {
        if (runState.stopped) break;
        let channelId = entry.channelId;
        if (!channelId && entry.userId) {
          const response = await apiFetch(`${API}/users/@me/channels`, { method: 'POST', headers: { Authorization: identity.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: entry.userId }) }, log, () => runState.stopped);
          if (!response.ok) throw new Error(`Could not open DM (${response.status}).`);
          channelId = (await response.json()).id;
        }
        if (runState.stopped) break;
        if (!/^\d{15,22}$/.test(String(channelId || ''))) throw new Error('This history entry has no valid DM channel.');
        $('#dmh-progress-status').textContent = `Cleaning ${index + 1}/${entries.length}`;
        const result = await deleteMessages({ token: identity.token, authorId: identity.user.id, guildId: '@me', channelId,
          action: 'delete', pinnedMode: 'any', collectAll: true, freshHistory: true, log, stopCheck: () => runState.stopped });
        if (!result?.done || result.failed > 0) break;
        completed.push(entry); $('#dmh-progress').value = index + 1; updatePercentage('#dmh-progress', '#dmh-pct');
      }
      log('info', `Finished ${completed.length}/${entries.length} selected DMs.`);
    } catch (error) { log('error', error.message || error); }
    finally { setCleanupBusy(false, '#dmh-stop'); $('#dmh-stop').hidden = true; runState.stopped = false; }
    return completed;
  };
  $('#dmh-stop').onclick = () => { runState.stopped = true; };

  $('#dmd-get-token').onclick = loadIdentity;
  $('#dmd-clear').onclick = () => { logBox.textContent = ''; logEntries.length = 0; setProgress(0, 1); };
  $('#dmd-export-log').onclick = () => {
    if (!logEntries.length) return log('warn', 'There is no log to export yet.');
    const ctx = currentContext();
    const header = [
      'Discord deletion log',
      `Exported: ${new Date().toISOString()}`,
      `Server: ${ctx?.guildId || $('#dmd-guild').value.trim() || ''}`,
      `Channel: ${ctx?.channelId || $('#dmd-channel').value.trim() || ''}`,
      ''
    ].join('\n');
    const body = logEntries.map(x => `[${x.time}] [${String(x.type).toUpperCase()}] ${x.message}`).join('\n');
    downloadTextFile(`discord-log-${timeStampForFile()}.txt`, header + body);
  };
  let activeExportController = null;
  // All export entry points share confirmation, cancellation, ranges, and download handling.
  const exportConversations = async ({ targets, stopId, stopped, setStopped, progress, filename, select = false }) => {
    if (cleanupBusy) return;
    let conversations;
    try { conversations = targets(); } catch (error) { return log('error', error.message); }
    if (!conversations.length) return log('warn', 'Select or queue at least one conversation to export.');
    setCleanupBusy(true, stopId); setStopped(false);
    const controller = new AbortController(), { signal } = controller;
    activeExportController = controller;
    try {
      const choice = await askExportSelection(conversations, { range: getRange(conversations[0].channelId), select, signal });
      if (!choice || stopped()) return;
      conversations = choice.conversations;
      const { format, range, downloadAttachments } = choice;
      const identity = await resolveToken($('#dmd-token').value.trim(), { log, stopCheck: stopped, strict: true, signal });
      if (stopped()) return;
      if (!identity) return log('error', 'Authorization could not be validated. Refresh Discord and try again.');
      const exports = [], attachmentFiles = [], attachmentReport = [];
      const attachmentState = createAttachmentDownloadState();
      const exportName = `discord-${safeFilePart(filename)}-${timeStampForFile()}`;
      const messageFilename = `${exportName}.${format}`;
      const jsonPrefix = format === 'json' && conversations.length > 1
        ? `{\n  "exportedAt": ${JSON.stringify(new Date().toISOString())},\n  "conversationCount": ${conversations.length},\n  "conversations": [\n` : '';
      const jsonSuffix = jsonPrefix ? '\n  ]\n}' : '';
      const archiveBudget = downloadAttachments ? createZipBudget() : null;
      let exportBytes = jsonPrefix.length + jsonSuffix.length;
      // Reserve both required entries before requesting attachment payloads.
      archiveBudget?.setFile(messageFilename, exportBytes);
      archiveBudget?.setFile('attachments.json', 2);
      let messageCount = 0;
      progress(0, conversations.length);
      for (const [index, item] of conversations.entries()) {
        if (stopped()) return;
        const data = await exportConversationData({ token: identity.token, ...item,
          ...range, log, stopCheck: stopped, signal });
        if (stopped()) return;
        const blob = await conversationToBlob(data, { format, includeCsvHeader: index === 0, stopCheck: stopped });
        if (stopped()) return;
        const separator = exports.length ? (format === 'csv' ? '\r\n' : ',\n') : '';
        if (format === 'json' || blob.size) {
          exportBytes += separator.length + blob.size;
          archiveBudget?.setFile(messageFilename, exportBytes);
        }
        if (downloadAttachments) await collectExportAttachments(data, { files: attachmentFiles, report: attachmentReport, log, stopCheck: stopped, state: attachmentState, signal, budget: archiveBudget });
        if (stopped()) return;
        messageCount += data.messageCount;
        if (format === 'json' || blob.size) {
          if (separator) exports.push(separator);
          exports.push(blob);
        }
        progress(index + 1, conversations.length);
      }
      const blob = new Blob([jsonPrefix, ...exports, jsonSuffix], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' });
      if (downloadAttachments) {
        log('info', 'Packaging messages and attachments...');
        const reportBlob = new Blob([JSON.stringify(attachmentReport, null, 2)], { type: 'application/json' });
        archiveBudget.setFile('attachments.json', reportBlob.size);
        const archive = await filesToZip([
          { name: messageFilename, blob },
          { name: 'attachments.json', blob: reportBlob },
          ...attachmentFiles,
        ], stopped);
        if (stopped()) return;
        downloadBlob(`${exportName}.zip`, archive);
        const failed = attachmentReport.filter(item => ['failed', 'skipped'].includes(item.status)).length;
        log(failed ? 'warn' : 'info', `Attachments: ${attachmentFiles.length} downloaded; ${failed} unavailable. See attachments.json in the ZIP.`);
      } else downloadBlob(`${exportName}.${format}`, blob);
      log('success', `Export complete: ${conversations.length} conversations, ${messageCount} messages.`);
    } catch (error) { if (!stopped()) log('error', error?.message || error); }
    finally { activeExportController = null; setCleanupBusy(false, stopId); setStopped(false); }
  };
  $('#dmd-export-conversation').onclick = () => exportConversations({
    targets: () => {
      const guildId = $('#dmd-guild').value.trim();
      if (!guildId) return [];
      return parseIdList($('#dmd-channel').value, 'Channel(s)', { required: true }).map(channelId => ({ guildId, channelId, label: currentLabel() }));
    },
    stopId: '#dmd-stop', stopped: () => runState.stopped, setStopped: value => { runState.stopped = value; },
    progress: setProgress, filename: `conversation-${currentLabel()}`,
  });
  $('#dmd-multi-export').onclick = () => exportConversations({
    targets: () => queue.getItems().filter(item => !['ids', 'server'].includes(item.kind)).map(item => ({ ...item })),
    stopId: '#dmd-multi-stop', stopped: () => runState.multiStopped, setStopped: value => { runState.multiStopped = value; },
    progress: (value, max) => setMultiProgress(value, max, `Exported ${value}/${max}`), filename: 'queue-conversations', select: true,
  });
  $('#dmd-forum-export').onclick = () => exportConversations({
    targets: () => selectedThreads().map(thread => ({ guildId: thread.guild_id, channelId: thread.id, label: thread.name || thread.id })),
    stopId: '#dmd-forum-stop', stopped: () => runState.stopped, setStopped: value => { runState.stopped = value; },
    progress: (value, max) => {
      $('#dmd-progress').max = max; $('#dmd-progress').value = value;
      updatePercentage('#dmd-progress', '#dmd-pct');
      $('#dmd-forum-status').textContent = `Exported ${value}/${max}`;
    }, filename: 'forum-conversations',
  });
  $('#dmd-stop').onclick = () => { runState.stopped = true; activeExportController?.abort(); log('warn', 'Stop requested...'); };
  $('#dmd-rx-stop').onclick = () => { runState.reactionStopped = true; log('warn', 'Stop requested...'); };

  for (const side of ['after', 'before']) {
    $(`#dmd-${side}-kind`).onchange = () => {
      const date = $(`#dmd-${side}-kind`).value === 'date';
      $(`#dmd-${side}-date-field`).hidden = !date;
      $(`#dmd-${side}-id-field`).hidden = date;
    };
    $(`#dmd-${side}-kind`).onchange();
  }
  const queueMessageTargets = async (requestedChannels = null) => {
    try {
      fillContext();
      if (messageMode === 'server') {
        const guildId = $('#dmd-guild').value.trim();
        if (!/^\d{15,22}$/.test(guildId)) throw new Error('Enter a server ID in Server.');
        const guild = await queueIdentities.readGuild(guildId, $('#dmd-token').value.trim(), log);
        return await offerQueue([{ kind: 'server', guildId, channelId: `server:${guildId}`, label: guild.name || guildId }], getCleanupOptions(''));
      }
      const context = currentContext();
      const items = (requestedChannels || parseIdList($('#dmd-channel').value, 'Channel(s)', { required: true })).map(channelId => ({
        guildId: $('#dmd-guild').value.trim(), channelId,
        label: context?.channelId === channelId ? currentLabel() : channelId,
        thread: messageMode === 'thread',
      }));
      return await offerQueue(items, getCleanupOptions(''), messageMode === 'thread');
    } catch (error) { return log('error', error.message); }
  };
  $('#dmd-add-queue').onclick = () => queueMessageTargets();

  $('#dmd-start').onclick = async (_event, requestedChannels = null) => {
    fillContext();
    if (cleanupBusy) return queueMessageTargets(requestedChannels);
    setCleanupBusy(true, '#dmd-stop');
    runState.stopped = false;
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.stopped) return;
      if (messageMode === 'server') {
        const guildId = $('#dmd-guild').value.trim();
        if (!/^\d{15,22}$/.test(guildId)) throw new Error('Enter a server ID in Server.');
        await deleteMessages({ ...getCleanupOptions(''), guildId, token: identity.token, authorId: identity.user.id,
          log, progress: setProgress, stopCheck: () => runState.stopped });
        return;
      }
      const channels = (requestedChannels || parseIdList($('#dmd-channel').value, 'Channel(s)', { required: true }));
      const options = channels.map(channelId => getCleanupOptions(channelId));
      const targets = [];
      for (const channelId of channels) {
        targets.push(await resolveConversation({ token: identity.token, channelId, log, stopCheck: () => runState.stopped }));
      }
      if (runState.stopped) return;
      const forum = targets.find(target => target.mode === 'forums');
      if (forum) {
        if (targets.length !== 1) throw new Error('Browse one forum at a time to select its threads.');
        messageMode = 'forums'; fillAutomatic('#dmd-forum-id', forum.channelId); syncViews();
        $('#dmd-stop').disabled = true; $('#dmd-forum-stop').disabled = false;
        await loadForumTargets(identity, forum.channelId);
        log('info', 'Select threads, then press Clean selected threads.'); return;
      }
      messageMode = targets[0].mode; syncViews();
      for (const [index, target] of targets.entries()) {
        if (runState.stopped) break;
        const { channelId, guildId, mode } = target;
        const result = await (mode === 'thread' ? cleanupForumThread : deleteMessages)({ ...options[index], allowAnyThread: mode === 'thread', token: identity.token, authorId: identity.user.id, guildId, channelId,
          log, progress: setProgress, stopCheck: () => runState.stopped });
        if (!result?.done || result.failed > 0) break;
      }
    } catch (error) { log('error', error?.message || error); }
    finally { setCleanupBusy(false, '#dmd-stop'); $('#dmd-forum-stop').disabled = true; runState.stopped = false; }
  };

  const singleChannel = () => { const channels = parseIdList($('#dmd-channel').value, 'Channel(s)'); return channels.length === 1 ? channels[0] : ''; };
  const limitedIdTargets = targets => {
    if (targets.length > MAX_MESSAGE_IDS) throw new Error(`Use at most ${MAX_MESSAGE_IDS} message IDs per batch. Split larger imports into smaller files.`);
    return targets;
  };
  let idCountTimer;
  const updateIdCount = () => {
    clearTimeout(idCountTimer);
    try {
      const targets = parseMessageIds($('#dmd-id-input').value, singleChannel() || '000000000000000');
      $('#dmd-id-count').textContent = `${targets.length.toLocaleString()} IDs`;
    } catch (error) { $('#dmd-id-count').textContent = error.message; }
  };
  $('#dmd-id-input').addEventListener('input', () => {
    clearTimeout(idCountTimer); idCountTimer = setTimeout(updateIdCount, 150);
  });
  const importIds = async files => {
    if (cleanupBusy) return;
    $('#dmd-id-import').disabled = true; $('#dmd-id-package').disabled = true;
    try {
      if (!files?.length) return;
      const targets = await importMessageIds(files, singleChannel());
      const input = $('#dmd-id-input');
      const existing = parseMessageIds(input.value, singleChannel() || '000000000000000');
      const keys = new Set(existing.map(target => `${target.channelId}/${target.messageId}`));
      const additions = targets.filter(target => !keys.has(`${target.channelId}/${target.messageId}`));
      limitedIdTargets([...existing, ...additions]);
      const appended = additions.map(target => `https://discord.com/channels/@me/${target.channelId}/${target.messageId}`).join('\n');
      const next = input.value + (input.value && appended ? '\n' : '') + appended;
      parseMessageIds(next, singleChannel() || '000000000000000');
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      updateIdCount();
      log('success', `Loaded ${targets.length} message IDs locally. No messages were changed.`);
    } catch (error) { log('error', error?.message || error); }
    finally {
      $('#dmd-id-import').disabled = cleanupBusy; $('#dmd-id-package').disabled = cleanupBusy;
      $('#dmd-id-files').value = ''; $('#dmd-id-folder').value = '';
    }
  };
  $('#dmd-id-import').onclick = () => $('#dmd-id-files').click();
  $('#dmd-id-package').onclick = () => $('#dmd-id-folder').click();
  $('#dmd-id-files').onchange = event => importIds(event.target.files);
  $('#dmd-id-folder').onchange = event => importIds(event.target.files);
  $('#dmd-id-clear').onclick = () => {
    $('#dmd-id-input').value = ''; updateIdCount();
  };
  $('#dmd-id-stop').onclick = () => { runState.stopped = true; log('warn', 'Stop requested...'); };
  $('#dmd-id-start').onclick = async () => {
    if (cleanupBusy) { try { const targets = limitedIdTargets(parseMessageIds($('#dmd-id-input').value, singleChannel())); return await offerQueue([], getCleanupOptions(''), false, targets); } catch (error) { return log('error', error.message); } }
    setCleanupBusy(true, '#dmd-id-stop'); runState.stopped = false;
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.stopped) return;
      const targets = limitedIdTargets(parseMessageIds($('#dmd-id-input').value, singleChannel()));
      const options = getCleanupOptions('');
      await runDirectMessages({ ...options, token: identity.token, authorId: identity.user.id, targets, log,
        stopCheck: () => runState.stopped, progress: (value, max, phase) => {
          $('#dmd-id-progress').max = Math.max(1, max); $('#dmd-id-progress').value = value;
          updatePercentage('#dmd-id-progress', '#dmd-id-pct');
          $('#dmd-id-status').textContent = `${phase}: ${value}/${max}`;
        } });
    } catch (error) { log('error', error?.message || error); }
    finally { setCleanupBusy(false, '#dmd-id-stop'); runState.stopped = false; }
  };

  $('#dmd-rx-start-kind').onchange = () => {
    const date = $('#dmd-rx-start-kind').value === 'date';
    $('#dmd-rx-start-id-field').hidden = date;
    $('#dmd-rx-start-date-field').hidden = !date;
  };
  $('#dmd-rx-go').onclick = async () => {
    if (cleanupBusy) return log('warn', 'Wait for the current cleanup to finish before removing reactions.');
    setCleanupBusy(true, '#dmd-rx-stop'); $('#dmd-rx-go').disabled = true;
    runState.reactionStopped = false;
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.reactionStopped) return;
      fillContext();
      const channels = parseIdList($('#dmd-rx-channel').value.trim() || $('#dmd-channel').value, 'Channel(s)', { required: true });
      const limit = Math.max(1, Math.min(MAX_REACTION_SCAN, parseInt($('#dmd-rx-limit').value, 10) || 1000));
      for (const channelId of channels) {
        if (runState.reactionStopped) break;
        await removeReactions({ token: identity.token, channelId, startId: ($('#dmd-rx-start-kind').value === 'date' ? $('#dmd-rx-start-date') : $('#dmd-rx-start')).value.trim(), scanLimit: limit,
          reactionAuthorId: $('#dmd-rx-author').value.trim(), reactionIds: $('#dmd-rx-filter').value, skipOwn: $('#dmd-rx-skipown').checked, authorId: identity.user.id, log,
          progress: (v, m, phase) => { $('#dmd-rx-progress').max = Math.max(1, m); $('#dmd-rx-progress').value = v; updatePercentage('#dmd-rx-progress', '#dmd-rx-pct'); $('#dmd-rx-phase').textContent = `${phase || ''} ${v}/${m}`; } });
      }
    } catch (error) { log('error', error?.message || error); }
    finally { setCleanupBusy(false, '#dmd-rx-stop'); $('#dmd-rx-go').disabled = false; runState.reactionStopped = false; }
  };

  const addServer = async guildId => {
    try {
      if (!/^\d{15,22}$/.test(guildId || '')) throw new Error('Enter a valid Server ID or open a server channel.');
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity) return;
      const guild = await queueIdentities.readGuild(guildId, identity.token, log);
      $('#dmd-server-id').value = guildId;
      queueServerPreview.seedGuild(guild);
      void queueServerPreview.refresh('guild');
      await offerQueue([{ kind: 'server', guildId, channelId: `server:${guildId}`, label: guild.name || `Server ${guildId}` }], getCleanupOptions(''));
    } catch (error) { log('error', error.message); }
  };
  $('#dmd-server-add').onclick = () => addServer($('#dmd-server-id').value.trim());
  $('#dmd-server-current').onclick = () => addServer(currentContext()?.guildId);
  $('#dmd-multi-clear').onclick = async () => {
    if (queue.getItems().length) {
      const approved = await askPopup({ title: 'Clear queue?', message: `Remove all ${queue.getItems().length} queued conversations?`, yesText: 'Clear', noText: 'Cancel', danger: true });
      if (!approved) return;
    }
    queue.clear(); setMultiProgress(0, 1, '');
  };
  $('#dmd-multi-stop').onclick = () => { runState.multiStopped = true; activeExportController?.abort(); log('warn', 'Stopping queue...'); };
  $('#dmd-multi-start').onclick = async () => {
    if (cleanupBusy) return log('info', 'The queue will continue automatically as jobs are added.');
    if (!queue.getItems().length) return log('error', 'The queue is empty.');
    setCleanupBusy(true, '#dmd-multi-stop'); runState.multiStopped = false;
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.multiStopped) return;
      const options = getCleanupOptions('');
      let completed = 0, activeItem = null;
      refreshRunningQueue = () => {
        const total = completed + queue.getItems().length;
        setMultiProgress(completed, total, activeItem ? `Running ${completed + 1}/${total}: ${cleanQueueLabel(activeItem.label) || activeItem.channelId}` : `Finished ${completed}/${total}`);
      };
      refreshRunningQueue();
      while (queue.getItems().length || queuePromptOpen) {
        if (runState.multiStopped) break;
        if (!queue.getItems().length) { await queuePromptDone; continue; }
        const item = { ...queue.getItems()[0] }; activeItem = item; refreshRunningQueue();
        const itemOptions = item.options ? normalizeCleanupOptions(item.options) : options;
        let detected;
        if (item.detectConversation && item.kind !== 'ids') {
          detected = await resolveConversation({ token: identity.token, channelId: item.channelId, log, stopCheck: () => runState.multiStopped });
          if (detected.mode === 'forums') throw new Error('Open this forum in Messages and select its threads before queuing cleanup.');
        }
        const result = await (item.kind === 'ids' ? runDirectMessages : (detected ? detected.mode === 'thread' : item.thread) ? cleanupForumThread : deleteMessages)({ ...itemOptions, freshHistory: true, token: identity.token, authorId: identity.user.id,
          guildId: detected?.guildId || item.guildId, channelId: ['ids', 'server'].includes(item.kind) ? undefined : item.channelId, targets: item.targets, allowAnyThread: detected ? detected.mode === 'thread' : item.allowAnyThread,
          skipConfirm: true, log, stopCheck: () => runState.multiStopped });
        if (result?.unauthorized) { runState.multiStopped = true; break; }
        if (result?.cancelled || result?.stopped || result?.stalled || result?.httpStatus) { runState.multiStopped = true; break; }
        if (!result?.done || result.failed > 0) { runState.multiStopped = true; break; }
        completed++; activeItem = null;
        queue.completeItem(item);
        refreshRunningQueue();
        if (queue.getItems().length && !runState.multiStopped) await sleep(rand(1400, 2400));
      }
      log(runState.multiStopped ? 'warn' : 'success', runState.multiStopped ? 'Queue stopped.' : `Finished all ${completed} queued items.`);
    } catch (error) { log('error', error?.message || error); }
    finally { refreshRunningQueue = null; setCleanupBusy(false, '#dmd-multi-stop'); runState.multiStopped = false; }
  };

  const forumTargetValue = () => {
    const forum = $('#dmd-forum-id').value.trim();
    return forum && forum !== automaticFields.get('#dmd-forum-id') ? forum : $('#dmd-channel').value.trim() || forum;
  };
  let forumThreads = [];
  let forumThreadsById = new Map();
  const selectedThreads = () => [...$('#dmd-forum-list').selectedOptions]
    .map(option => forumThreadsById.get(option.value)).filter(Boolean);
  const loadForumTargets = async (identity, forumId) => {
    forumThreads = []; forumThreadsById.clear(); $('#dmd-forum-list').textContent = '';
    forumThreads = await listForumThreads({ token: identity.token, forumId,
      includeArchived: $('#dmd-forum-archived').checked, log, stopCheck: () => runState.stopped });
    forumThreadsById = new Map(forumThreads.map(thread => [thread.id, thread]));
    const fragment = document.createDocumentFragment();
    for (const thread of forumThreads) {
      const option = document.createElement('option'); option.value = thread.id;
      option.textContent = `${thread.name || thread.id}${thread.thread_metadata?.archived ? ' · archived' : ''}${thread.thread_metadata?.locked ? ' · locked' : ''}`;
      fragment.appendChild(option);
    }
    $('#dmd-forum-list').appendChild(fragment);
    $('#dmd-forum-status').textContent = `${forumThreads.length} threads loaded`;
  };
  $('#dmd-forum-stop').onclick = () => { runState.stopped = true; activeExportController?.abort(); log('warn', 'Stop requested...'); };
  $('#dmd-forum-load').onclick = async () => {
    if (cleanupBusy) return;
    setCleanupBusy(true, '#dmd-forum-stop'); runState.stopped = false;
    forumThreads = []; forumThreadsById.clear(); $('#dmd-forum-list').textContent = '';
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.stopped) return;
      fillContext();
      const forumId = forumTargetValue();
      const target = await resolveConversation({ token: identity.token, channelId: forumId, log, stopCheck: () => runState.stopped });
      messageMode = target.mode; syncViews();
      if (target.mode !== 'forums') {
        if ($('#dmd-channel').value.trim() !== target.channelId && $('#dmd-channel').value.trim() && $('#dmd-channel').value !== automaticFields.get('#dmd-channel')) {
          log('warn', 'The forum field targets a different conversation. Update Channel(s) to use this target.'); return;
        }
        fillAutomatic('#dmd-channel', target.channelId);
        log('info', 'Conversation detected. Press Start to preview its matching messages.'); return;
      }
      await loadForumTargets(identity, target.channelId);
    } catch (error) { $('#dmd-forum-status').textContent = 'No thread list loaded'; log('error', error?.message || error); }
    finally { setCleanupBusy(false, '#dmd-forum-stop'); runState.stopped = false; }
  };
  $('#dmd-forum-queue').onclick = async () => {
    const threads = selectedThreads();
    if (!threads.length) return log('warn', 'Select at least one forum thread.');
    try { await offerQueue(threads.map(thread => ({ guildId: thread.guild_id, channelId: thread.id, label: `Thread: ${thread.name || thread.id}`, thread: true })), getCleanupOptions(''), true); } catch (error) { log('error', error.message); }
  };
  $('#dmd-forum-run').onclick = async () => {
    if (cleanupBusy && !selectedThreads().length) {
      try { fillContext(); return await $('#dmd-start').onclick(null, parseIdList(forumTargetValue(), 'Conversation IDs', { required: true })); } catch (error) { return log('error', error.message); }
    }
    if (cleanupBusy) { try { return await offerQueue(selectedThreads().map(thread => ({ guildId: thread.guild_id, channelId: thread.id, label: `Thread: ${thread.name || thread.id}`, thread: true })), getCleanupOptions('')); } catch (error) { return log('error', error.message); } }
    const threads = selectedThreads();
    if (!threads.length) {
      try {
        fillContext();
        const targetIds = forumTargetValue();
        return await $('#dmd-start').onclick(null, targetIds ? parseIdList(targetIds, 'Conversation IDs', { required: true }) : null);
      } catch (error) { return log('error', error.message); }
    }
    setCleanupBusy(true, '#dmd-forum-stop'); runState.stopped = false;
    try {
      const identity = await resolveToken($('#dmd-token').value.trim()) || await loadIdentity();
      if (!identity || runState.stopped) return;
      const options = getCleanupOptions('');
      $('#dmd-progress').max = threads.length; $('#dmd-progress').value = 0;
      updatePercentage('#dmd-progress', '#dmd-pct');
      for (const [index, thread] of threads.entries()) {
        if (runState.stopped) break;
        $('#dmd-forum-status').textContent = `${index + 1}/${threads.length}: ${thread.name || thread.id}`;
        const result = await cleanupForumThread({ ...options, guildId: thread.guild_id, channelId: thread.id,
          token: identity.token, authorId: identity.user.id, log, stopCheck: () => runState.stopped });
        if (result.unauthorized || result.cancelled || result.stopped) break;
        $('#dmd-progress').value = index + 1;
        updatePercentage('#dmd-progress', '#dmd-pct');
      }
    } catch (error) { log('error', error?.message || error); }
    finally { setCleanupBusy(false, '#dmd-forum-stop'); runState.stopped = false; }
  };

  let lastUrl = location.href;
  let mountQueued = false;

  const toolbarButtonHealthy = () =>
    btn.isConnected &&
    btn.parentElement?.isConnected &&
    btn.offsetParent !== null;

  const scheduleMount = () => {
    if (mountQueued) return;
    mountQueued = true;
    requestAnimationFrame(() => {
      mountQueued = false;
      if (!toolbarButtonHealthy()) mountToolbarButton();
    });
  };

  const handleRouteChange = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    fillContext();
    void detectVisibleConversation();
  };

  observeDiscordPage(() => {
    handleRouteChange();
    if (!toolbarButtonHealthy()) scheduleMount();
  });

  window.addEventListener('popstate', handleRouteChange, { passive: true });
  window.addEventListener('hashchange', handleRouteChange, { passive: true });

  mountToolbarButton();
  fillContext();
}
