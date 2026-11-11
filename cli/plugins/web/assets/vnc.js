// vivary web — a sandbox's screen, drawn by noVNC's client library (served by
// the web from the Mac). The stream comes from a machine an agent controls,
// so anything it carries (desktop name, clipboard) is shown as text only.
import RFB from '/novnc/core/rfb.js';
import KeyTable from '/novnc/core/input/keysym.js';
import keysyms from '/novnc/core/input/keysymdef.js';

const $ = (s) => document.querySelector(s);
const name = decodeURIComponent(location.pathname.slice('/vnc/'.length));
const screenPath = `/vnc/${encodeURIComponent(name)}`;
const api = `/api/vnc/${encodeURIComponent(name)}`;
let rfb = null;
let ctrl = false;
let fromSandbox = '';

$('#name').textContent = name;
document.title = `${name} — vivary`;

function status(text, cls = '') {
  $('#status').textContent = text;
  $('#status').className = cls;
}

function message(text) {
  $('#msg').textContent = text;
  $('#msg').hidden = !text;
}

async function get(path) {
  const r = await fetch(path, { headers: { 'x-vivary': '1' }, cache: 'no-store' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Why there is no screen (or none any more): the session, then the sandbox.
// A WebSocket close carries little, so the server is asked.
async function diagnose() {
  let auth;
  try {
    auth = await get('/api/auth/status');
  } catch {
    return 'Cannot reach vivary. Is `vivary web` still running on the Mac?';
  }
  if (auth.body.origin && auth.body.origin !== location.origin) {
    location.replace(`${auth.body.origin}${screenPath}`);
    return 'Moving to vivary\'s own address…';
  }
  if (!auth.body.authenticated) {
    location.replace(`/?next=${encodeURIComponent(screenPath)}`);
    return 'Signed out — opening the sign-in page…';
  }
  const st = await get(api);
  return st.status === 200 ? null : (st.body.error || `HTTP ${st.status}`);
}

function connect() {
  message('');
  $('#again').hidden = true;
  status('Connecting…');
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${api}`;
  rfb = new RFB($('#screen'), url, { shared: true });
  rfb.scaleViewport = true;   // the whole desktop in the window, phone included
  rfb.resizeSession = false;  // Xvfb has a fixed size
  rfb.background = '#000';
  rfb.addEventListener('connect', () => {
    status('Connected', 'ok');
    if (!coarse) rfb.focus();
  });
  rfb.addEventListener('disconnect', async (e) => {
    rfb = null;
    releaseCtrl();
    status(e.detail.clean ? 'Disconnected' : 'Connection lost', 'bad');
    $('#again').hidden = false;
    const why = await diagnose();
    if (why) message(why);
  });
  // x11vnc runs without a password (it is reachable only through vivary), so
  // a prompt means the sandbox still runs the GUI of an older image.
  rfb.addEventListener('credentialsrequired', () => {
    rfb.disconnect();
    message(`This screen asks for a VNC password: the sandbox runs the GUI of an older image.\n`
      + `On the Mac: vivary up ${name} --recreate`);
  });
  rfb.addEventListener('securityfailure', (e) => message(`Refused: ${e.detail.reason || e.detail.status}`));
  rfb.addEventListener('clipboard', (e) => {
    fromSandbox = String(e.detail.text ?? '');
    $('#from-sbx').hidden = !fromSandbox;
  });
}

// --- keys -----------------------------------------------------------------------

const send = (keysym, code) => rfb?.sendKey(keysym, code);
function sendChar(ch) {
  if (ch === '\n' || ch === '\r') return send(KeyTable.XK_Return, 'Enter');
  if (ch === '\t') return send(KeyTable.XK_Tab, 'Tab');
  send(keysyms.lookup(ch.codePointAt(0)));
}
function releaseCtrl() {
  if (ctrl) rfb?.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false);
  ctrl = false;
  $('#ctrl').setAttribute('aria-pressed', 'false');
}

// Buttons must not take the focus: on a phone that would close the keyboard.
for (const b of document.querySelectorAll('#tools button')) b.addEventListener('pointerdown', (e) => e.preventDefault());
$('#esc').addEventListener('click', () => send(KeyTable.XK_Escape, 'Escape'));
$('#tab').addEventListener('click', () => send(KeyTable.XK_Tab, 'Tab'));
$('#ctrl').addEventListener('click', () => {
  if (!rfb) return;
  ctrl = !ctrl;
  rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', ctrl);
  $('#ctrl').setAttribute('aria-pressed', String(ctrl));
});
$('#again').addEventListener('click', connect);

// A phone's on-screen keyboard: a hidden textarea is focused, and what changes
// in it is sent as keys (noVNC's own app does the same). The filler gives
// Backspace something to delete; autocorrect rewrites show up as a diff.
const coarse = matchMedia('(pointer: coarse)').matches;
const kbi = $('#kbd-input');
const FILL = '________';
let last = FILL;
const resetKbd = () => { kbi.value = FILL; last = FILL; };
$('#kbd').hidden = !coarse;
$('#kbd').addEventListener('click', () => {
  if (document.activeElement === kbi) return kbi.blur();
  resetKbd();
  kbi.focus();
});
kbi.addEventListener('input', () => {
  const now = kbi.value;
  let i = 0;
  while (i < last.length && i < now.length && last[i] === now[i]) i++;
  for (let k = i; k < last.length; k++) send(KeyTable.XK_BackSpace, 'Backspace');
  for (const ch of now.slice(i)) sendChar(ch);
  if (now.length < 2 || now.length > 64) resetKbd();
  else last = now;
});
// Keys that type nothing (a hardware keyboard on an iPad).
const SPECIAL = {
  ArrowLeft: KeyTable.XK_Left, ArrowRight: KeyTable.XK_Right, ArrowUp: KeyTable.XK_Up, ArrowDown: KeyTable.XK_Down,
  Escape: KeyTable.XK_Escape, Tab: KeyTable.XK_Tab, Home: KeyTable.XK_Home, End: KeyTable.XK_End,
  PageUp: KeyTable.XK_Page_Up, PageDown: KeyTable.XK_Page_Down, Delete: KeyTable.XK_Delete,
};
kbi.addEventListener('keydown', (e) => {
  if (SPECIAL[e.key] === undefined) return;
  e.preventDefault();
  send(SPECIAL[e.key], e.code);
});

// --- text and clipboard -----------------------------------------------------------

const dlg = $('#text-dlg');
$('#text').addEventListener('click', () => dlg.showModal());
$('#text-close').addEventListener('click', () => dlg.close());
$('#type-it').addEventListener('click', () => {
  for (const ch of $('#text-in').value) sendChar(ch);
  dlg.close();
});
$('#clip-it').addEventListener('click', () => {
  rfb?.clipboardPasteFrom($('#text-in').value);
  dlg.close();
});
$('#copy-sbx').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(fromSandbox);
    $('#from-sbx p').textContent = 'Copied.';
  } catch {
    $('#text-in').value = fromSandbox;
    $('#from-sbx p').textContent = 'The browser refused the clipboard — the text is in the box above.';
  }
});

if (document.fullscreenEnabled) {
  $('#full').hidden = false;
  $('#full').addEventListener('click', () => (document.fullscreenElement
    ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
}

// --- start ------------------------------------------------------------------------

const why = await diagnose();
if (why) {
  status('No screen', 'bad');
  message(why);
} else {
  connect();
}
