import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createZipBudget, ZipCapacityError } from '../src/utils/zip.js';
import { collectExportAttachments } from '../src/features/export-attachments.js';

test('ZIP budget counts UTF-8 paths, required entries and replacement sizes exactly', () => {
  const budget = createZipBudget();
  const cost = name => 76 + 2 * new TextEncoder().encode(name).length;
  budget.setFile('messages.json', 100);
  budget.setFile('attachments.json', 2);
  const name = 'attachments/😀.png';
  const size = 0xffffffff - 1 - 22 - cost('messages.json') - 100 - cost('attachments.json') - 2 - cost(name);
  budget.checkFile(name, size);
  budget.setFile(name, size);
  budget.setFile(name, size); // Updating an entry must not count it twice.
  assert.throws(() => budget.checkFile('extra', 0), ZipCapacityError);
  assert.throws(() => budget.setFile('messages.json', 101), ZipCapacityError);
  budget.setFile(name, 0); // Failed reservations must not corrupt the budget.
  budget.setFile('extra', 10);
  assert.throws(() => budget.checkFile('oversized', 0xffffffff), /4 GB/);
});

test('ZIP budget reserves required file slots before attachment downloads', () => {
  const budget = createZipBudget();
  budget.setFile('messages.json', 0);
  budget.setFile('attachments.json', 2);
  for (let index = 0; index < 65532; index++) budget.setFile(`attachment-${index}`, 0);
  assert.throws(() => budget.checkFile('overflow', 0), /Too many files/);
  budget.setFile('messages.json', 100);
});

for (const source of ['metadata', 'header', 'payload']) test(`oversized attachment ${source} stops before retaining data or requesting another file`, async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  let requests = 0, bodyReads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return {
      ok: true, status: 200,
      headers: new Headers(source === 'header' ? { 'Content-Length': String(0xffffffff) } : {}),
      blob: async () => { bodyReads++; return { size: 0xffffffff }; },
    };
  });
  const files = [], report = [], budget = createZipBudget();
  budget.setFile('messages.json', 0); budget.setFile('attachments.json', 2);
  const attachment = { filename: 'large.bin', url: 'https://cdn.discordapp.com/large', ...(source === 'metadata' ? { size: 0xffffffff } : {}) };
  await assert.rejects(collectExportAttachments({ channelId: 'channel', messages: [{ id: 'message', attachments: [attachment, attachment] }] },
    { files, report, budget, log: () => {} }), ZipCapacityError);
  assert.equal(requests, source === 'metadata' ? 0 : 1);
  assert.equal(bodyReads, source === 'payload' ? 1 : 0);
  assert.equal(files.length, 0); assert.equal(report.length, 0);
});

test('bundled export rejects an impossible attachment before its download and unlocks the panel', async t => {
  const channelId = '345678901234567890';
  const dom = new JSDOM('<header><div role="toolbar"></div></header>', { url: `https://discord.com/channels/@me/${channelId}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document, downloads = [];
  let attachmentRequests = 0;
  dom.window.Blob = Blob; dom.window.TextEncoder = TextEncoder;
  dom.window.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  dom.window.setTimeout = callback => { callback(); return 0; };
  dom.window.fetch = async url => {
    if (url.endsWith('/users/@me')) return Response.json({ id: 'self' });
    if (url.startsWith('https://cdn.discordapp.com/')) { attachmentRequests++; return new Response('unexpected'); }
    return Response.json(new URL(url).searchParams.has('before') ? [] : [{
      id: '456789012345678901', attachments: [{ filename: 'large.bin', size: 0xffffffff, url: 'https://cdn.discordapp.com/large' }],
    }]);
  };
  vm.runInContext(await readFile('dist/Del-Discord-v1.user.js', 'utf8'), dom.getInternalVMContext());
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  doc.querySelector('#dmd-token').value = 'capacity-test';
  const task = doc.querySelector('#dmd-export-conversation').onclick();
  const popup = doc.querySelector('.dmd-confirm-box'); assert.ok(popup);
  popup.querySelector('#dmd-export-attachments').click();
  popup.querySelector('.dmd-confirm-actions button:last-child').click();
  await task;
  assert.equal(attachmentRequests, 0); assert.equal(downloads.length, 0);
  assert.match(doc.querySelector('#dmd-log').textContent, /4 GB/);
  assert.equal(doc.querySelector('#dmd-export-conversation').disabled, false);
  assert.equal(doc.querySelector('#dmd-stop').disabled, true);
});
