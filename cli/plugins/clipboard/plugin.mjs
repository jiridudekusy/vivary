// clipboard: bidirectional clipboard bridge — Ctrl+V pastes host
// screenshots/text into the agent, pbcopy inside sets the host clipboard.
// Host side is macOS for now (osascript/pbpaste/pbcopy).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function dumpClipboardClass(cls, tmp) {
  const script = [
    'try',
    `set d to the clipboard as ${cls}`,
    `set f to open for access POSIX file "${tmp}" with write permission`,
    'set eof of f to 0',
    'write d to f',
    'close access f',
    'return "ok"',
    'on error',
    'return "none"',
    'end try',
  ].flatMap((l) => ['-e', l]);
  return spawnSync('osascript', script, { encoding: 'utf8' }).stdout?.includes('ok');
}

function readPng() {
  const tmp = path.join(os.tmpdir(), `vivary-clip-${process.pid}.png`);
  try {
    if (!dumpClipboardClass('«class PNGf»', tmp)) {
      // some apps put only TIFF on the clipboard — convert via sips
      const tiff = path.join(os.tmpdir(), `vivary-clip-${process.pid}.tiff`);
      if (!dumpClipboardClass('«class TIFF»', tiff)) return null;
      const r = spawnSync('sips', ['-s', 'format', 'png', tiff, '--out', tmp], { stdio: 'ignore' });
      fs.rmSync(tiff, { force: true });
      if (r.status !== 0) return null;
    }
    const buf = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    return buf;
  } catch {
    return null;
  }
}

function readText() {
  const r = spawnSync('pbpaste', [], { encoding: 'buffer' });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}

function writeText(text) {
  return spawnSync('pbcopy', [], { input: text }).status === 0;
}

// What the host clipboard currently offers, in X11 TARGETS vocabulary —
// Claude Code queries this before deciding whether an image paste exists.
function targets() {
  const info = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).stdout || '';
  const t = ['TARGETS'];
  if (/PNGf|TIFF/.test(info)) t.push('image/png');
  if (/string|utf8/i.test(info)) t.push('text/plain', 'UTF8_STRING', 'STRING');
  return t.join('\n') + '\n';
}

// Cheap change detector for the clipboard-sync daemon (classes+sizes from
// `clipboard info`, plus the text content for same-size text edits).
function fingerprint() {
  const info = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).stdout || '';
  const text = /string|utf8/i.test(info) ? readText() : Buffer.alloc(0);
  return crypto.createHash('md5').update(info).update(text).digest('hex');
}

export default {
  name: 'clipboard',
  order: 60,
  flags: {
    clipboard: {
      type: 'boolean',
      sticky: true,
      cfgKey: 'clipboard',
      help: 'Bridge the HOST clipboard into the sandbox (sticky):\nCtrl+V pastes host screenshots/text into the agent,\npbcopy inside sets the host clipboard. Covers X-native\nagents (Codex) via an Xvfb clipboard sync.',
    },
  },
  needsBroker: (cfg) => !!cfg.clipboard,
  runArgs({ cfg }) {
    return cfg.clipboard ? ['-e', 'SANDBOX_CLIPBOARD=1'] : [];
  },

  // GET/POST /clipboard
  broker({ req, res, respond, params, log, sandboxForRequest }) {
    if (!req.url.startsWith('/clipboard')) return false;
    const cfg = sandboxForRequest(params.get('name') || '');
    if (!cfg?.clipboard) {
      log(`REJECTED clipboard (not enabled) from ${params.get('name') || '?'}`);
      respond(403, { ok: false, error: 'clipboard not enabled for this sandbox (--clipboard)' });
      return true;
    }
    if (req.method === 'GET') {
      const format = params.get('format') || 'text';
      if (format === 'fingerprint') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(fingerprint());
        return true;
      }
      const data = format === 'png' ? readPng()
        : format === 'targets' ? Buffer.from(targets())
        : readText();
      if (!data || !data.length) {
        respond(404, { ok: false, error: `no ${format === 'png' ? 'image' : 'text'} in host clipboard` });
        return true;
      }
      log(`OK clipboard read (${format}, ${data.length}B) by ${cfg.name}`);
      res.writeHead(200, { 'content-type': format === 'png' ? 'image/png' : 'text/plain; charset=utf-8' });
      res.end(data);
      return true;
    }
    // POST — sandbox -> host clipboard (text)
    const text = params.get('text') || '';
    if (!writeText(text)) respond(500, { ok: false, error: 'pbcopy failed' });
    else {
      log(`OK clipboard write (${text.length} chars) by ${cfg.name}`);
      respond(200, { ok: true });
    }
    return true;
  },
};
