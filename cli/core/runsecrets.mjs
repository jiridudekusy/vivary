// Secrets a container needs, handed in at every start onto a tmpfs — RAM only.
//
// Every new container gets `--tmpfs /run/vivary` (runtimes/spec.mjs). After it
// starts, the host writes each secret there through `<runtime> exec -i --user
// root`, the value on stdin: never in argv (visible in `ps`), never in `-e`
// (baked into the container's config — Apple's config.json, `docker inspect`
// — i.e. in plaintext on the Mac's disk for the container's whole life), never
// in a file on the Mac. A stop empties the tmpfs; the next start hands them in
// again, fresh.
//
// A kept container created before this has no such tmpfs: `putRunSecret`
// reports 'legacy' and writes nothing, and the caller keeps the old way for it
// until `vivary up --recreate`.
import { capture } from './util.mjs';

export const RUN_DIR = '/run/vivary';

// Is /run/vivary a tmpfs in this running container?
export function hasRunTmpfs(runtime, cname, { run = capture } = {}) {
  const r = run(runtime, ['exec', '--user', 'root', cname, 'sh', '-c',
    `awk '$2 == "${RUN_DIR}" { print $3 }' /proc/mounts`], { timeout: 30000 });
  return r.status === 0 && r.stdout.trim() === 'tmpfs';
}

// Write <RUN_DIR>/<name> = content, owned by `owner`, mode 0600, atomically.
// Returns 'tmpfs', or 'legacy' when the container has no tmpfs there.
// Throws when the write itself fails (loud: a missing secret looks like a
// broken feature otherwise).
export function putRunSecret(runtime, cname, name, content, { owner = 'agent', run = capture, probed } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`bad secret name '${name}'`);
  if (!/^[a-z_][a-z0-9_-]*$/.test(owner)) throw new Error(`bad owner '${owner}'`);
  if (!(probed ?? hasRunTmpfs(runtime, cname, { run }))) return 'legacy';
  const f = `${RUN_DIR}/${name}`;
  const r = run(runtime, ['exec', '-i', '--user', 'root', cname, 'sh', '-c',
    `umask 077 && cat > ${f}.new && chown ${owner}:${owner} ${f}.new && mv ${f}.new ${f}`],
  { input: content, timeout: 30000 });
  if (r.status !== 0) throw new Error(`could not hand ${name} to ${cname}: ${(r.stderr || r.stdout).trim()}`);
  return 'tmpfs';
}
