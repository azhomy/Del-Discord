import { apiFetch, RunStoppedError, RateLimitError } from '../discord/api.js';
import { safeFilePart } from '../utils/files.js';
import { waitWithSignal } from '../utils/abort.js';
import { sleep } from '../utils/timing.js';
import { ZipCapacityError } from '../utils/zip.js';

// One state per export, shared across all selected conversations.
export const createAttachmentDownloadState = () => ({ cache: new Map(), failedUrls: new Map(), consecutiveFailures: 0, suspendedReason: '' });

function* snapshotAttachmentSources(message, prefix = '', sourcePrefix = '') {
  for (const [index, snapshot] of (message.message_snapshots || []).entries()) {
    yield { attachments: snapshot.message?.attachments || [], prefix: `${prefix}snapshots/${index + 1}/`, source: `${sourcePrefix}message_snapshots[${index}].message.attachments` };
  }
}

function* messageAttachmentEntries(message) {
  const raw = message.raw || message;
  const sources = [{ attachments: raw.attachments || message.attachments || [], prefix: '', source: 'attachments' }, ...snapshotAttachmentSources(raw)];
  // A thread starter carries its content in the referenced parent message.
  // Ordinary replies may reference messages outside the selected export range.
  if (raw.type === 21 && raw.referenced_message) {
    sources.push({ attachments: raw.referenced_message.attachments || [], prefix: 'referenced-message/', source: 'referenced_message.attachments' });
    sources.push(...snapshotAttachmentSources(raw.referenced_message, 'referenced-message/', 'referenced_message.'));
  }
  for (const { attachments, prefix, source } of sources) {
    for (const [index, attachment] of attachments.entries()) yield { attachment, index, prefix, source };
  }
}

export async function collectExportAttachments(conversation, { files, report, log, stopCheck = () => false, state = createAttachmentDownloadState(), signal, budget }) {
  const check = () => { if (stopCheck() || signal?.aborted) throw new RunStoppedError(); };
  let yieldedAt = performance.now();
  for (const message of conversation.messages) {
    check();
    if (performance.now() - yieldedAt >= 8) { await sleep(0); check(); yieldedAt = performance.now(); }
    for (const { attachment, index, prefix, source } of messageAttachmentEntries(message)) {
      check();
      if (performance.now() - yieldedAt >= 8) { await sleep(0); check(); yieldedAt = performance.now(); }
      const extension = String(attachment.filename || '').match(/\.[a-z0-9]{1,16}$/i)?.[0] || '';
      const filename = safeFilePart(Array.from(String(attachment.filename || '')).filter(char => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127).join('')).replace(/^\.+|\.+$/g, '') || 'file';
      const filePart = extension ? filename.replace(new RegExp(extension.replace('.', '\\.') + '$', 'i'), '').slice(0, 80 - extension.length) + extension : filename;
      const name = `attachments/${safeFilePart(conversation.channelId)}/${safeFilePart(message.id)}/${prefix}${index + 1}-${filePart}`;
      const record = { channelId: conversation.channelId, messageId: message.id, attachmentId: attachment.id || null,
        filename: attachment.filename || '', url: attachment.url || null, path: name, source };
      let cacheKey, failedKey;
      try {
        const url = new URL(attachment.url);
        if (url.protocol !== 'https:') throw new Error('Missing or invalid HTTPS attachment URL.');
        const discordCdn = ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname);
        const canonical = new URL(url); canonical.hash = '';
        if (discordCdn) for (const key of ['ex', 'is', 'hm']) canonical.searchParams.delete(key);
        canonical.searchParams.sort();
        cacheKey = canonical.href;
        failedKey = url.href;
        const cached = state.cache.get(cacheKey) || state.failedUrls.get(failedKey);
        if (cached) {
          report.push({ ...record, ...cached, status: cached.status === 'downloaded' ? 'reused' : cached.status });
          continue;
        }
        if (state.suspendedReason) {
          report.push({ ...record, path: null, status: 'skipped', error: state.suspendedReason });
          continue;
        }
        budget?.checkFile(name, Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : 0);
        log('verb', `Downloading attachment: ${attachment.filename || name}`);
        // CDN downloads must never receive the Discord authorization token or cookies.
        const response = await apiFetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal }, log, stopCheck, { minIntervalMs: 1000 });
        check();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const length = Number(response.headers.get('Content-Length'));
        if (Number.isSafeInteger(length) && length >= 0) {
          try { budget?.checkFile(name, length); }
          catch (error) { response.body?.cancel().catch(() => {}); throw error; }
        }
        const blob = await waitWithSignal(response.blob(), signal);
        check();
        budget?.setFile(name, blob.size);
        files.push({ name, blob });
        const result = { path: name, status: 'downloaded', size: blob.size };
        state.cache.set(cacheKey, result); state.consecutiveFailures = 0;
        report.push({ ...record, ...result });
      } catch (error) {
        check();
        if (error instanceof RunStoppedError || error instanceof ZipCapacityError) throw error;
        const failure = { path: null, status: 'failed', error: String(error.message || error) };
        if (failedKey) state.failedUrls.set(failedKey, failure);
        report.push({ ...record, ...failure });
        state.consecutiveFailures++;
        if (error instanceof RateLimitError || state.consecutiveFailures >= 3) {
          state.suspendedReason = error instanceof RateLimitError ? error.message : 'Three consecutive attachment failures. Further attachment requests stopped for this export.';
          log('warn', state.suspendedReason);
        }
        log('warn', `Attachment unavailable: ${attachment.filename || name} (${error.message || error}).`);
      }
    }
  }
}
