#!/usr/bin/env node
// vivary — run AI agents (Claude Code, Codex, Cursor) in isolated containers
// (Docker or Apple `container`) while sharing chat history, login and
// selected configuration with the host.
//
// Architecture: a small core (runtime, sandbox registry, lifecycle, broker
// kernel, image composer) plus plugins (plugins/<name>/) that contribute
// flags, container run args, image fragments, entrypoint hooks and broker
// routes. Agent launchers (slaude, sodex, sursor) dispatch on the binary name.
import path from 'node:path';
import { die, migrateLegacyHome, parseArgs, pkg } from './core/util.mjs';
import { loadPlugins, agentRegistry, pluginCommands, pluginFlagDefs, pluginHelp } from './core/plugins.mjs';
import { cmdBroker } from './core/broker.mjs';
import { cmdBuild } from './core/build.mjs';
import {
  cmdCreate, cmdDown, cmdInit, cmdList, cmdResume, cmdRm, cmdShell, cmdStart, cmdUp,
} from './core/lifecycle.mjs';
import { cmdStats } from './core/stats.mjs';
import { loadMemoryBudget } from './core/config.mjs';

function help(launchers) {
  const launcherLines = Object.entries(launchers)
    .map(([bin, agent]) => `  ${bin} [agent args...]${' '.repeat(Math.max(1, 12 - bin.length))}start a sandboxed ${agent} here (= vivary start)`)
    .join('\n');
  return `vivary ${pkg.version} — sandboxed AI agents in Docker / Apple container

Usage:
  vivary <command> [options]
${launcherLines}

Commands:
  start | run [name]   Start an interactive agent session (auto-creates the
                       sandbox on first use — name and workspace default to
                       the current directory). Extra args go to the agent.
  create [name]        Create a sandbox explicitly, with an interactive
                       import wizard (MCP servers, skills, settings).
  init [name]          Write <workspace>/.vivary.json (committable project
                       config: agent, resources, flags, egress policy) from
                       the sandbox's current config and mark it approved.
  up [name]            Long-running container for something to attach to later.
                       Needs --ssh and/or --tailscale — with neither there is
                       no way in but 'vivary shell' on this Mac, so it refuses.
                       --ssh: Claude Desktop (Code tab -> "+ Add SSH
                       connection"), IDEs, plain ssh.
  down [name]          Stop the container (kept, so anything installed inside
                       survives; 'rm' is what deletes it).
  resume [--dry-run]   Start every sandbox that was up before the host went
                       down (i.e. every one 'up' marked and 'down' did not
                       clear) — run it after a reboot.
  paseo [name]         Show the Paseo URL and password for a sandbox — what you
                       type into the app on a phone or tablet.
  key add <dev> --file <p.pub> | --key "<ssh-...>"
  key ls | key rm <dev>
                       Device SSH keys: register a device's PUBLIC key once and
                       it authorizes EVERY sandbox, present and future — so an
                       iPad/phone needs ONE key instead of one per container.
                       Applied to running sandboxes immediately (no restart).
  ide [name]           Open Cursor/VS Code into the sandbox via Remote-SSH
                       (implies 'up' when needed; --editor <bin> to force).
  ls | list            List sandboxes across runtimes.
  stats [--trim] [--json]
                       How hard the VMs press on this Mac: RAM, CPU, swap,
                       and the kernel tables that have frozen it — open files
                       above all (virtiofs keeps a host file open for every
                       file a guest has cached). --trim makes the sandboxes
                       drop that cache, which releases those files at once.
                       Exits 2 when something is critical.
  shell [name]         Bash in the sandbox (attaches if running, otherwise
                       starts a container; auto-creates like start).
  rm [name] [--purge]  Remove the container (--purge also deletes state).
  build [--pull]       Build the container image (core + all plugins).
                       --pull re-resolves the ubuntu base, so apt/Node/JDK
                       layers refresh too; --no-cache rebuilds everything
                       (slow). Without either, only version-pinned layers
                       (Claude Code, uu-safe-*) pick up new releases.
                       --runtime tart [--force]: build the macOS base VM
                       (vivary-macos-base) that tart sandboxes clone.
  broker [stop]        Run/stop the host broker (usually automatic).
  help, --help         Show this help.
  --version            Show version.

Core options (start/create/up/shell):
  --name <name>        Sandbox name (default: derived from directory name)
  --workspace <dir>    Workspace directory (default: current directory)
  --runtime <r>        docker | container | tart — chosen at creation, stored per
                       sandbox (default: $SANDBOX_RUNTIME, else autodetect)
  --agent <a>          Default agent for the sandbox
  --memory <m>         Container memory (default: $SANDBOX_MEMORY or 4g). Sticky.
                       All running VMs together may be configured for at most
                       half the Mac's RAM — set "memoryBudget" ("60%", "40g")
                       in ~/.vivary/vivary.json; a start over it is refused.
  --ignore-memory-budget
                       Start this once even if it goes over the budget.
  --cpus <n>           Container CPUs (default: $SANDBOX_CPUS or 4)
  --ephemeral[=off]    Throw the container away on exit (the pre-persistence
                       behaviour). Sticky. By default containers are KEPT, so
                       apt/npm installs, kind, kubectl and docker images inside
                       survive down/up; only the sandbox state mounts used to.
  --recreate           Rebuild a kept container from the image once. Needed
                       after changing flags that are baked in at creation
                       (env, mounts, caps, memory) — vivary refuses to restart
                       a container whose settings no longer match and says so.

Plugin options:
${pluginHelp()}

Examples:
  cd ~/work/myproj && slaude          # sandboxed claude for this project
  slaude -r                           # ...resume picker (args go to claude)
  vivary start --headed -- -c            # headed + claude --continue
  vivary up && ssh claude-sandbox-myproj # ssh into the sandbox
  vivary ls                              # all sandboxes, both runtimes

Project config: <workspace>/.vivary.json (committable; created by 'vivary
init', changes are reviewed+approved on start). Global defaults (used only
without a project file): ~/.vivary/vivary.json.
State lives in ~/.vivary/<name>/ (login, settings, skills, ssh keys).
Chat history is shared with the host's ~/.claude/projects — visible from
host Claude Code and vice versa. See README for details.`;
}

