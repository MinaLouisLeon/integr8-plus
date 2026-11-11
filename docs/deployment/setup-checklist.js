/* global document, navigator, window, setTimeout, clearTimeout, localStorage */
// Integr8 Plus Setup Checklist: copy buttons, tick boxes and progress.
// Supports the HTML version of setup-checklist.md (see AGENTS.md).
(function () {
  'use strict';

  // Copy buttons, with selection as the fallback where the clipboard is refused.
  document.querySelectorAll('.copy').forEach(function (button) {
    button.addEventListener('click', function () {
      var code = button.parentElement.querySelector('code');
      var reset = function () { setTimeout(function () { button.textContent = 'Copy'; }, 1600); };
      var select = function () {
        var range = document.createRange();
        range.selectNodeContents(code);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Selected';
        reset();
      };
      try {
        navigator.clipboard.writeText(code.textContent).then(function () {
          button.textContent = 'Copied';
          reset();
        }, select);
      } catch { select(); }
    });
  });

  // The checklist remembers its ticks in this browser. Storage may be missing or
  // refused (private window, previews), so every touch is wrapped.
  var KEY = 'integr8-setup-ticks-v4';
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.check'));
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  function store() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* the tick still shows this session */ } }

  function render() {
    var done = 0;
    boxes.forEach(function (box) {
      box.closest('li').classList.toggle('done', box.checked);
      if (box.checked) done += 1;
    });
    document.querySelectorAll('.stage').forEach(function (stage) {
      var all = stage.querySelectorAll('.check');
      var ticked = stage.querySelectorAll('.check:checked').length;
      var label = ticked + '/' + all.length;
      var complete = ticked === all.length;
      stage.querySelector('.stage-count').textContent = label;
      stage.classList.toggle('complete', complete);
      var link = document.querySelector('[data-rail="' + stage.id + '"]');
      link.querySelector('.c').textContent = label;
      link.classList.toggle('done', complete);
    });
    document.getElementById('progress-text').textContent = done + ' of ' + boxes.length + ' done';
    document.getElementById('progress-bar').style.width = (boxes.length ? (done / boxes.length) * 100 : 0) + '%';
  }

  boxes.forEach(function (box) {
    box.checked = saved[box.id] === true;
    box.addEventListener('change', function () {
      if (box.checked) saved[box.id] = true; else delete saved[box.id];
      store();
      render();
    });
  });

  // Clearing takes two clicks, so a stray tap never wipes a morning's progress.
  var clear = document.getElementById('clear-ticks');
  var armed = false;
  var timer;
  clear.addEventListener('click', function () {
    if (!armed) {
      armed = true;
      clear.textContent = 'Click again to clear';
      timer = setTimeout(function () { armed = false; clear.textContent = 'Clear ticks'; }, 3000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    clear.textContent = 'Clear ticks';
    boxes.forEach(function (box) { box.checked = false; });
    saved = {};
    try { localStorage.removeItem(KEY); } catch { /* cleared for this session */ }
    render();
  });

  render();
})();
