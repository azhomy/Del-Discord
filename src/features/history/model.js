// Del-Discord v1 — personal source modules.

export const historyIndexes = new WeakMap();
const revisions = new WeakMap();

export const historyRevision = map => revisions.get(map) || 0;
const changed = map => revisions.set(map, historyRevision(map) + 1);

export function indexesFor(map) {
  let indexes = historyIndexes.get(map);
  if (indexes) return indexes;

  indexes = {
    byUser: new Map(),
    byChannel: new Map()
  };

  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value?.userId) indexes.byUser.set(value.userId, key);
    if (value?.channelId) indexes.byChannel.set(value.channelId, key);
  }

  historyIndexes.set(map, indexes);
  return indexes;
}

export function merge(map, incoming) {
  const indexes = indexesFor(map);

  const userKey =
    incoming.userId
      ? indexes.byUser.get(incoming.userId)
      : '';

  const channelKey =
    incoming.channelId
      ? indexes.byChannel.get(incoming.channelId)
      : '';

  const oldKey = userKey || channelKey || '';
  const key =
    incoming.userId
      ? `u:${incoming.userId}`
      : (
        incoming.channelId
          ? `c:${incoming.channelId}`
          : ''
      );

  if (!key) return;

  const previous = oldKey ? (map[oldKey] || {}) : (map[key] || {});

  const merged = {
    userId: incoming.userId || previous.userId || '',
    channelId: incoming.channelId || previous.channelId || '',
    name: incoming.name || previous.name || '',
    username: incoming.username || previous.username || '',
    avatar: incoming.avatar || previous.avatar || '',
    dmRank: Number.isFinite(incoming.dmRank)
      ? incoming.dmRank
      : (
        Number.isFinite(previous.dmRank)
          ? previous.dmRank
          : null
      ),
    sources: [...new Set([...(previous.sources || []), ...(incoming.sources || [])])],
    seenAt: incoming.seenAt || previous.seenAt || new Date().toISOString(),
    sentCount: Math.max(
      Number.isFinite(previous.sentCount) ? previous.sentCount : 0,
      Number.isFinite(incoming.sentCount) ? incoming.sentCount : 0
    ),
    sentCountExact: incoming.sentCountExact === true || previous.sentCountExact === true,
    verifiedSent: incoming.verifiedSent === true || previous.verifiedSent === true
  };

  if (oldKey && oldKey !== key) delete map[oldKey];
  // Replacing an identifier must retire its old lookup even when the map key
  // stays the same (for example, a user's channel ID is updated).
  if (previous.userId && previous.userId !== merged.userId && indexes.byUser.get(previous.userId) === oldKey) indexes.byUser.delete(previous.userId);
  if (previous.channelId && previous.channelId !== merged.channelId && indexes.byChannel.get(previous.channelId) === oldKey) indexes.byChannel.delete(previous.channelId);

  map[key] = merged;

  if (merged.userId) indexes.byUser.set(merged.userId, key);
  if (merged.channelId) indexes.byChannel.set(merged.channelId, key);
  changed(map);
  return merged;
}

export function removeHistoryMatch(map, userId, channelId) {
  const indexes = indexesFor(map);
  const keys = new Set();

  if (userId) {
    const key = indexes.byUser.get(userId);
    if (key) keys.add(key);
  }

  if (channelId) {
    const key = indexes.byChannel.get(channelId);
    if (key) keys.add(key);
  }

  for (const key of keys) {
    const value = map[key];
    if (!value) continue;

    if (value.userId) indexes.byUser.delete(value.userId);
    if (value.channelId) indexes.byChannel.delete(value.channelId);
    delete map[key];
    changed(map);
  }
}

export function recipientIds(obj, out = []) {
  if (typeof obj === 'string' && /^\d{15,22}$/.test(obj)) out.push(obj);
  else if (Array.isArray(obj)) obj.forEach(v => recipientIds(v, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) if (/recipient|user|member|participant/i.test(k)) recipientIds(v, out);
  }
  return out;
}
