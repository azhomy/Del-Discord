import { countCsvMessages } from './count-csv.js';
import { countJsonMessages } from './count-json.js';
// Del-Discord v1 — personal source modules.
import { merge, recipientIds, removeHistoryMatch } from './model.js';
import { saveHistory } from './storage.js';

export async function importPackage(fileList, { $, getHistory, getIdentity, setPackageInfo, persist, render }) {
  const history = getHistory();
  const isCurrent = () => getHistory() === history;
  const files = [...(fileList || [])];
  if (!files.length) return;

  $('#dmh-import').disabled = true;
  $('#dmh-summary').textContent = `Indexing ${files.length} package files locally…`;

  try {
    const me = await getIdentity();
    if (!isCurrent()) return;
    const selfId = me?.user?.id || '';
    const pathOf = file => String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const folderOf = path => path.slice(0, path.lastIndexOf('/')).toLowerCase();

    const index = new Map();
    const channelFiles = [];
    const messageFilesByFolder = new Map();

    // One O(n) pass over the package instead of scanning every file for every DM.
    for (const file of files) {
      if (!isCurrent()) return;
      const path = pathOf(file);
      const lower = path.toLowerCase();

      if ((`/${lower}`).endsWith('/messages/index.json')) {
        try {
          const obj = JSON.parse(await file.text());
          if (!isCurrent()) return;
          for (const [id, label] of Object.entries(obj || {})) {
            if (typeof label === 'string') index.set(String(id), label);
          }
        } catch {}
        continue;
      }

      if ((`/${lower}`).endsWith('/channel.json')) {
        channelFiles.push({ file, path });
        continue;
      }

      if (/\/messages(?:\.csv|\.json)$/.test('/' + lower)) {
        const folder = folderOf(path);
        const bucket = messageFilesByFolder.get(folder);
        if (bucket) bucket.push({ file, lower });
        else messageFilesByFolder.set(folder, [{ file, lower }]);
      }
    }

    const sentCountsByFolder = new Map();
    const countSentMessages = async folder => {
      const key = folder.toLowerCase();
      if (sentCountsByFolder.has(key)) return sentCountsByFolder.get(key);
      const msgFiles = messageFilesByFolder.get(key) || [];
      let total = 0;

      for (const { file, lower } of msgFiles) {
        try {
          if (lower.endsWith('.json')) {
            total += await countJsonMessages(file);
          } else total += await countCsvMessages(file);
        } catch { sentCountsByFolder.set(key, null); return null; }
      }

      sentCountsByFolder.set(key, total);
      return total;
    };

    let importedCount = 0;
    let processed = 0;
    let lastSavedAt = Date.now();

    for (const { file, path } of channelFiles) {
      if (!isCurrent()) return;
      processed++;
      if (processed % 25 === 0) {
        $('#dmh-summary').textContent =
          `Processing package conversations ${processed}/${channelFiles.length}…`;
        await new Promise(requestAnimationFrame);
        if (!isCurrent()) return;
      }

      let ch;
      try { ch = JSON.parse(await file.text()); }
      catch { continue; }
      if (!isCurrent()) return;

      const folder = path.slice(0, path.lastIndexOf('/'));
      const channelId = String(ch?.id || folder.match(/(?:^|\/)c?(\d{15,22})$/)?.[1] || '');
      const label = index.get(channelId) || '';
      const type = String(ch?.type ?? '').toUpperCase();
      const direct = type === 'DM' || type === '1' || /^Direct Message with /i.test(label);
      const group = type === 'GROUP_DM' || type === '3';

      if (!direct || group) continue;

      const count = await countSentMessages(folder);
      if (!isCurrent()) return;
      if (count === null) continue;
      if (count <= 0) {
        removeHistoryMatch(history, '', channelId);
        continue;
      }

      const ids = [...new Set(recipientIds(ch))]
        .filter(id => id !== selfId && id !== channelId);

      merge(history, {
        userId: ids[0] || '',
        channelId,
        name: label.replace(/^Direct Message with\s+/i, '').trim(),
        sources: ['package'],
        sentCount: count,
        sentCountExact: false,
        verifiedSent: true,
        seenAt: new Date().toISOString()
      });

      importedCount++;
      if (Date.now() - lastSavedAt >= 2000) {
        saveHistory(history); lastSavedAt = Date.now();
      }


    }

    if (!isCurrent()) return;
    saveHistory(history);
    setPackageInfo({
      importedAt: new Date().toISOString(),
      importedCount,
      fileCount: files.length
    });
    persist();
    render();

    $('#dmh-summary').textContent =
      `Imported/updated ${importedCount} DM conversations. Parsed package results are cached locally.`;
  } finally {
    $('#dmh-import').disabled = false;
    $('#dmh-folder').value = '';
  }
}
