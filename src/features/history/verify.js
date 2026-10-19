// Del-Discord v1 — personal source modules.
import { apiFetch } from '../../discord/history-api.js';
import { API } from '../../config.js';
import { retryMs, sleep } from '../../utils/timing.js';

export async function sentCountForChannel(token, selfId, channelId) {
  while (true) {
    const query = new URLSearchParams({ author_id: selfId, sort_by: 'timestamp', sort_order: 'desc', offset: '0' });
    const r = await apiFetch(`${API}/channels/${channelId}/messages/search?${query.toString()}`, { headers: { Authorization: token } });
    if (r.status === 202) {
      let body = {}; try { body = await r.json(); } catch {}
      await sleep(retryMs(body.retry_after ?? 1) + 250); continue;
    }
    if (!r.ok) return null;
    const data = await r.json();
    return Number(data.total_results || 0);
  }
}

async function closeTemporaryDm(token, channelId) {
  try {
    const response = await apiFetch(`${API}/channels/${channelId}`, { method: 'DELETE', headers: { Authorization: token } });
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Could not close the temporarily opened DM. It may remain open in your DM list. ${error.message || error}`, { cause: error });
  }
}

export async function verifyPerson(token, selfId, userId, knownChannelId, wasOpen) {
  let channelId = knownChannelId || '';
  let temporarilyOpened = false;
  try {
    if (!channelId) {
      const r = await apiFetch(`${API}/users/@me/channels`, {
        method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient_id: userId })
      });
      if (!r.ok) return null;
      const ch = await r.json(); channelId = ch?.id || ''; temporarilyOpened = !!channelId && !wasOpen;
    }
    if (!channelId) return null;
    const count = await sentCountForChannel(token, selfId, channelId);
    return { count, channelId };
  } finally {
    if (temporarilyOpened && channelId) await closeTemporaryDm(token, channelId);
  }
}
