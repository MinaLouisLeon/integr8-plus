#!/usr/bin/env node
/* global console, process, Buffer, TextEncoder, TextDecoder */
// Builds the setup guide as a password-protected static site for GitHub Pages.
//
// GitHub Pages serves files as they are and has no sign-in of its own, so the
// protection is encryption: the guide (the HTML with its stylesheet and script
// inlined) is encrypted with AES-256-GCM under a key derived from the username
// and password (PBKDF2-SHA-256, 600 000 rounds, a fresh salt each build). The
// published page holds only that ciphertext and a sign-in form; the browser
// derives the same key with WebCrypto and decrypts. A wrong username or
// password fails the GCM check, so nothing readable is ever served without
// them. The cost is that anyone holding the page can try passwords offline,
// so a long password matters more here than on a server that limits attempts.
//
// The credentials come from GUIDE_USERNAME and GUIDE_PASSWORD (repository
// secrets in the Pages workflow); they are never written to the repository.
//
// Usage: GUIDE_USERNAME=… GUIDE_PASSWORD=… node scripts/guide/build-site.mjs [out-dir]
// (default dist/guide-site). No dependency of its own.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guideDir = join(root, 'docs', 'deployment');

export const ITERATIONS = 600_000;
const MIN_PASSWORD = 8;

/** The username and password as the one secret the key is derived from. */
export function secretOf(username, password) {
  return `${username.trim().toLowerCase()}\n${password}`;
}

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

async function keyFor(secret, salt, usage) {
  const material = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encrypt(plain, username, password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(secretOf(username, password), salt, 'encrypt');
  const data = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plain),
  );
  return { salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/** The same steps the page runs, for the tests. */
export async function decrypt(sealed, username, password) {
  const from = (text) => new Uint8Array(Buffer.from(text, 'base64'));
  const key = await keyFor(secretOf(username, password), from(sealed.salt), 'decrypt');
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: from(sealed.iv) },
    key,
    from(sealed.data),
  );
  return new TextDecoder().decode(plain);
}

/**
 * The guide as one file: its stylesheet and script inlined, so they are
 * encrypted with it and need no second request.
 */
export function inlineGuide(html, css, js) {
  const stylesheet = '<link rel="stylesheet" href="setup-checklist.css">';
  const script = '<script src="setup-checklist.js"></script>';
  if (!html.includes(stylesheet) || !html.includes(script)) {
    throw new Error('setup-checklist.html no longer loads its stylesheet and script as expected.');
  }
  return html
    .replace(stylesheet, () => `<style>\n${css}\n</style>`)
    .replace(script, () => `<script>\n${js.replace(/<\/(script)/giu, '<\\/$1')}\n</script>`);
}

/** The published page: a sign-in form and the sealed guide. */
export function sitePage(sealed) {
  const payload = JSON.stringify({ ...sealed, iterations: ITERATIONS }).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Integr8 Plus setup guide</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #fff; --text: #1d1b18; --muted: #6b665e; --line: #d9d5cd; --accent: #c2410c; --error: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #171614; --card: #22201d; --text: #f2efe9; --muted: #a8a197; --line: #3a3732; --accent: #fb923c; --error: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { margin: 0 0 4px; font-size: 1.25rem; }
  p { margin: 0 0 20px; color: var(--muted); font-size: .9rem; }
  label { display: block; margin: 0 0 14px; font-size: .9rem; font-weight: 600; }
  input { display: block; width: 100%; margin-top: 6px; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 6px; padding: 11px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: progress; }
  #error { min-height: 1.5em; margin: 12px 0 0; color: var(--error); }
</style>
</head>
<body>
<form id="unlock" autocomplete="on">
  <h1>Integr8 Plus setup guide</h1>
  <p>Sign in to open the guide.</p>
  <label>Username<input id="username" name="username" autocomplete="username" required autofocus></label>
  <label>Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <button id="open" type="submit">Open the guide</button>
  <p id="error" role="alert"></p>
</form>
<noscript><p>The guide needs JavaScript to open.</p></noscript>
<script id="sealed" type="application/json">${payload}</script>
<script>
(function () {
  var sealed = JSON.parse(document.getElementById('sealed').textContent);
  var KEPT = 'integr8-guide-key';
  var bytes = function (text) { return Uint8Array.from(atob(text), function (c) { return c.charCodeAt(0); }); };
  var show = function (html) { document.open(); document.write(html); document.close(); };
  function open(key) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv) }, key, bytes(sealed.data))
      .then(function (plain) { return new TextDecoder().decode(plain); });
  }
  function keyFor(username, password) {
    var secret = new TextEncoder().encode(username.trim().toLowerCase() + '\\n' + password);
    return crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']).then(function (material) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(sealed.salt), iterations: sealed.iterations },
        material, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
    });
  }
  // The key (never the password) is kept for this tab only, so a reload or a
  // link inside the guide does not ask again; closing the tab forgets it.
  try {
    var kept = sessionStorage.getItem(KEPT);
    if (kept) {
      crypto.subtle.importKey('raw', bytes(kept), 'AES-GCM', false, ['decrypt'])
        .then(open).then(show).catch(function () { sessionStorage.removeItem(KEPT); });
    }
  } catch (e) { /* no storage: sign in each time */ }
  var form = document.getElementById('unlock');
  var button = document.getElementById('open');
  var error = document.getElementById('error');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    button.disabled = true;
    error.textContent = 'Opening…';
    var derived;
    keyFor(document.getElementById('username').value, document.getElementById('password').value)
      .then(function (key) { derived = key; return open(key); })
      .then(function (html) {
        return crypto.subtle.exportKey('raw', derived).then(function (raw) {
          try { sessionStorage.setItem(KEPT, btoa(String.fromCharCode.apply(null, new Uint8Array(raw)))); } catch (e) { /* fine */ }
          show(html);
        });
      })
      .catch(function () {
        button.disabled = false;
        error.textContent = 'Wrong username or password.';
      });
  });
})();
</script>
</body>
</html>
`;
}

async function main() {
  const username = process.env.GUIDE_USERNAME ?? '';
  const password = process.env.GUIDE_PASSWORD ?? '';
  if (username.trim() === '' || password.length < MIN_PASSWORD) {
    console.error(
      `Set GUIDE_USERNAME and GUIDE_PASSWORD (at least ${String(MIN_PASSWORD)} characters).`,
    );
    process.exit(1);
  }
  const out = resolve(process.argv[2] ?? join(root, 'dist', 'guide-site'));
  const read = (name) => readFileSync(join(guideDir, name), 'utf8');
  const guide = inlineGuide(
    read('setup-checklist.html'),
    read('setup-checklist.css'),
    read('setup-checklist.js'),
  );
  const sealed = await encrypt(guide, username, password);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), sitePage(sealed));
  writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`Protected setup guide written to ${out}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
