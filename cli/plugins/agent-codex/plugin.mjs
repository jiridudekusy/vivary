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
    return ['-v', `${path.join(dir, 'dot-codex')}:/home/agent/.codex`];
  },
};
