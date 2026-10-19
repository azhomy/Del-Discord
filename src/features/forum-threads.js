import { createMessageCollection } from './message-collection.js';
import { API } from '../config.js';
import { apiFetch, RunStoppedError } from '../discord/api.js';
import { rand, sleep } from '../utils/timing.js';
import { normalizeCleanupOptions, matchesMessage, compareMessageIds } from './message-filters.js';
import { emptyStats } from './message-actions.js';
import { runCollectedMessages } from './collected-messages.js';

async function readJson(url, options) {
  const response = await apiFetch(url, { headers: { Authorization: options.token } }, options.log, options.stopCheck);
  if (options.stopCheck?.()) throw new RunStoppedError();
  if (!response.ok) throw new Error(`Forum request failed (${response.status}). Check your access to this forum/thread.`);
  return response.json();
}

export async function listForumThreads({ token, forumId, includeArchived = true, log = () => {}, stopCheck = () => false }) {
  if (!/^\d{15,22}$/.test(String(forumId || ''))) throw new Error('Enter a valid forum channel ID.');
  const options = { token, log, stopCheck };
  const forum = await readJson(`${API}/channels/${forumId}`, options);
  if (![15, 16].includes(forum.type) || forum.id !== forumId || !forum.guild_id) throw new Error('Select a forum or media channel, rather than an individual thread.');
  const threads = new Map();
  const add = values => {
    if (!Array.isArray(values)) throw new Error('Discord returned an invalid thread list.');
    for (const thread of values) {
      if (thread.parent_id === forumId && thread.type === 11 && /^\d{15,22}$/.test(thread.id)) threads.set(thread.id, { ...thread, guild_id: forum.guild_id });
    }
  };
  const active = await readJson(`${API}/guilds/${forum.guild_id}/threads/active`, options);
  add(active.threads);
  if (includeArchived) {
    let before = '';
    while (!stopCheck()) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const archived = await readJson(`${API}/channels/${forumId}/threads/archived/public?${query}`, options);
      add(archived.threads);
      if (!archived.has_more) break;
      const times = archived.threads.map(thread => thread.thread_metadata?.archive_timestamp).filter(value => Number.isFinite(Date.parse(value)));
      const next = times.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      if (!next || (before && Date.parse(next) >= Date.parse(before))) throw new Error('Archived thread list did not advance. No incomplete list will be used.');
      before = next;
      await sleep(rand(900, 1500));
    }
  }
  if (stopCheck()) throw new RunStoppedError();
  return [...threads.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export async function cleanupForumThread(opts) {
  const options = normalizeCleanupOptions({ ...opts, collectAll: true });
  const { channelId, log, stopCheck = () => false, progress = () => {} } = options;
  const stats = emptyStats(), collected = createMessageCollection(options.order);
  let scanned = 0;
  try {
    const thread = await readJson(`${API}/channels/${channelId}`, options);
    if (thread.id !== channelId || ![10, 11, 12].includes(thread.type)) throw new Error('Select an individual thread for thread cleanup.');
    const parent = await readJson(`${API}/channels/${thread.parent_id}`, options);
    if (!(opts.allowAnyThread ? [0, 5, 15, 16] : [15, 16]).includes(parent.type) || parent.guild_id !== options.guildId || parent.id !== thread.parent_id) throw new Error('This thread does not belong to the selected forum/server.');
    if (parent.nsfw && !options.includeNsfw) {
      log('info', 'Thread cleanup skipped because its parent is NSFW. Enable Include NSFW to clean it.');
      return { done: true, ...stats };
    }
    let before = options.maxId;
    while (!stopCheck()) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const batch = await readJson(`${API}/channels/${channelId}/messages?${query}`, options);
      if (!Array.isArray(batch)) throw new Error('Discord returned an invalid thread message page.');
      if (!batch.length) break;
      const valid = batch.filter(message => /^\d+$/.test(String(message.id || '')));
      if (valid.length !== batch.length) throw new Error('Thread page contains invalid message IDs. No messages changed.');
      const oldest = valid.reduce((value, message) => compareMessageIds(message.id, value) < 0 ? message.id : value, valid[0].id);
      if (before && compareMessageIds(oldest, before) >= 0) throw new Error('Thread history did not advance. No messages changed.');
      const matching = [];
      const pageSeen = new Set();
      for (const message of valid) {
        if (pageSeen.has(message.id) || (before && compareMessageIds(message.id, before) >= 0)) continue;
        pageSeen.add(message.id);
        scanned++;
        if (matchesMessage(message, options)) matching.push(message);
        else stats.skipped++;
      }
      collected.add(matching);
      progress(scanned, scanned, 'Scanning thread');
      log('verb', `Scanned ${scanned} messages in ${thread.name || channelId}; collected ${collected.length} matches.`);
      if (options.minId && compareMessageIds(oldest, options.minId) <= 0) break;
      before = oldest;
      if (!stopCheck()) await sleep(rand(900, 1500));
    }
    return await runCollectedMessages(collected.finish(), options, stats);
  } catch (error) {
    if (!(error instanceof RunStoppedError)) throw error;
    return { stopped: true, ...stats };
  }
}
