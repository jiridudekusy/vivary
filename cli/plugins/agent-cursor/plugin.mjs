import { capture } from '../../core/util.mjs';
// agent-cursor: Cursor CLI agent inside the sandbox — `sursor` launcher and
// auth/state persistence (~/.cursor, holds cli-config.json + credentials).
// Login is a device flow (prints a cursor.com URL and polls), so no OAuth
// callback relay is needed; with --host-open the URL opens on the host.
import fs from 'node:fs';
import path from 'node:path';

// The cursor installer takes no version flag, but it embeds the exact build it
// will fetch in its download URL (downloads.cursor.com/lab/<version>/...).
// Reading that gives a precise cache key: the layer rebuilds when — and only
// when — a new cursor-agent ships.
export function parseCursorVersion(script) {
  const m = String(script || '').match(/downloads\.cursor\.com\/lab\/([A-Za-z0-9.\-]+)\//);
  return m ? m[1] : null;
}

export function resolveCursorVersion(
  fetchText = () => capture('curl', ['-fsSL', '--max-time', '10', 'https://cursor.com/install']),
) {
  const r = fetchText();
  const v = r.status === 0 ? parseCursorVersion(r.stdout) : null;
  if (!v) {
    console.error('WARNING: could not resolve the cursor-agent version — '
      + 'building unpinned (a cached layer may keep an older cursor-agent)');
    return 'latest';
  }
  return v;
}

export default {
  buildArgs() {
    return { CURSOR_AGENT_VERSION: resolveCursorVersion() };
  },

  name: 'agent-cursor',
  order: 90,
  agents: { cursor: { cmd: 'cursor-agent' } },
  launchers: { sursor: 'cursor' },
  macosProvision: ['curl -fsSL https://cursor.com/install | bash'],

  runArgs({ dir }) {
    fs.mkdirSync(path.join(dir, 'dot-cursor'), { recursive: true });
    return ['-v', `${path.join(dir, 'dot-cursor')}:/home/agent/.cursor`];
  },
};