async function main() {
  migrateLegacyHome();
  await loadPlugins();
  const { launchers } = agentRegistry();

  const argv0 = path.basename(process.argv[1] || '').replace(/\.mjs$/, '');
  const argv = process.argv.slice(2);

  // Agent launchers: our flags are parsed, everything unknown goes to the agent.
  const forcedAgent = launchers[argv0];
  if (forcedAgent) {
    if (argv[0] === '--help' || argv[0] === 'help') {
      console.log(`${argv0} — sandboxed ${forcedAgent} in the current directory (wraps 'vivary start')\n`);
      console.log(help(launchers));
      return;
    }
    await cmdStart(argv, forcedAgent);
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  const extra = pluginCommands();
  switch (cmd) {
    case 'start':
    case 'run':
      await cmdStart(rest);
      break;
    case 'create':
      await cmdCreate(rest);
      break;
    case 'init':
      await cmdInit(rest);
      break;
    case 'up':
      await cmdUp(rest);
      break;
    case 'resume':
      await cmdResume(rest);
      break;
    case 'down':
      cmdDown(rest);
      break;
    case 'ls':
    case 'list':
      cmdList();
      break;
    case 'stats':
      cmdStats(rest, { loadGlobalBudget: () => loadMemoryBudget(pluginFlagDefs()) });
      break;
    case 'shell':
      await cmdShell(rest);
      break;
    case 'rm':
      await cmdRm(rest);
      break;
    case 'build':
      cmdBuild(rest);
      break;
    case 'broker':
      cmdBroker(rest);
      break;
    case '--version':
    case 'version':
      console.log(pkg.version);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(help(launchers));
      break;
    default:
      if (extra[cmd]) {
        await extra[cmd](rest);
        break;
      }
      die(`unknown command: ${cmd} (see 'vivary help')`);
  }
}

main().catch((e) => die(e.message || String(e)));
