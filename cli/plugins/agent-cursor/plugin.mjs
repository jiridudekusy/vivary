// agent-cursor: Cursor CLI agent inside the sandbox — `sursor` launcher and
// auth/state persistence (~/.cursor, holds cli-config.json + credentials).
// Login is a device flow (prints a cursor.com URL and polls), so no OAuth
// callback relay is needed; with --host-open the URL opens on the host.
import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'agent-cursor',
  order: 90,
  agents: { cursor: { cmd: 'cursor-agent' } },
  launchers: { sursor: 'cursor' },

  runArgs({ dir }) {
    fs.mkdirSync(path.join(dir, 'dot-cursor'), { recursive: true });
    return ['-v', `${path.join(dir, 'dot-cursor')}:/home/agent/.cursor`];
  },
};
