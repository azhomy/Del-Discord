import { askPopup } from './confirm.js';
import { validateExportRange } from '../features/export.js';

export function askExportSelection(conversations, { range = {}, select = true, signal } = {}) {
  const selected = new Set(select ? [] : conversations.map((_, index) => index));
  let exportRange = { minId: range.minId || '', maxId: range.maxId || '' };
  let format = 'json', downloadAttachments = false;
  return askPopup({
    signal,
    title: 'Export Conversations', message: 'Choose conversations, a date or message range, and a file format. Blank boundaries export all readable history. All message data returned by Discord is included; enable attachment downloads to include the actual files in a ZIP (up to 4 GB).',
    yesText: 'Export', noText: 'Cancel',
    getResult: () => ({ conversations: conversations.filter((_, index) => selected.has(index)), format, range: exportRange, downloadAttachments }),
    render: ({ box, yes }) => {
      const boundaries = [];
      const error = document.createElement('div'); error.setAttribute('role', 'alert');
      const validate = () => {
        try {
          for (const { input, kind } of boundaries) {
            if (input.validity.badInput) throw new Error('Complete the date and time or clear the boundary.');
            if (kind.value === 'id' && input.value && !/^\d+$/.test(input.value.trim())) throw new Error('Enter a numeric message ID.');
          }
          exportRange = validateExportRange(exportRange); error.textContent = '';
        }
        catch (issue) { error.textContent = issue.message; }
        yes.disabled = !selected.size || !!error.textContent;
      };
      validate();
      const all = document.createElement('button'); all.type = 'button'; all.className = 'dmd-btn'; all.textContent = 'Select all';
      all.disabled = !conversations.length;
      const list = document.createElement('div'); list.className = 'dmd-export-list';
      list.onchange = event => {
        const input = event.target, index = Number(input.value);
        if (input.checked) selected.add(index); else selected.delete(index);
        validate();
      };
      conversations.forEach((item, index) => {
        const label = document.createElement('label'); label.className = 'dmd-check';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = String(index); input.checked = selected.has(index);
        label.append(input, document.createTextNode(item.label || item.channelId)); list.append(label);
      });
      all.onclick = () => { list.querySelectorAll('input').forEach(input => { input.checked = true; selected.add(Number(input.value)); }); validate(); };
      const formats = document.createElement('fieldset'); formats.className = 'dmd-export-formats';
      const legend = document.createElement('legend'); legend.textContent = 'File format'; formats.append(legend);
      for (const value of ['json', 'csv']) {
        const label = document.createElement('label'); label.className = 'dmd-check';
        const input = document.createElement('input'); input.type = 'radio'; input.name = 'dmd-export-format'; input.value = value; input.checked = value === format;
        input.onchange = () => { if (input.checked) format = value; };
        label.append(input, document.createTextNode(value.toUpperCase())); formats.append(label);
      }
      const ranges = document.createElement('fieldset'); ranges.className = 'dmd-export-range';
      const rangeLegend = document.createElement('legend'); rangeLegend.textContent = 'Date & message range (local time)'; ranges.append(rangeLegend);
      for (const [key, name] of [['minId', 'After'], ['maxId', 'Before']]) {
        const field = document.createElement('div'); field.className = 'dmd-field';
        const label = document.createElement('label'); label.htmlFor = `dmd-export-${key}`; label.textContent = name;
        const kind = document.createElement('select'); kind.setAttribute('aria-label', `${name} boundary type`);
        for (const [value, text] of [['date', 'Date & time'], ['id', 'Message ID']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; kind.append(option);
        }
        kind.value = /^\d+$/.test(exportRange[key]) ? 'id' : 'date';
        const input = document.createElement('input'); input.id = label.htmlFor;
        input.type = kind.value === 'date' ? 'datetime-local' : 'text'; input.step = 'any'; input.value = exportRange[key];
        boundaries.push({ input, kind });
        input.oninput = input.onchange = () => { exportRange[key] = input.value; validate(); };
        kind.onchange = () => { input.type = kind.value === 'date' ? 'datetime-local' : 'text'; input.value = ''; exportRange[key] = ''; validate(); };
        field.append(label, kind, input); ranges.append(field);
      }
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'dmd-btn'; clear.textContent = 'All dates';
      clear.onclick = () => { ranges.querySelectorAll('input').forEach(input => { input.value = ''; }); exportRange = { minId: '', maxId: '' }; validate(); };
      ranges.append(clear, error);
      const attachmentLabel = document.createElement('label'); attachmentLabel.className = 'dmd-check';
      const attachmentToggle = document.createElement('input'); attachmentToggle.type = 'checkbox'; attachmentToggle.id = 'dmd-export-attachments';
      attachmentToggle.onchange = () => { downloadAttachments = attachmentToggle.checked; };
      attachmentLabel.append(attachmentToggle, document.createTextNode('Download actual attachments (ZIP)'));
      box.append(all, list, ranges, formats, attachmentLabel);
    },
  });
}
