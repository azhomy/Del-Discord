import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { askPopup } from '../src/ui/confirm.js';

function mount(t) {
  const dom = new JSDOM('<div id="dmd-panel"><button id="origin">Start</button></div>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; dom.window.close(); });
  return dom;
}

test('confirmation shortcuts approve only the top dialog and leave the underlying action pending', async t => {
  const dom = mount(t), doc = dom.window.document;
  doc.querySelector('#origin').focus();
  let deletionApproved = false;
  const deletion = askPopup({ title: 'Delete messages?', danger: true }).then(value => { deletionApproved = value; return value; });
  const deleteButton = doc.querySelector('.dmd-confirm-actions button:last-child');
  const queued = askPopup({ title: 'Add to Queue?' });
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true });
  doc.dispatchEvent(event);
  assert.equal(await queued, true);
  assert.equal(deletionApproved, false);
  assert.equal(doc.querySelectorAll('.dmd-confirm-overlay').length, 1);
  assert.equal(doc.activeElement, deleteButton);
  assert.equal(event.defaultPrevented, true);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(await deletion, false);
  assert.equal(doc.activeElement, doc.querySelector('#origin'));
});

test('Escape dismisses only the top dialog and Tab stays inside it', async t => {
  const dom = mount(t), doc = dom.window.document;
  const underlying = askPopup({ title: 'Export?' });
  const top = askPopup({ title: 'Add to Queue?' });
  const dialogs = doc.querySelectorAll('.dmd-confirm-box');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
  assert.equal(doc.activeElement, dialogs[1].querySelector('button'));
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(await top, false);
  assert.equal(doc.querySelectorAll('.dmd-confirm-box').length, 1);
  doc.querySelector('.dmd-confirm-actions button:first-child').click();
  assert.equal(await underlying, false);
});
