import { toSnowflake } from '../utils/messages.js';
import { compilePattern, matchesAssets } from './asset-filters.js';

export function normalizeCleanupOptions(options) {
  const action = options.action || 'delete';
  if (!['delete', 'overwrite', 'preserve'].includes(action)) throw new Error('Choose a valid message action.');
  const overwriteText = String(options.overwriteText ?? '');
  if (action === 'overwrite' && (!overwriteText.trim() || overwriteText.length > 2000)) {
    throw new Error('Replacement text must contain between 1 and 2,000 characters.');
  }
  const normalizeMode = (mode, fallback) => {
    const value = mode || fallback;
    if (!['any', 'with', 'without'].includes(value)) throw new Error('Invalid message filter.');
    return value;
  };
  const boundary = value => {
    const id = toSnowflake(value);
    if (value && (!id || !/^\d+$/.test(id))) throw new Error('Invalid message/date boundary.');
    return id;
  };
  const minId = boundary(options.minId);
  const maxId = boundary(options.maxId);
  if (minId && maxId && BigInt(minId) >= BigInt(maxId)) throw new Error('After must be earlier than Before.');
  const order = options.order || 'desc';
  if (!['asc', 'desc'].includes(order)) throw new Error('Invalid message order.');
  const textMode = options.textMode || 'include';
  if (!['include', 'exclude'].includes(textMode)) throw new Error('Invalid text filter.');
  const regexMode = options.regexMode || 'include';
  const assetMode = options.assetMode || 'include';
  if (![regexMode, assetMode].every(mode => ['include', 'exclude'].includes(mode))) throw new Error('Invalid pattern filter.');
  const extensions = (Array.isArray(options.extensions) ? options.extensions : String(options.extensions || '').split(/[\s,;]+/))
    .map(extension => String(extension).trim().replace(/^\*?\./, '').toLowerCase()).filter(Boolean);
  if (extensions.some(extension => !/^[a-z0-9_-]+$/.test(extension))) throw new Error('Use extensions such as png, jpg, or zip, separated by commas.');
  const textPattern = compilePattern(options.textRegex, options.regexFlags ?? 'i', 'Text regex');
  const assetPattern = compilePattern(options.assetRegex, options.assetRegexFlags ?? 'i', 'File/URL regex');
  return {
    ...options, action, overwriteText, order, textMode, minId, maxId,
    regexMode, assetMode, textPattern, assetPattern, extensions: [...new Set(extensions)],
    filename: String(options.filename || '').trim(), collectAll: options.collectAll === true,
    content: String(options.content || '').trim(),
    linkMode: normalizeMode(options.linkMode, options.hasLink ? 'with' : 'any'),
    fileMode: normalizeMode(options.fileMode, options.hasFile ? 'with' : 'any'),
    pinnedMode: normalizeMode(options.pinnedMode, options.includePinned ? 'any' : 'without'),
  };
}

export function matchesMessage(message, options) {
  if (!options.authorId || message.author?.id !== options.authorId) return false;
  if (options.authorIds?.length && !options.authorIds.includes(message.author?.id)) return false;
  if (options.channelId && message.channel_id !== options.channelId) return false;
  if (![0, 6, 19].includes(message.type)) return false;
  if (!/^\d+$/.test(String(message.id || ''))) return false;
  if (options.minId && compareMessageIds(message.id, options.minId) <= 0) return false;
  if (options.maxId && compareMessageIds(message.id, options.maxId) >= 0) return false;
  const matchMode = (mode, value) => mode === 'any' || (mode === 'with' ? value : !value);
  if (options.linkMode !== 'any') {
    const hasLink = /https?:\/\/\S+/i.test(message.content || '') || (message.embeds || []).some(embed => !!embed.url);
    if (!matchMode(options.linkMode, hasLink)) return false;
  }
  if (!matchMode(options.fileMode, !!message.attachments?.length)) return false;
  if (!matchMode(options.pinnedMode, !!message.pinned)) return false;
  if (options.content) {
    const contains = String(message.content || '').toLowerCase().includes(options.content.toLowerCase());
    if (options.textMode === 'exclude' ? contains : !contains) return false;
  }
  if (options.textPattern) {
    const matches = options.textPattern.test(String(message.content || ''));
    if (options.regexMode === 'exclude' ? matches : !matches) return false;
  }
  if (!matchesAssets(message, options)) return false;
  return true;
}

// Callers validate decimal IDs before sorting. Decimal length and lexical order
// compare snowflakes exactly without allocating BigInts for every comparison.
export function compareMessageIds(leftId, rightId) {
  const left = String(leftId), right = String(rightId);
  if (left === right) return 0;
  if (left[0] === '0' || right[0] === '0') {
    const a = BigInt(left), b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left.length === right.length ? (left < right ? -1 : 1) : (left.length < right.length ? -1 : 1);
}

export function sortMessages(messages, order) {
  const direction = order === 'asc' ? 1 : -1;
  return [...messages].sort((a, b) => direction * compareMessageIds(a.id, b.id));
}
