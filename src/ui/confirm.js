// Del-Discord v1 — personal source modules.

export function askPopup({ title = 'Confirm', message = '', details = '', yesText = 'Yes', noText = 'No', danger = false, render, getResult, onNo, signal } = {}) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'dmd-confirm-overlay';

    const box = document.createElement('div');
    box.className = 'dmd-confirm-box';

    const heading = document.createElement('div');
    heading.className = 'dmd-confirm-title';
    heading.textContent = title;

    const body = document.createElement('div');
    body.className = 'dmd-confirm-message';
    body.textContent = message;

    box.append(heading, body);

    if (details) {
      const pre = document.createElement('pre');
      pre.className = 'dmd-confirm-details';
      pre.textContent = details;
      box.appendChild(pre);
    }

    const actions = document.createElement('div');
    actions.className = 'dmd-confirm-actions';

    const no = document.createElement('button');
    no.className = 'dmd-btn';
    no.textContent = noText;

    const yes = document.createElement('button');
    yes.className = `dmd-btn ${danger ? 'dmd-red' : 'dmd-green'}`;
    yes.textContent = yesText;

    render?.({ box, yes });
    actions.append(no, yes);
    box.appendChild(actions);
    overlay.appendChild(box);
    const previousFocus = document.activeElement;
    const host = document.getElementById('dmd-panel') || document.body;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    heading.id = 'dmd-confirm-heading';
    box.setAttribute('aria-labelledby', heading.id);
    host.appendChild(overlay);

    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      signal?.removeEventListener('abort', onAbort);
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value && getResult ? getResult() : value);
    };
    const onKey = e => {
      if (e.key !== 'Tab' && e.key !== 'Escape' && !(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
      const dialogs = document.querySelectorAll('.dmd-confirm-overlay');
      // Async scans can open another confirmation while a queue prompt is up.
      // A shortcut must never approve or dismiss the covered dialog as well.
      if (dialogs[dialogs.length - 1] !== overlay) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Tab') {
        const controls = [...box.querySelectorAll('button,input,select,[tabindex="0"]')].filter(node => !node.disabled);
        const index = controls.indexOf(document.activeElement);
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !yes.disabled) finish(true);
    };

    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    no.onclick = () => { onNo?.(); finish(false); };
    yes.onclick = () => { if (!yes.disabled) finish(true); };
    overlay.onclick = e => { if (e.target === overlay) finish(false); };
    document.addEventListener('keydown', onKey, true);
    yes.focus();
  });
}
