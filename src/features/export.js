// Del-Discord v1 — personal source modules.
import { toSnowflake } from '../utils/messages.js';
import { API } from '../config.js';
import { apiFetch, RunStoppedError } from '../discord/api.js';
import { invalidateAuth } from '../discord/deleter-auth.js';
import { sleep } from '../utils/timing.js';
import { waitWithSignal } from '../utils/abort.js';
import { compareMessageIds } from './message-filters.js';

export function compactReferencedMessage(message) {
  if (!message) return null;
  return {
    id: message.id || null,
    timestamp: message.timestamp || null,
    content: message.content || '',
    author: message.author ? {
      id: message.author.id || null,
      username: message.author.username || '',
      globalName: message.author.global_name || null,
      bot: !!message.author.bot
    } : null
  };
}

export function compactExportMessage(message) {
  return {
    // Keep the original response, including fields added by Discord in future.
    raw: message,
    id: message.id,
    timestamp: message.timestamp,
    editedTimestamp: message.edited_timestamp || null,
    type: message.type,
    pinned: !!message.pinned,
    content: message.content || '',
    author: message.author ? {
      id: message.author.id || null,
      username: message.author.username || '',
      globalName: message.author.global_name || null,
      discriminator: message.author.discriminator || null,
      bot: !!message.author.bot
    } : null,
    attachments: (message.attachments || []).map(a => ({
      id: a.id,
      filename: a.filename,
      description: a.description || null,
      contentType: a.content_type || null,
      size: a.size || 0,
      url: a.url,
      proxyUrl: a.proxy_url || null,
      width: a.width || null,
      height: a.height || null
    })),
    embeds: message.embeds || [],
    reactions: (message.reactions || []).map(r => ({
      count: r.count,
      emoji: r.emoji,
      me: !!r.me
    })),
    mentions: (message.mentions || []).map(u => ({
      id: u.id,
      username: u.username || '',
      globalName: u.global_name || null
    })),
    referencedMessage: compactReferencedMessage(message.referenced_message)
  };
}

export function validateExportRange({ minId = '', maxId = '' } = {}) {
  minId = String(minId).trim(); maxId = String(maxId).trim();
  const boundary = value => {
    const id = toSnowflake(value);
    if (value && (!id || !/^\d+$/.test(id))) throw new Error('Enter a valid date/time or message ID.');
    return id;
  };
  const after = boundary(minId), before = boundary(maxId);
  if (after && before && BigInt(after) >= BigInt(before)) throw new Error('After must be earlier than Before.');
  return { minId, maxId };
}

export async function exportConversationData({ token, guildId, channelId, minId, maxId, label, log, stopCheck = () => false, signal }) {
  ({ minId, maxId } = validateExportRange({ minId, maxId }));
  const afterSnowflake = minId ? toSnowflake(minId) : '';
  let beforeSnowflake = maxId ? toSnowflake(maxId) : '';
  let afterBig = null;
  try { if (afterSnowflake) afterBig = BigInt(afterSnowflake); } catch {}

  const messages = [];
  let page = 0;

  log('info', `Exporting conversation ${label || channelId}...`);

  while (!stopCheck()) {
    const url = `${API}/channels/${channelId}/messages?limit=100${beforeSnowflake ? `&before=${beforeSnowflake}` : ''}`;
    let response;
    try {
      response = await apiFetch(url, { headers: { Authorization: token }, signal }, log, stopCheck, { minIntervalMs: 1000 });
    } catch (error) {
      if (error instanceof RunStoppedError) break;
      throw error;
    }
    if (stopCheck()) break;

    if (response.status === 401) {
      invalidateAuth();
      throw new Error('Discord rejected the authorization token while exporting.');
    }
    if (response.status === 403) throw new Error('Discord denied access to this conversation.');
    if (!response.ok) throw new Error(`Conversation export failed with HTTP ${response.status}.`);

    const batch = await waitWithSignal(response.json(), signal);
    if (stopCheck()) break;
    if (!Array.isArray(batch)) throw new Error('Discord returned an invalid message page. Export stopped.');
    if (!batch.length) break;

    page++;
    const beforeBig = beforeSnowflake ? BigInt(beforeSnowflake) : null;
    const seen = new Set();
    let oldest = null;
    let reachedAfter = false;

    for (const message of batch) {
      if (typeof message?.id !== 'string' || !/^\d+$/.test(message.id)) throw new Error('Discord returned a malformed message. Export stopped.');
      let idBig = null;
      try { idBig = BigInt(message.id); } catch {}
      if (idBig === null) continue;
      if (beforeBig !== null && idBig >= beforeBig) continue;
      if (afterBig !== null && idBig <= afterBig) {
        reachedAfter = true;
        continue;
      }
      if (!seen.has(message.id)) {
        seen.add(message.id);
        messages.push(compactExportMessage(message));
      }
      if (oldest === null || idBig < oldest) oldest = idBig;
    }

    log('verb', `Export page ${page}: ${messages.length} messages collected.`);

    if (reachedAfter) break;
    if (oldest === null) throw new Error('Message pagination did not advance. Export stopped to avoid saving incomplete history.');
    beforeSnowflake = oldest.toString();
  }

  messages.sort((a, b) => compareMessageIds(a.id, b.id));

  return {
    exportedAt: new Date().toISOString(),
    guildId,
    channelId,
    label: label || '',
    range: {
      after: minId || null,
      before: maxId || null
    },
    messageCount: messages.length,
    messages
  };
}

