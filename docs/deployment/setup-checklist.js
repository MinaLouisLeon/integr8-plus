// Integr8 Plus Setup Checklist: copy buttons and the tick boxes.
// Kept in step with setup-checklist.md and the published page (see AGENTS.md).
  // Copy buttons, with selection as the fallback where the clipboard is refused.
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const code = button.parentElement.querySelector('code');
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Selected';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    });
  }

  // The checklist remembers its ticks in this browser. Storage may be missing
  // or refused (private window, previews), so every touch is wrapped.
  const KEY = 'integr8-setup-ticks-v3';
  const boxes = [...document.querySelectorAll('.check input[type=checkbox]')];
  const text = document.getElementById('progress-text');
  const bar = document.getElementById('progress-bar');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const render = () => {
    let done = 0;
    for (const box of boxes) {
      box.closest('li').classList.toggle('done', box.checked);
      if (box.checked) done += 1;
    }
    text.textContent = `${done} of ${boxes.length} steps ticked`;
    bar.style.width = `${boxes.length ? (done / boxes.length) * 100 : 0}%`;
    clearButton.disabled = done === 0;
    if (done === 0) disarm();
  };

  // Clearing takes two clicks, so a stray tap never wipes a morning's progress.
  const clearButton = document.getElementById('clear-ticks');
  const cancelButton = document.getElementById('clear-cancel');
  let armed = false;
  const disarm = () => {
    armed = false;
    clearButton.classList.remove('armed');
    clearButton.textContent = 'Clear all ticks';
    cancelButton.hidden = true;
  };
  clearButton.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      const done = boxes.filter((box) => box.checked).length;
      clearButton.classList.add('armed');
      clearButton.textContent = `Yes, clear all ${done}`;
      cancelButton.hidden = false;
      return;
    }
    for (const box of boxes) box.checked = false;
    saved = {};
    try { localStorage.removeItem(KEY); } catch { /* fine: cleared for this session */ }
    disarm();
    render();
  });
  cancelButton.addEventListener('click', disarm);
  for (const box of boxes) {
    box.checked = saved[box.id] === true;
    box.addEventListener('change', () => {
      saved[box.id] = box.checked;
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* fine: the tick still shows this session */ }
      render();
    });
  }
  render();
