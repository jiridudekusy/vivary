// vivary web — the page. A module served as a file: the CSP allows no inline
// script, so an injected <script> tag would not run.
import { cancelled, createPasskey, getPasskey, passkeysAvailable } from '/assets/webauthn.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

let csrf = null;
let busy = false;
let polling = null;

// `vivary web enroll` puts a one-time token in the fragment (never sent in a
// request line, so never in a log). Take it, and wipe it from the address bar
// and this history entry at once.
let enrollToken = (() => {
  const m = location.hash.match(/^#enroll=([A-Za-z0-9_-]{20,})$/);
  if (location.hash) history.replaceState(null, '', location.pathname);
  return m ? m[1] : null;
})();

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(t.hideTimer);
  t.hideTimer = setTimeout(() => { t.className = ''; }, 4200);
}

function fail(e) {
  if (cancelled(e)) return toast('Cancelled.');
  toast(e.message || String(e), true);
}

// Every call: the custom header (CSRF guard for the public auth routes) and,
// once logged in, the session's CSRF token.
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-vivary': '1' };
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    csrf = null;
    boot();
    throw new Error('Signed out — sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// A fresh passkey touch made for exactly this action and payload; the server
// refuses it for anything else.
async function stepUp(action, payload) {
  const { challengeId, options } = await api('/api/auth/stepup', { method: 'POST', body: { action, payload } });
  return { challengeId, response: await getPasskey(options) };
}

// --- gate screens -------------------------------------------------------------

function gate(html) {
  $('#app').hidden = true;
  $('#logout').hidden = true;
  const g = $('#gate');
  g.innerHTML = html;
  g.hidden = false;
}

function deviceGuess() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'this device';
}

async function boot() {
  let status;
  try {
    status = await api('/api/auth/status');
  } catch {
    return gate('<h2>Cannot reach vivary</h2><p>Is <code>vivary web</code> still running on the Mac?</p>');
  }
  $('#host').textContent = new URL(status.origin).host;

  if (location.origin !== status.origin) {
    return gate(`<h2>Open vivary at its own address</h2>
      <p>Passkeys for this vivary belong to one address. Use it on every device, this Mac included:</p>
      <p><a href="${esc(status.origin)}/">${esc(status.origin)}/</a></p>`);
  }
  if (!passkeysAvailable()) {
    return gate('<h2>Passkeys are not available here</h2><p>This browser does not offer passkeys on this page. '
      + 'Use Safari or Chrome on a current system.</p>');
  }
  if (enrollToken) {
    gate(`<h2>Register a passkey</h2>
      <p>This passkey will open vivary on this Mac. With iCloud Keychain it reaches your iPhone and iPad too.</p>
      <input id="pk-name" value="${esc(deviceGuess())}" aria-label="Passkey name" autocapitalize="off" spellcheck="false">
      <button id="do-enroll" class="act">Create passkey</button>`);
    $('#do-enroll').addEventListener('click', enroll);
    return;
  }
  if (status.authenticated) {
    csrf = status.csrf;
    return showApp(status);
  }
  if (!status.configured) {
    return gate('<h2>Not set up yet</h2><p>Register the first passkey from the Mac. In a terminal there, run:</p>'
      + '<p><code>vivary web enroll</code></p>');
  }
  gate(`<h2>Sign in</h2><p>Use the passkey you registered for vivary.</p>
    <button id="do-login" class="act">Sign in with passkey</button>`);
  $('#do-login').addEventListener('click', login);
}

async function enroll() {
  const btn = $('#do-enroll');
  btn.disabled = true;
  try {
    const name = $('#pk-name').value.trim();
    const { challengeId, options } = await api('/api/auth/enroll/options', { method: 'POST', body: { token: enrollToken } });
    const response = await createPasskey(options);
    await api('/api/auth/enroll', { method: 'POST', body: { token: enrollToken, challengeId, response, name } });
    enrollToken = null;
    toast('Passkey registered — you are signed in.');
    await boot();
  } catch (e) {
    fail(e);
    btn.disabled = false;
  }
}

async function login() {
  const btn = $('#do-login');
  btn.disabled = true;
  try {
    const { challengeId, options } = await api('/api/auth/login/options', { method: 'POST', body: {} });
    const response = await getPasskey(options);
    await api('/api/auth/login', { method: 'POST', body: { challengeId, response } });
    await boot();
  } catch (e) {
    fail(e);
    btn.disabled = false;
  }
}

// --- the app --------------------------------------------------------------------

function showApp(status) {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  renderPasskeys(status.passkeys || []);
  load();
  polling ||= setInterval(() => { if (!busy && !$('#app').hidden) load(); }, 15000);
}

async function load() {
  try {
    const s = await api('/api/state');
    $('#host').textContent = s.host || 'tailscale not reporting';
    const on = s.sandboxes.filter((x) => x.running).length;
    $('#fleet').innerHTML = `<b>${on}</b> running · ${s.sandboxes.length - on} stopped`;
    // Running first: the page's job is "what is alive and how do I get in",
    // and a couple of dozen sandboxes push that below the fold otherwise.
    const order = [...s.sandboxes].sort((a, b) => (b.running - a.running) || a.name.localeCompare(b.name));
    $('#list').innerHTML = order.map(card).join('');
    $('#devs').innerHTML = s.devices.length ? s.devices.map(dev).join('')
      : '<p class="empty">No devices enrolled. Add this one’s public key and it opens every sandbox.</p>';
  } catch (e) {
    if (!/Signed out/.test(e.message)) toast('Cannot reach vivary on this Mac. Is `vivary web` still running?', true);
  }
}

