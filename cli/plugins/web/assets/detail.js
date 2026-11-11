// vivary web — one sandbox: how to get in, its settings, the .vivary.json
// approval, start/stop/restart/recreate. Every change asks for a passkey touch
// made for exactly that change (the server checks the digest).
//
// Everything shown here may come from an agent-writable place (the project
// file, names, paths): it goes through esc() or textContent, never raw HTML.

const isOn = (v) => (Array.isArray(v) ? v.length > 0 : !!v && v !== 'off');
const SOURCE = {
  sandbox: '', 'built-in': '', project: '.vivary.json', default: 'default file', cli: 'command line',
};
const sourceTag = (esc, src) => {
  const label = SOURCE[src] ?? String(src).replace(/^profile:/, 'profile ');
  return label ? `<span class="src">${esc(label)}</span>` : '';
};

const EFFECT = {
  none: 'Nothing changed.',
  'next-start': 'Saved. It applies at the next start.',
  restart: 'Saved. Restart the sandbox to apply it.',
  recreate: 'Saved. The container bakes these in, so it needs a rebuild:',
};

export function createDetail({ $, esc, api, stepUp, toast, fail, onChange }) {
  let current = null; // the detail as last loaded
  let busy = false;

  function copyRow(label, text) {
    return `<div class="kv"><div class="k">${esc(label)}</div>
      <button class="ssh" data-copy="${esc(text)}"><span>${esc(text)}</span>
      <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>`;
  }
  const ideRow = (ide) => `<div class="ide"><a href="${esc(ide.cursor)}">Open in Cursor</a><a href="${esc(ide.vscode)}">Open in VS Code</a></div>`;

  function connectHtml(c) {
    let h = '<section class="block"><h2>Connect</h2>';
    if (c.tailnet) {
      h += '<h3>From your devices (tailnet)</h3>';
      h += copyRow('ssh', c.tailnet.ssh);
      h += `<div class="kv"><div class="k">~/.ssh/config</div>
        <pre class="block-pre">${esc(c.tailnet.sshConfig)}</pre>
        <button class="ghost small" data-copy="${esc(c.tailnet.sshConfig)}"><span>Copy block</span></button></div>`;
      h += ideRow(c.tailnet.ide);
      h += '<p class="hint quiet">Needs the device\'s key enrolled under Devices; with the block above an IDE can use the alias.</p>';
    } else if (c.hint) {
      h += `<p class="hint">${esc(c.hint)}</p>`;
    }
    h += '<h3>On this Mac</h3>';
    h += copyRow('ssh', c.mac.ssh);
    h += ideRow(c.mac.ide);
    if (c.paseo) {
      h += '<h3>Paseo</h3>';
      h += copyRow('address', c.paseo.url);
      h += `<p class="hint quiet">Password: in <code>${esc(c.paseo.passwordFile)}</code> on the Mac — vivary never shows it.</p>`;
    }
    return `${h}</section>`;
  }

  function approvalHtml(a) {
    if (!a) return '';
    let h = '<section class="block warn-block"><h2>.vivary.json waits for approval</h2>';
    if (a.error) return `${h}<p class="hint">${esc(a.error)}</p></section>`;
    h += `<p class="quiet">${a.first ? 'A new project file' : 'The project file changed'} in the workspace. `
      + 'An agent can write it, so nothing in it applies — and the sandbox does not start — until you approve exactly this content.</p>';
    const lines = String(a.diff).split('\n').map((l) => {
      const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
      return `<span class="${cls}">${esc(l)}</span>`;
    }).join('\n');
    h += `<pre class="diff">${lines}</pre>`;
    if (a.invalid) h += `<p class="hint">It would not load: ${esc(a.invalid)}</p>`;
    h += `<button class="act" data-d="approve" ${a.invalid ? 'disabled' : ''}>Approve this content with passkey</button>`;
    return `${h}</section>`;
  }

  function settingsHtml(s, err) {
    if (!s) return `<section class="block"><h2>Settings</h2><p class="hint">${esc(err || 'Cannot read the settings.')}</p></section>`;
    const fixed = (src) => (src === 'project' ? 'disabled' : '');
    let h = '<section class="block"><h2>Settings</h2><form id="settings">';
    h += `<div class="row2">
      <label>Memory ${sourceTag(esc, s.memory.source)}<input name="memory" value="${esc(s.memory.value)}" ${fixed(s.memory.source)} autocapitalize="off" spellcheck="false"></label>
      <label>CPUs ${sourceTag(esc, s.cpus.source)}<input name="cpus" value="${esc(s.cpus.value)}" ${fixed(s.cpus.source)} inputmode="numeric"></label>
    </div>`;
    if (s.profiles.available.length || s.profiles.fromProject.length) {
      h += '<h3>Profiles</h3><div class="toggles">';
      for (const p of s.profiles.available) {
        const fromFile = s.profiles.fromProject.includes(p);
        h += `<label class="toggle"><input type="checkbox" name="profile" value="${esc(p)}"
          ${s.profiles.own.includes(p) || fromFile ? 'checked' : ''} ${fromFile ? 'disabled' : ''}>
          <span class="t-name">${esc(p)}</span>${fromFile ? sourceTag(esc, 'project') : ''}</label>`;
      }
      h += '</div>';
    }
    h += '<h3>Features</h3><div class="toggles">';
    for (const f of s.flags.filter((x) => x.settable)) {
      const val = typeof f.value === 'boolean' || f.value === false ? '' : ` <span class="val">${esc(f.value)}</span>`;
      h += `<label class="toggle"><input type="checkbox" name="flag" value="${esc(f.name)}" ${isOn(f.value) ? 'checked' : ''} ${fixed(f.source)}>
        <span class="t-main"><span class="t-name">${esc(f.name)}${val}</span>${sourceTag(esc, f.source)}
        <span class="t-help">${esc(f.help)}</span></span></label>`;
    }
    h += '</div>';
    const other = s.flags.filter((x) => !x.settable && isOn(x.value));
    if (other.length) {
      h += `<p class="hint quiet">Only on the Mac (host ports and paths): ${other.map((f) => `--${esc(f.name)} ${esc([].concat(f.value).join(', '))}`).join('; ')}</p>`;
    }
    if (s.pendingRecreate?.length) {
      h += `<div class="effect recreate"><p>The container was built before these changes and needs a rebuild to get them:</p>
        <p class="quiet">${s.pendingRecreate.map((c) => esc(`${c.key}: ${[].concat(c.from).join(', ')} → ${[].concat(c.to).join(', ')}`)).join('<br>')}</p>
        <button class="act danger" type="button" data-d="recreate">Recreate now…</button></div>`;
    }
    h += '<button class="act" type="submit">Save with passkey</button><div id="effect"></div></form></section>';
    return h;
  }

  function headHtml(d) {
    const m = d.settings ? ` · ${esc(d.settings.memory.value)} · ${esc(d.settings.cpus.value)} CPUs` : '';
    return `<article class="card ${d.running ? 'on' : ''}">
      <div class="head"><i class="status-dot"></i><div class="name">${esc(d.name)}</div>
        <div class="state">${d.running ? 'Running' : 'Stopped'}</div></div>
      <p class="meta">${esc(d.runtime)} · ${esc(d.agent)}${m}</p>
      <p class="meta">${esc(d.workspace)}</p>
      ${d.screen ? `<a class="act screen" href="/vnc/${esc(encodeURIComponent(d.name))}">Open screen</a>` : ''}
      <div class="row-actions">
        <button class="act ${d.running ? 'stop' : ''}" data-d="${d.running ? 'down' : 'up'}">${d.running ? 'Stop' : 'Start'}</button>
        ${d.running ? '<button class="act ghost-act" data-d="restart">Restart</button>' : ''}
        <button class="act ghost-act danger" data-d="recreate">Recreate…</button>
      </div>
    </article>`;
  }

  function render(d) {
    current = d;
    $('#detail').innerHTML = `<a class="back" href="#">&lsaquo; All sandboxes</a>${headHtml(d)}`
      + approvalHtml(d.approval) + connectHtml(d.connect) + settingsHtml(d.settings, d.settingsError);
    $('#settings')?.addEventListener('submit', save);
  }

  async function open(name) {
    $('#detail').innerHTML = '<p class="quiet">Loading…</p>';
    try {
      render(await api(`/api/sandboxes/${encodeURIComponent(name)}`));
    } catch (e) {
      $('#detail').innerHTML = `<a class="back" href="#">&lsaquo; All sandboxes</a><p class="hint">${esc(e.message)}</p>`;
    }
  }

  // What the form says that differs from what was loaded.
  function changesFrom(form) {
    const s = current.settings;
    const changes = {};
    for (const key of ['memory', 'cpus']) {
      const el = form.elements[key];
      if (!el.disabled && el.value.trim() !== String(s[key].value)) changes[key] = el.value.trim();
    }
    const own = [...form.querySelectorAll('input[name=profile]:checked:not(:disabled)')].map((x) => x.value);
    if (form.querySelector('input[name=profile]') && JSON.stringify(own) !== JSON.stringify(s.profiles.own)) changes.profiles = own;
    const flags = {};
    for (const box of form.querySelectorAll('input[name=flag]:not(:disabled)')) {
      const f = s.flags.find((x) => x.name === box.value);
      if (box.checked !== isOn(f.value)) flags[f.name] = box.checked;
    }
    if (Object.keys(flags).length) changes.flags = flags;
    return changes;
  }

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    const changes = changesFrom(e.target);
    if (!Object.keys(changes).length) return toast('Nothing changed.');
    const name = current.name;
    busy = true;
    try {
      const proof = await stepUp('settings', { name, changes });
      const r = await api(`/api/sandboxes/${encodeURIComponent(name)}/settings`, { method: 'POST', body: { changes, stepUp: proof } });
      await open(name);
      showEffect(r);
      onChange();
    } catch (err) { fail(err); }
    busy = false;
  }

  function showEffect(r) {
    const box = $('#effect');
    if (!box) return;
    const drift = (r.drift || []).map((c) => `${c.key}: ${[].concat(c.from).join(', ')} → ${[].concat(c.to).join(', ')}`);
    box.className = `effect ${r.effect}`;
    box.innerHTML = `<p>${esc(EFFECT[r.effect] || r.effect)}</p>`
      + (r.effect === 'recreate' ? `<p class="quiet">${drift.map(esc).join('<br>')}</p>` : '')
      + (r.effect === 'restart' ? '<button class="act" data-d="restart">Restart now</button>' : '')
      + (r.effect === 'recreate' ? '<button class="act danger" data-d="recreate">Recreate now…</button>' : '');
  }

  async function action(btn) {
    if (busy || !current) return;
    const what = btn.dataset.d;
    const name = current.name;
    try {
      let body = {};
      if (what === 'recreate') {
        if (!confirm(`Rebuild ${name}'s container? Whatever was installed INSIDE it is lost; the workspace and vivary's state stay.`)) return;
        body = { stepUp: await stepUp('recreate', { name }) };
      }
      if (what === 'approve') {
        const sha = current.approval.sha;
        body = { sha, stepUp: await stepUp('config-approve', { name, sha }) };
      }
      busy = true;
      btn.disabled = true;
      btn.textContent = { up: 'Starting…', down: 'Stopping…', restart: 'Restarting…', recreate: 'Recreating…', approve: 'Approving…' }[what];
      await api(`/api/sandboxes/${encodeURIComponent(name)}/${what}`, { method: 'POST', body });
      toast({ up: 'Started', down: 'Stopped', restart: 'Restarted', recreate: 'Rebuilt', approve: 'Approved' }[what] + ` ${name}`);
    } catch (err) {
      fail(err);
    }
    busy = false;
    onChange();
    await open(name);
  }

  return { open, action, isBusy: () => busy };
}
