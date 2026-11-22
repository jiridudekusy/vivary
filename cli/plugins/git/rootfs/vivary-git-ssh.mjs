#!/usr/bin/env node
// vivary-git-ssh: git's ssh command inside the sandbox (core.sshCommand, set
// by the vivary git proxy). It never connects to the git host: it hands the
// request to the vivary broker on the Mac, which checks the repository and the
// refs and runs ssh there with the Mac's keys. No key exists in the sandbox.
//
// Called like OpenSSH (ssh.variant = ssh):
//   vivary-git-ssh [-o opt]... [-p port] [-4|-6] [user@]host "git-upload-pack '/path'"
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

export function parseSshArgs(argv) {
  let port = '22';
  let dest = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (dest === null) {
      if (a === '-p') { port = argv[++i]; continue; }
      if (a.startsWith('-p') && a.length > 2) { port = a.slice(2); continue; }
      if (a === '-o' || a === '-l' || a === '-i' || a === '-F') { i++; continue; }
      if (/^-[46TAaqtvx]+$/.test(a)) continue;
      if (a.startsWith('-')) continue;
      dest = a;
      continue;
    }
    rest.push(a);
  }
  if (!dest) return null;
  const at = dest.lastIndexOf('@');
  return { user: at >= 0 ? dest.slice(0, at) : 'git', host: at >= 0 ? dest.slice(at + 1) : dest, port, command: rest.join(' ') };
}

function brokerUrl() {
  let u = process.env.SBX_OPEN_URL;
  if (!u) {
    try {
      const m = fs.readFileSync(`${os.homedir()}/.sandbox-open.env`, 'utf8').match(/^SBX_OPEN_URL=(.+)$/m);
      if (m) u = m[1].trim();
    } catch { /* none */ }
  }
  return new URL(u || 'http://host.docker.internal:7377/');
}

function token() {
  try { return fs.readFileSync('/run/vivary/broker-token', 'utf8').trim(); } catch { return process.env.SBX_OPEN_TOKEN || ''; }
}

function main() {
  const req = parseSshArgs(process.argv.slice(2));
  if (!req || !req.command) {
    process.stderr.write('vivary-git-ssh: only git fetch/push go through the vivary git proxy\n');
    return process.exit(255);
  }
  const url = brokerUrl();
  const sock = net.connect({ host: url.hostname, port: Number(url.port || 80), allowHalfOpen: true });
  sock.on('error', (e) => {
    process.stderr.write(`vivary-git-ssh: cannot reach the vivary broker (${e.code || e.message})\n`);
    process.exit(255);
  });
  sock.on('connect', () => {
    sock.write(['GET /git-ssh HTTP/1.1', 'Host: vivary', 'Connection: Upgrade', 'Upgrade: vivary-git',
      `x-vivary-token: ${token()}`, `x-git-host: ${req.host}`, `x-git-port: ${req.port}`, `x-git-user: ${req.user}`,
      `x-git-command: ${Buffer.from(req.command).toString('base64')}`, '', ''].join('\r\n'));
  });
  let buf = Buffer.alloc(0);
  let upgraded = false;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headText = buf.subarray(0, end).toString('latin1');
      const status = Number(headText.split(' ')[1]);
      if (status !== 101) {
        process.stderr.write(buf.subarray(end + 4).toString('utf8') || `vivary-git-ssh: broker said ${status}\n`);
        sock.destroy();
        return process.exit(status === 403 ? 1 : 255);
      }
      upgraded = true;
      buf = buf.subarray(end + 4);
      process.stdin.pipe(sock);
    }
    while (buf.length >= 5) {
      const type = buf[0];
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (type === 1) process.stdout.write(payload);
      else if (type === 2) process.stderr.write(payload);
      else if (type === 3) {
        const code = payload[0];
        process.stdout.end(() => process.exit(code));
        return undefined;
      }
    }
    return undefined;
  });
  sock.on('end', () => { if (!upgraded) process.exit(255); });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('vivary-git-ssh')) main();