function card(s) {
  const conn = s.connect.tailnet
    ? `<button class="ssh" data-copy="${esc(s.connect.tailnet)}"><span>${esc(s.connect.tailnet)}</span>
       <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>`
    : `<p class="hint">${esc(s.connect.hint || '')}</p>`;
  return `<article class="card ${s.running ? 'on' : ''}">
    <div class="head"><i class="status-dot"></i><div class="name">${esc(s.name)}</div>
      <div class="state">${s.running ? 'Running' : 'Stopped'}</div></div>
    <p class="meta">${esc(s.runtime)} · ${esc(s.agent)}${s.memory ? ` · ${esc(s.memory)}` : ''}</p>
    <p class="meta">${esc(s.workspace)}</p>
    ${s.running ? conn : ''}
    <button class="act ${s.running ? 'stop' : ''}" data-act="${s.running ? 'down' : 'up'}" data-name="${esc(s.name)}">
      ${s.running ? 'Stop' : 'Start'}</button>
  </article>`;
}

function dev(d) {
  const p = d.key.split(/\s+/);
  return `<div class="dev"><div class="dev-name">${esc(d.name)}</div>
    <div class="dev-key">${esc(p[0])} …${esc((p[1] || '').slice(-12))}</div>
    <button data-rm="${esc(d.name)}" aria-label="Revoke ${esc(d.name)}">&times;</button></div>`;
}

function renderPasskeys(list) {
  $('#pks').innerHTML = list.map((pk) => `<div class="pk"><div class="pk-main">
      <div class="pk-name">${esc(pk.name)}${pk.current ? '<span class="pk-tag">this session</span>' : ''}</div>
      <div class="pk-meta">added ${esc(day(pk.createdAt))} · last used ${esc(day(pk.lastUsedAt))}${pk.backedUp ? ' · synced' : ''}</div>
    </div><button data-pk-rm="${esc(pk.id)}" data-pk-name="${esc(pk.name)}" aria-label="Remove ${esc(pk.name)}">&times;</button></div>`).join('')
    || '<p class="empty">No passkeys.</p>';
}

async function refreshPasskeys() {
  const s = await api('/api/auth/status');
  if (!s.authenticated) return boot();
  renderPasskeys(s.passkeys || []);
}

async function act(btn) {
  if (busy) return;
  busy = true;
  const { act: a, name } = btn.dataset;
  btn.disabled = true;
  btn.textContent = a === 'up' ? 'Starting…' : 'Stopping…';
  try {
    const r = await api(`/api/sandboxes/${encodeURIComponent(name)}/${a}`, { method: 'POST', body: {} });
    toast(`${a === 'up' ? 'Started' : 'Stopped'} ${name}`, !r.ok);
  } catch (e) {
    toast(e.message.split('\n').pop() || 'Failed', true);
  }
  busy = false;
  await load();
}

document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast('Copied');
    } catch {
      const r = document.createRange();
      r.selectNodeContents(copy.querySelector('span'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      toast('Selected — hold to copy');
    }
    return;
  }
  const a = e.target.closest('[data-act]');
  if (a) return act(a);

  const rm = e.target.closest('[data-rm]');
  if (rm) {
    if (!confirm(`Revoke ${rm.dataset.rm}? It loses access to every sandbox.`)) return;
    try {
      await api(`/api/devices/${encodeURIComponent(rm.dataset.rm)}`, { method: 'DELETE', body: {} });
      toast(`Revoked ${rm.dataset.rm}`);
    } catch (err) { fail(err); }
    return load();
  }

  const pkRm = e.target.closest('[data-pk-rm]');
  if (pkRm) {
    const { pkRm: id, pkName } = pkRm.dataset;
    if (!confirm(`Remove passkey "${pkName}"? Sessions signed in with it end too.`)) return;
    try {
      const stepUpProof = await stepUp('passkey-remove', { id });
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', body: { stepUp: stepUpProof } });
      toast(`Removed ${pkName}`);
      await refreshPasskeys();
    } catch (err) { fail(err); }
    return;
  }

  if (e.target.id === 'refresh') return load();
  if (e.target.id === 'pk-add') return addPasskey();
  if (e.target.id === 'logout' || e.target.id === 'logout-all') {
    const all = e.target.id === 'logout-all';
    if (all && !confirm('Sign out every device, this one included?')) return;
    try { await api(all ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ends anyway */ }
    csrf = null;
    return boot();
  }
});

// Another authenticator (a security key, a non-Apple phone): confirm with an
// existing passkey first, then create the new one.
async function addPasskey() {
  const name = (prompt('Name for the new passkey', deviceGuess()) || '').trim();
  if (!name) return;
  try {
    const stepUpProof = await stepUp('passkey-add', { name });
    const { challengeId, options } = await api('/api/auth/passkeys/options', {
      method: 'POST', body: { name, stepUp: stepUpProof },
    });
    const response = await createPasskey(options);
    await api('/api/auth/passkeys', { method: 'POST', body: { challengeId, response } });
    toast(`Added ${name}`);
    await refreshPasskeys();
  } catch (err) { fail(err); }
}

$('#enrol').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#dname').value.trim();
  const key = $('#dkey').value.trim();
  if (!name || !key) return toast('Name the device and paste its public key.', true);
  try {
    // A device key opens every sandbox, so it takes a passkey touch made for
    // exactly this name and key.
    const stepUpProof = await stepUp('device-add', { name, key });
    await api('/api/devices', { method: 'POST', body: { name, key, stepUp: stepUpProof } });
    toast(`Enrolled ${name} — it now opens every sandbox`);
    $('#dname').value = '';
    $('#dkey').value = '';
    load();
  } catch (err) { fail(err); }
});

boot();
