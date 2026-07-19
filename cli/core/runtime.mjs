// Container runtime abstraction: Docker and Apple `container`.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, capture, die, hasCmd } from './util.mjs';

export function detectRuntime() {
  if (process.env.SANDBOX_RUNTIME) return process.env.SANDBOX_RUNTIME;
  if (hasCmd('container')) return 'container';
  if (hasCmd('docker')) return 'docker';
  die("neither 'container' nor 'docker' found on PATH");
}

export function containerName(name) {
  return `claude-sandbox-${name}`;
}

// Names of running containers, per runtime. Missing runtime -> empty set.
export function runningSet(runtime) {
  if (!hasCmd(runtime)) return new Set();
  if (runtime === 'docker') {
    const { status, stdout } = capture('docker', ['ps', '--format', '{{.Names}}']);
    return new Set(status === 0 ? stdout.split('\n').filter(Boolean) : []);
  }
  const { status, stdout } = capture('container', ['ls']);
  if (status !== 0) return new Set();
  return new Set(
    stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
  );
}

export function isRunning(runtime, name) {
  return runningSet(runtime).has(containerName(name));
}

// Local DNS domain assigned to Apple `container` VMs (empty if unconfigured).
export function containerDnsDomain() {
  try {
    const toml = fs.readFileSync(path.join(HOME, '.config/container/config.toml'), 'utf8');
    const m = toml.match(/^\s*domain\s*=\s*"([^"]+)"/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// Pass the host terminal's capabilities, otherwise the TUI degrades to 16
// colors (illegible menus on themed terminals).
export function termEnvArgs() {
  return [
    '-e', `TERM=${process.env.TERM || 'xterm-256color'}`,
    '-e', `COLORTERM=${process.env.COLORTERM || 'truecolor'}`,
  ];
}
