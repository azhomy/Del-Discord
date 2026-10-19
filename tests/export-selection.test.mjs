import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { askExportSelection } from '../src/ui/export-selection.js';
import { conversationsToCsv, compactExportMessage, conversationToBlob } from '../src/features/export.js';
import { parseCsv } from '../src/utils/csv.js';

test('export dialog requires selection, supports select all and CSV, and cancels cleanly', async t => {
  const dom = new JSDOM('<div id="dmd-panel"></div>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; dom.window.close(); });
  const items = [{ channelId: '1', label: 'Alice' }, { channelId: '2', label: 'Bob' }];
  const result = askExportSelection(items); const doc = dom.window.document;
  const exportButton = doc.querySelector('.dmd-confirm-actions button:last-child');
  assert.equal(exportButton.disabled, true);
  doc.querySelector('.dmd-export-list input').click();
  assert.equal(exportButton.disabled, false);
  doc.querySelector('.dmd-confirm-box > button').click();
  doc.querySelector('.dmd-export-list input').click();
  doc.querySelector('input[value="csv"]').click(); exportButton.click();
  assert.deepEqual(await result, { conversations: [items[1]], format: 'csv', range: { minId: '', maxId: '' }, downloadAttachments: false });
  const cancelled = askExportSelection(items);
  doc.querySelector('.dmd-confirm-actions button:first-child').click();
  assert.equal(await cancelled, false);
  assert.equal(doc.querySelector('.dmd-confirm-overlay'), null);
});

test('CSV export preserves conversation identifiers, nested data and quoted multiline text', () => {
  const csv = conversationsToCsv([{ guildId: '@me', channelId: '123456789123456789', label: 'Alice', messages: [{ id: '987654321987654321', content: 'hello, "Alice"\nnext line', attachments: [{ url: 'https://example.com/a' }] }] }]);
  const [header, row] = parseCsv(csv);
  assert.equal(row[header.indexOf('content')], 'hello, "Alice"\nnext line');
  assert.equal(row[header.indexOf('id')], '987654321987654321');
  assert.deepEqual(JSON.parse(row[header.indexOf('attachments')]), [{ url: 'https://example.com/a' }]);
});

test('export select-all cannot enable an empty conversation export', async t => {
  const dom = new JSDOM('<div id="dmd-panel"></div>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; dom.window.close(); });
  const result = askExportSelection([]), doc = dom.window.document;
  const all = doc.querySelector('.dmd-confirm-box > button'), exportButton = doc.querySelector('.dmd-confirm-actions button:last-child');
  assert.equal(all.disabled, true); all.click(); assert.equal(exportButton.disabled, true);
  doc.querySelector('.dmd-confirm-actions button:first-child').click(); assert.equal(await result, false);
});


test('export dialog exposes inherited dates, rejects reversed ranges and clears to all dates', async t => {
  const dom = new JSDOM('<div id="dmd-panel"></div>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; dom.window.close(); });
  const result = askExportSelection([{ channelId: '1' }], { select: false, range: { minId: '2026-01-01T10:00', maxId: '2026-02-01T10:00' } });
  const doc = dom.window.document, yes = doc.querySelector('.dmd-confirm-actions button:last-child');
  const after = doc.querySelector('#dmd-export-minId'), before = doc.querySelector('#dmd-export-maxId');
  assert.equal(after.type, 'datetime-local'); assert.equal(after.value, '2026-01-01T10:00');
  assert.equal(yes.disabled, false);
  before.value = '2025-01-01T10:00'; before.dispatchEvent(new dom.window.Event('input'));
  assert.equal(yes.disabled, true); assert.match(doc.querySelector('[role=alert]').textContent, /earlier/);
  const kind = after.previousElementSibling; kind.value = 'id'; kind.dispatchEvent(new dom.window.Event('change'));
  after.value = 'invalid'; after.dispatchEvent(new dom.window.Event('input')); assert.equal(yes.disabled, true);
  doc.querySelector('.dmd-export-range > button').click();
  assert.equal(after.value, ''); assert.equal(before.value, ''); assert.equal(yes.disabled, false);
  yes.click(); assert.deepEqual((await result).range, { minId: '', maxId: '' });
});

test('JSON and CSV preserve every original Discord field, including nested and future fields', async () => {
  const raw = {
    id: '123456789012345678', content: 'hello', channel_id: '234567890123456789',
    author: { id: '1', avatar: 'hash', public_flags: 64 }, member: { nick: 'Nickname', roles: ['role'] },
    attachments: [{ id: 'a', duration_secs: 2.5, waveform: 'wave', flags: 8 }],
    reactions: [{ count: 2, count_details: { burst: 1, normal: 1 }, me_burst: true }],
    referenced_message: { id: '2', attachments: [{ filename: 'reply.png' }], flags: 4 },
    poll: { question: { text: 'Which?' } }, sticker_items: [{ id: 's' }], components: [{ type: 1 }],
    mention_roles: ['role'], flags: 4096, future_field: { nested: [false, 0, null] }
  };
  const data = { channelId: raw.channel_id, messages: [compactExportMessage(raw)] };
  const json = JSON.parse(await (await conversationToBlob(data)).text());
  assert.deepEqual(json.messages[0].raw, raw);
  const [header, row] = parseCsv(await (await conversationToBlob(data, { format: 'csv' })).text());
  assert.deepEqual(JSON.parse(row[header.indexOf('messageData')]), raw);
});
