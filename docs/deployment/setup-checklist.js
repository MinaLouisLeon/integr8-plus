/* global document, navigator, window, setTimeout, localStorage */
// Integr8 Plus Setup Checklist: copy buttons, tick boxes and progress.
// Supports the HTML version of setup-checklist.md (see AGENTS.md).
(() => {
  // Copy buttons, with selection as the fallback where the clipboard is refused.
  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const code = button.parentElement.querySelector('code');
      const reset = () =>
        setTimeout(() => {
          button.textContent = 'Copy';
          button.classList.remove('ok');
        }, 1500);
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = 'Copied';
        button.classList.add('ok');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Ctrl+C';
      }
      reset();
    });
  }

  // The ticks are remembered in this browser. Storage may be missing or
  // refused (private window, previews), so every touch is wrapped.
  const KEY = 'integr8-setup-checklist-v4';
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const store = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* fine: the ticks still show this session */
    }
  };

  const boxes = [...document.querySelectorAll('input.check')];
  const stages = [...document.querySelectorAll('section.stage')];
  const text = document.getElementById('progress-text');
  const bar = document.getElementById('progress-bar');
  const clearAll = document.getElementById('clear-ticks');
  const cancel = document.getElementById('clear-cancel');

  const render = () => {
    let done = 0;
    for (const box of boxes) {
      box.closest('li').classList.toggle('done', box.checked);
      if (box.checked) done += 1;
    }
    for (const stage of stages) {
      const own = [...stage.querySelectorAll('input.check')];
      const ticked = own.filter((box) => box.checked).length;
      const label = `${ticked}/${own.length}`;
      const complete = own.length > 0 && ticked === own.length;
      stage.querySelector(`[data-count="${stage.id}"]`).textContent = label;
      stage.querySelector(`[data-clear="${stage.id}"]`).hidden = ticked === 0;
      stage.classList.toggle('complete', complete);
      const link = document.querySelector(`[data-rail="${stage.id}"]`);
      if (link) {
        link.classList.toggle('complete', complete);
        link.querySelector(`[data-rail-count="${stage.id}"]`).textContent = label;
      }
    }
    text.textContent = `${done} of ${boxes.length} steps done`;
    bar.style.width = `${boxes.length ? (done / boxes.length) * 100 : 0}%`;
    clearAll.disabled = done === 0;
    if (done === 0) disarm();
  };

  const untick = (list) => {
    for (const box of list) {
      box.checked = false;
      delete saved[box.id];
    }
    store();
    render();
  };

  // Clearing everything takes two clicks, so a stray tap never wipes a day's work.
  let armed = false;
  function disarm() {
    armed = false;
    clearAll.classList.remove('armed');
    clearAll.textContent = 'Clear all ticks';
    cancel.hidden = true;
  }
  clearAll.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      clearAll.classList.add('armed');
      clearAll.textContent = `Yes, clear all ${boxes.filter((box) => box.checked).length}`;
      cancel.hidden = false;
      return;
    }
    disarm();
    untick(boxes);
  });
  cancel.addEventListener('click', disarm);

  // One stage at a time, for the update stage at each release.
  for (const button of document.querySelectorAll('.stage-clear')) {
    button.addEventListener('click', () => {
      untick([...document.getElementById(button.dataset.clear).querySelectorAll('input.check')]);
    });
  }

  for (const box of boxes) {
    box.checked = saved[box.id] === true;
    box.addEventListener('change', () => {
      if (box.checked) saved[box.id] = true;
      else delete saved[box.id];
      store();
      render();
    });
  }
  render();
})();
