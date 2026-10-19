import { API } from '../config.js';
import { apiFetch, RunStoppedError } from '../discord/api.js';
import { invalidateAuth } from '../discord/deleter-auth.js';
import { compareMessageIds, matchesMessage } from './message-filters.js';
import { rand, sleep } from '../utils/timing.js';

// Search indexing can lag behind messages sent since the previous cleanup.
// Read history above each channel's newest search hit with fresh run-local cursors.
export async function collectFreshMessages(options, newest, collected, stats, scanned = 0) {
  const { token, guildId, channelId, log, stopCheck, progress = () => {} } = options;
  const inaccessible = Symbol('inaccessible');
  const read = async (url, forbiddenMessage = '') => {
    const response = await apiFetch(url, { headers: { Authorization: token }, cache: 'no-store' }, log, stopCheck);
    if (stopCheck()) throw new RunStoppedError();
    if (response.status === 403 && forbiddenMessage) {
      log('warn', forbiddenMessage);
      return inaccessible;
    }
    if (response.status === 401) invalidateAuth();
    if (!response.ok) throw new Error(`Fresh message scan failed (${response.status}) for ${new URL(url).pathname}. Check your access and try again.`);
    return response.json();
  };
  let channels = [{ id: channelId }];
  if (channelId && guildId !== '@me') {
    const channel = await read(`${API}/channels/${channelId}`);
    if (channel.id !== channelId || channel.guild_id !== guildId) throw new Error('Discord returned a channel outside the selected server.');
    if (channel.nsfw && !options.includeNsfw) {
      log('info', 'Fresh history skipped for this NSFW channel. Enable Include NSFW to scan it.');
      return;
    }
  }
  if (!channelId) {
    const discovered = await read(`${API}/guilds/${guildId}/channels`, 'Discord denied server channel discovery (403). Continuing with channels found in search. Select individual channels to scan new messages in channels missing from search.');
    const list = discovered === inaccessible ? [] : discovered;
    if (!Array.isArray(list)) throw new Error('Discord returned an invalid channel list.');
    if (list.some(channel => channel.guild_id && channel.guild_id !== guildId)) throw new Error('Discord returned channels for another server.');
    channels = list.filter(channel => [0, 5].includes(channel.type) && (options.includeNsfw || !channel.nsfw));
    const active = await read(`${API}/guilds/${guildId}/threads/active`, 'Discord denied active thread discovery (403). Continuing with server channels and threads found in search. Select individual threads to scan new messages in threads missing from search.');
    const threads = active === inaccessible ? [] : active.threads;
    if (!Array.isArray(threads)) throw new Error('Discord returned an invalid active thread list.');
    const parents = new Map(list.map(channel => [channel.id, channel]));
    const threadsById = new Map(threads.map(thread => [thread.id, thread]));
    channels.push(...threads.filter(thread => {
      const parent = parents.get(thread.parent_id);
      return parent && [10, 11, 12].includes(thread.type) && (!thread.guild_id || thread.guild_id === guildId) && (options.includeNsfw || !parent.nsfw);
    }));
    // Discovery endpoints can be unavailable even when search and individual
    // channel history are allowed. Preserve search targets, including threads
    // absent from the active list, without duplicating a discovered channel.
    const selected = new Set(channels.map(channel => channel.id));
    const readMetadata = async id => {
      if (!/^\d{15,22}$/.test(String(id || ''))) throw new Error('Discord returned an invalid channel ID.');
      const channel = await read(`${API}/channels/${id}`, `Discord denied channel metadata (403) for ${id}. Skipping its fresh history scan because its server and NSFW setting could not be checked.`);
      if (channel === inaccessible) return null;
      if (channel?.id !== id || channel.guild_id !== guildId) throw new Error('Discord returned a channel outside the selected server.');
      return channel;
    };
    for (const id of newest.keys()) {
      if (selected.has(id)) continue;
      let thread = threadsById.get(id);
      if (thread && (![10, 11, 12].includes(thread.type) || (thread.guild_id && thread.guild_id !== guildId))) continue;
      let channel = parents.get(id) || thread || await readMetadata(id);
      if (!channel) continue;
      if ([10, 11, 12].includes(channel.type)) {
        thread = channel;
        channel = parents.get(thread.parent_id) || await readMetadata(thread.parent_id);
        if (!channel) continue;
        if (![0, 5, 15, 16].includes(channel.type)) throw new Error('Discord returned an invalid thread parent.');
        parents.set(channel.id, channel);
      } else if (![0, 5].includes(channel.type)) throw new Error('Discord returned an unsupported message channel.');
      // Archived threads can be absent from discovery. Resolve their parent
      // before applying the same NSFW filter used for active threads.
      if (options.includeNsfw || !channel.nsfw) {
        channels.push({ id }); selected.add(id);
      }
    }
  }
  log('info', 'Checking fresh channel history for messages that Discord search may not have indexed yet…');
  for (const channel of channels) {
    if (!/^\d{15,22}$/.test(String(channel.id || ''))) throw new Error('Discord returned an invalid channel ID.');
    const indexed = newest.get(channel.id);
    const lower = indexed && (!options.minId || compareMessageIds(indexed, options.minId) > 0) ? indexed : options.minId;
    let before = options.maxId;
    while (!stopCheck()) {
      if (before && lower && compareMessageIds(before, lower) <= 0) break;
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const batch = await read(`${API}/channels/${channel.id}/messages?${query}`, channelId ? '' : `Discord denied message history for channel ${channel.id} (403). Skipping its fresh history scan; collected search matches will still be rechecked.`);
      if (batch === inaccessible) break;
      if (!Array.isArray(batch)) throw new Error('Discord returned invalid message history. No further messages changed.');
      if (!batch.length) break;
      if (batch.some(message => !/^\d+$/.test(String(message?.id || '')) || message.channel_id !== channel.id)) {
        throw new Error('Discord returned invalid history messages. No further messages changed.');
      }
      const oldest = batch.reduce((id, message) => compareMessageIds(message.id, id) < 0 ? message.id : id, batch[0].id);
      if (before && compareMessageIds(oldest, before) >= 0) throw new Error('Fresh message history did not advance. Try again.');
      const seen = new Set(), matching = [];
      for (const message of batch) {
        if (seen.has(message.id) || (before && compareMessageIds(message.id, before) >= 0) || (lower && compareMessageIds(message.id, lower) <= 0)) continue;
        seen.add(message.id);
        scanned++;
        if (matchesMessage(message, options)) matching.push(message);
        else stats.skipped++;
      }
      collected.add(matching);
      progress(scanned, scanned, 'Scanning');
      log('verb', `Scanned ${scanned}; collected ${collected.length} fresh and indexed matches.`);
      if (lower && compareMessageIds(oldest, lower) <= 0) break;
      before = oldest;
      if (!stopCheck()) await sleep(rand(900, 1500));
    }
    if (stopCheck()) throw new RunStoppedError();
  }
}