const csvColumns = ['guildId', 'channelId', 'conversation', 'id', 'timestamp', 'editedTimestamp', 'authorId', 'username', 'content', 'type', 'pinned', 'attachments', 'embeds', 'reactions', 'mentions', 'referencedMessage', 'messageData'];
const nestedColumns = ['attachments', 'embeds', 'reactions', 'mentions', 'referencedMessage'];
const csvCell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';

function* conversationCsvRows(conversations, includeHeader = true) {
  if (includeHeader) yield csvColumns.map(csvCell).join(',');
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      yield [conversation.guildId, conversation.channelId, conversation.label, message.id, message.timestamp,
        message.editedTimestamp, message.author?.id, message.author?.username, message.content, message.type,
        message.pinned, ...nestedColumns.map(key => JSON.stringify(message[key] ?? null)),
        JSON.stringify(message.raw ?? message)].map(csvCell).join(',');
    }
  }
}

export function conversationsToCsv(conversations) {
  return [...conversationCsvRows(conversations)].join('\r\n');
}

function* conversationJsonParts(conversation) {
  const { messages, ...metadata } = conversation;
  const wrapper = JSON.stringify({ ...metadata, messages: [] }, null, 2);
  yield wrapper.slice(0, -4) + '[\n';
  for (let index = 0; index < messages.length; index++) {
    yield (index ? ',\n' : '') + '    ' + JSON.stringify(messages[index]);
  }
  yield '\n  ]\n}';
}

function* conversationCsvParts(conversation, includeHeader) {
  let first = true;
  for (const row of conversationCsvRows([conversation], includeHeader)) {
    yield (first ? '' : '\r\n') + row;
    first = false;
  }
}

// Serialize one conversation at a time. Blob chunks release large temporary
// strings and the event loop gets a turn during long exports.
export async function conversationToBlob(conversation, { format = 'json', includeCsvHeader = true, stopCheck = () => false } = {}) {
  const parts = format === 'csv' ? conversationCsvParts(conversation, includeCsvHeader) : conversationJsonParts(conversation);
  const blobs = [];
  let chunks = [], size = 0, yieldedAt = performance.now();
  const checkStopped = () => { if (stopCheck()) throw new RunStoppedError(); };
  const flush = () => {
    blobs.push(new Blob([chunks.join('')]));
    chunks = []; size = 0;
  };
  checkStopped();
  for (const part of parts) {
    chunks.push(part); size += part.length;
    if (size < 65536) continue;
    checkStopped(); flush();
    if (performance.now() - yieldedAt >= 8) {
      await sleep(0);
      checkStopped(); yieldedAt = performance.now();
    }
  }
  checkStopped();
  if (chunks.length) flush();
  return new Blob(blobs, { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' });
}
