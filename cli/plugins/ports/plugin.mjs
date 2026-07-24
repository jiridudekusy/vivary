// ports: publish a sandbox port on the host, docker-style.
//
//   vivary up -p 8080:80 -p 3000                 (repeatable, sticky)
//   .vivary.json: { "flags": { "publish": ["8080:80", "3000"] } }
//
// Docker and Apple `container` both accept the same spec shape
// ([host-ip:]host-port:container-port[/proto]) so the value passes straight
// through as -p. One deliberate deviation from docker: with no host-ip the
// port binds 127.0.0.1, not every interface — a sandbox is untrusted (the
// agent owns the workspace) and a service in it should not appear on the LAN
// by accident. Write 0.0.0.0:8080:80 to publish deliberately.
//
// tart has no publish mechanism at all: a macOS guest sits on vmnet with its
// own IP, which the host can already reach directly. So there the plugin only
// resolves and prints the guest URL (host port is not honoured).
import { die } from '../../core/util.mjs';
import { runtimeKind, resolveRuntime } from '../../core/runtimes/index.mjs';

export const DEFAULT_BIND = '127.0.0.1';

// Parse one publish spec into its parts. Accepted:
//   PORT                       -> same port on both sides
//   HOST:CONTAINER             -> host port : container port
//   HOST_IP:HOST:CONTAINER     -> explicit bind address
// any of the above with a /tcp or /udp suffix.
// Throws (pure, unit-tested); the flag/normalize path turns it into a die.
export function parsePublish(spec) {
  const raw = String(spec).trim();
  const m = raw.match(/^(.*?)(?:\/(tcp|udp))?$/i);
  const proto = (m[2] || 'tcp').toLowerCase();
  const parts = m[1].split(':');
  if (parts.some((p) => p === '') || parts.length > 3) {
    throw new Error(`--publish '${spec}': expected [host-ip:]host-port:container-port[/tcp|udp]`);
  }
  const port = (v, what) => {
    if (!/^\d+$/.test(v)) throw new Error(`--publish '${spec}': ${what} '${v}' is not a port number`);
    const n = Number(v);
    if (n < 1 || n > 65535) throw new Error(`--publish '${spec}': ${what} ${n} is out of range (1-65535)`);
    return n;
  };
  if (parts.length === 1) {
    const p = port(parts[0], 'port');
    return { hostIp: DEFAULT_BIND, hostPort: p, containerPort: p, proto };
  }
  if (parts.length === 2) {
    return {
      hostIp: DEFAULT_BIND, hostPort: port(parts[0], 'host port'),
      containerPort: port(parts[1], 'container port'), proto,
    };
  }
  return {
    hostIp: parts[0], hostPort: port(parts[1], 'host port'),
    containerPort: port(parts[2], 'container port'), proto,
  };
}

// Render back into the runtime's -p value (docker == Apple container here).
export function renderPublish(p) {
  return `${p.hostIp}:${p.hostPort}:${p.containerPort}/${p.proto}`;
}

// Sticky config value -> spec list. A single string is accepted so
// "publish": "8080:80" in .vivary.json behaves like a one-element array.
export function publishList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((s) => String(s).trim()).filter(Boolean);
}

export default {
  name: 'ports',
  order: 25,
  flags: {
    publish: {
      type: 'list',
      short: 'p',
      sticky: true,
      cfgKey: 'publish',
      normalize(v) {
        const specs = publishList(v);
        try {
          specs.forEach(parsePublish); // validate now, not at container start
        } catch (e) {
          die(e.message);
        }
        return specs.length ? specs : false;
      },
      help: 'Publish a sandbox port on the host (sticky, repeatable),\n'
        + 'docker syntax: -p 8080:80, -p 3000, -p 0.0.0.0:80:80.\n'
        + 'Without a host IP the port binds 127.0.0.1 only — a\n'
        + 'sandbox service is not exposed to the LAN by accident.\n'
        + 'tart (macOS VM): no publish exists, the guest IP is\n'
        + 'printed instead and the host port is ignored.',
    },
  },

  runArgs({ cfg, log }) {
    const specs = publishList(cfg.publish);
    if (!specs.length || runtimeKind(cfg.runtime) === 'vm-tart') return [];
    const args = [];
    for (const spec of specs) {
      const p = parsePublish(spec);
      args.push('-p', renderPublish(p));
      log(`==> port: http://${p.hostIp}:${p.hostPort} -> sandbox :${p.containerPort}/${p.proto}`);
    }
    return args;
  },

  // tart: nothing to publish — report where the service actually is.
  async vmPostUp(ctx) {
    const { cfg, log } = ctx;
    const specs = publishList(cfg.publish);
    if (!specs.length) return;
    const rt = resolveRuntime(cfg.runtime);
    const ip = rt.ip(rt.instanceName(cfg.name));
    for (const spec of specs) {
      const p = parsePublish(spec);
      log(ip
        ? `    port: http://${ip}:${p.containerPort} (tart has no publish — reach the guest directly`
          + `${p.hostPort === p.containerPort ? '' : `; host port ${p.hostPort} ignored`})`
        : `    port :${p.containerPort} — could not resolve the guest IP yet (vivary ls)`);
    }
  },
};
