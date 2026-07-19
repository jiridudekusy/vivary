// agent-claude: Claude Code inside the sandbox — `slaude` launcher, config
// dir persistence, host chat-history sharing (scoped to the workspace
// project) and the import wizard (MCP servers, skills, settings, statusline).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ask, readJson } from '../../core/util.mjs';

const HOST_CLAUDE_DIR = path.join(HOME, '.claude');
const HOST_CLAUDE_JSON = path.join(HOME, '.claude.json');

async function selectItems(kind, items) {
  if (!items.length) return [];
  console.log(`\nAvailable ${kind}:`);
  items.forEach((item, i) => console.log(`  [${i + 1}] ${item}`));
  const answer = (await ask(`Select ${kind} to import (numbers, 'all' or 'none') [none]: `)).trim();
  if (answer === 'all') return [...items];
  if (!answer || answer === 'none') return [];
  const picked = [];
  for (const tok of answer.split(/\s+/)) {
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) picked.push(items[n - 1]);
    else console.log(`  (ignoring invalid selection: ${tok})`);
  }
  return picked;
}

function importSettings(dir) {
  const hostSettings = path.join(HOST_CLAUDE_DIR, 'settings.json');
  if (!fs.existsSync(hostSettings)) return;
  const settings = readJson(hostSettings, {});
  delete settings.hooks; // hooks reference host paths — never import them
  fs.writeFileSync(path.join(dir, 'dot-claude/settings.json'), JSON.stringify(settings, null, 2));
  console.log('  imported settings.json (without hooks)');
  // Status line: the command (e.g. ccstatusline) is baked into the image;
  // carry over its visual config from ~/.config.
  const slCmd = (settings.statusLine?.command || '').split(/\s+/)[0];
  if (slCmd) {
    const slConfig = path.join(HOME, '.config', slCmd);
    if (fs.existsSync(slConfig)) {
      fs.cpSync(slConfig, path.join(dir, 'dot-config', slCmd), { recursive: true });
      console.log(`  imported ~/.config/${slCmd} (status line config)`);
    }
  }
}

// Claude Code stores history under ~/.claude/projects/<slug>, slug = cwd
// with every non-alphanumeric character replaced by '-'.
function projectSlug(p) {
  return path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

// Share only the workspace's own history (and its subdirectories') with the
// container — NOT the host's entire ~/.claude/projects, which holds chats of
// unrelated projects. Each matching slug dir is mounted individually under
// /home/agent/host-projects (a plain dir, so no nested-mount issues); the
// entrypoint hook symlinks ~/.claude/projects there.
function projectHistoryMounts(cfg) {
  const projectsRoot = path.join(HOST_CLAUDE_DIR, 'projects');
  const slug = projectSlug(cfg.workspace);
  fs.mkdirSync(path.join(projectsRoot, slug), { recursive: true });
  const args = [];
  for (const d of fs.readdirSync(projectsRoot)) {
    if (d === slug || d.startsWith(`${slug}-`)) {
      args.push('-v', `${path.join(projectsRoot, d)}:/home/agent/host-projects/${d}`);
    }
  }
  return args;
}

export default {
  name: 'agent-claude',
  order: 80,
  agents: { claude: { cmd: 'claude' } },
  launchers: { slaude: 'claude' },

  runArgs({ cfg, dir }) {
    fs.mkdirSync(path.join(dir, 'dot-claude'), { recursive: true });
    return [
      '-v', `${path.join(dir, 'dot-claude')}:/home/agent/.claude`,
      ...projectHistoryMounts(cfg),
      '-e', 'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    ];
  },

  async onCreate({ dir }, { interactive }) {
    fs.mkdirSync(path.join(dir, 'dot-claude'), { recursive: true });

    // MCP servers (from host ~/.claude.json)
    const mcpServers = {};
    const hostMcp = readJson(HOST_CLAUDE_JSON, {})?.mcpServers || {};
    if (interactive) {
      const picked = await selectItems('MCP servers', Object.keys(hostMcp));
      for (const key of picked) mcpServers[key] = hostMcp[key];
      if (picked.length) {
        console.log(`  imported MCP servers: ${picked.join(' ')}`);
        console.log('  NOTE: servers referencing host-only binaries/paths will not work inside the container.');
      }
    }
    fs.writeFileSync(
      path.join(dir, 'dot-claude/.claude.json'),
      JSON.stringify({ mcpServers, hasCompletedOnboarding: true }, null, 2)
    );

    // Skills (from host ~/.claude/skills)
    if (interactive) {
      const skillsDir = path.join(HOST_CLAUDE_DIR, 'skills');
      const skills = fs.existsSync(skillsDir)
        ? fs.readdirSync(skillsDir).filter((s) => fs.statSync(path.join(skillsDir, s)).isDirectory()).sort()
        : [];
      const picked = await selectItems('skills', skills);
      if (picked.length) {
        fs.mkdirSync(path.join(dir, 'dot-claude/skills'), { recursive: true });
        for (const s of picked) {
          fs.cpSync(path.join(skillsDir, s), path.join(dir, 'dot-claude/skills', s), { recursive: true });
        }
        console.log(`  imported skills: ${picked.join(' ')}`);
      }
    }

    // settings.json (+ status line config). Auto-create imports it by
    // default — it carries theme/statusline and never hooks.
    if (interactive) {
      const a = (await ask('Import host settings.json (hooks are stripped)? [Y/n]: ')).trim();
      if (!/^n/i.test(a)) importSettings(dir);
    } else {
      importSettings(dir);
    }
  },
};
