// agent-codex: OpenAI Codex CLI inside the sandbox — `sodex` launcher and
// auth/state persistence (~/.codex).
import fs from 'node:fs';
import path from 'node:path';

export default {
  name: 'agent-codex',
  order: 85,
  agents: { codex: { cmd: 'codex' } },
  launchers: { sodex: 'codex' },

  runArgs({ dir }) {
    fs.mkdirSync(path.join(dir, 'dot-codex'), { recursive: true });
    // The app-server control socket dir must live on a VM-local fs: chmod on
    // a unix socket fails with EINVAL on virtiofs, and codex rejects a
    // symlinked control dir ("exists and is not a directory"), so overlay a
    // tmpfs on the real directory instead. Ephemeral contents only (socket,
    // startup lock, log). Replace a leftover symlink from the pre-tmpfs
    // workaround with a real dir so the mount lands on the right path.
    const ctl = path.join(dir, 'dot-codex', 'app-server-control');
    let st = null;
    try { st = fs.lstatSync(ctl); } catch { /* missing is fine */ }
    if (st && !st.isDirectory()) fs.rmSync(ctl, { force: true });
    fs.mkdirSync(ctl, { recursive: true });
    return [
      '-v', `${path.join(dir, 'dot-codex')}:/home/agent/.codex`,
      '--tmpfs', '/home/agent/.codex/app-server-control',
    ];
  },
};
