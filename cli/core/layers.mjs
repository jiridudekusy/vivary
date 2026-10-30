// Where a sandbox's settings come from. Highest first:
//
//   cli        — flags of this invocation
//   project    — <workspace>/.vivary.json (approved)
//   sandbox    — what was set on this sandbox's own command line before
//                (sticky, sandbox.json)
//   profile:X  — named profiles (~/.vivary/profiles/X.json); of several, the
//                one listed LAST wins
//   default    — ~/.vivary/vivary.json, and only when the workspace has NO
//                .vivary.json
//   built-in
//
// Something set by hand on a sandbox outranks its profiles: a profile is a
// starting point, `vivary up x --memory 20g` is a decision about x. Lists
// (--publish, --volume) from profiles and the default are ADDED to the list of
// the winning layer, and the inner dockerd's daemon.json merges key by key, so
// a profile can contribute a port or a registry without owning the whole list.
// agent and runtime are not resolved here: profiles and the default SEED them
// when a sandbox is created (creationSeeds), after that they are the
// sandbox's own — switching runtime means another machine.
//
// Pure (apart from flag normalizers that die on a bad value); unit-tested.
import { die } from './util.mjs';

// A sticky flag's stored value. 'origin' says who wrote the raw value — 'cli'
// a human, 'file' the agent-writable .vivary.json, 'profile' the user's own
// profiles — because flags that hand out host access (mounts) trust them
// differently. A boolean takes on/off as well: `--headed=off` is how a
// sandbox turns off what one of its profiles turns on (it used to read as ON —
// any string was truthy).
export function normalizeFlag(def, value, origin = 'cli') {
  if (value === undefined) return undefined;
  if (def.normalize) return def.normalize(value, { origin });
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['on', 'true', '1', 'yes', ''].includes(s)) return true;
    if (['off', 'false', '0', 'no'].includes(s)) return false;
    return die(`expected on|off, got '${value}'`);
  }
  return !!value;
}

const isOn = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
const asList = (v) => (Array.isArray(v) ? v : []);
const union = (...lists) => {
  const out = [];
  for (const item of lists.flat()) {
    if (!out.some((x) => JSON.stringify(x) === JSON.stringify(item))) out.push(item);
  }
  return out;
};

// Has this sandbox decided about the flag itself? A stored false is how every
// flag nobody mentioned looks (createSandbox writes them all), so only an ON
// value counts — or an explicit off, recorded in flagsOff.
export function stickySet(sticky, key) {
  return (sticky.flagsOff || []).includes(key) || isOn(sticky[key]);
}

// The profiles a sandbox uses, in order: its own (--profile), then those its
// .vivary.json names. A name listed twice counts once, where it first appears.
export function profileNames(own = [], fromProject = []) {
  return [...new Set([...asList(own), ...asList(fromProject)])];
}

// daemon.json merge: objects key by key, arrays as a union, anything else
// replaced by the higher layer.
export function mergeDockerd(lower, higher) {
  if (Array.isArray(lower) && Array.isArray(higher)) return union(lower, higher);
  if (lower && higher && typeof lower === 'object' && typeof higher === 'object'
      && !Array.isArray(lower) && !Array.isArray(higher)) {
    const out = { ...lower };
    for (const [k, v] of Object.entries(higher)) out[k] = k in out ? mergeDockerd(out[k], v) : v;
    return out;
  }
  return higher;
}

// The layers under the sandbox's own settings, lowest first.
export function baseLayers({ project = null, profiles = [], global = null } = {}) {
  return [
    ...(project || !global ? [] : [{ source: 'default', config: global, origin: 'file' }]),
    ...profiles.map((p) => ({ source: `profile:${p.name}`, config: p.config || {}, origin: 'profile' })),
  ];
}

// Resolve everything for one invocation. Returns
//   flags:   { <flag>: { key, value, source } } for every sticky plugin flag
//            (value undefined = nobody said anything and the sandbox never
//            stored it — left untouched for legacy inference)
//   memory, cpus, agent: { value, source } (value undefined = built-in)
//   egress:  { presets, allow } | null
//   dockerd: { value, sources }
export function resolveLayers({ cliFlags = {}, project = null, sticky = {}, profiles = [], global = null, defs = {} } = {}) {
  const base = baseLayers({ project, profiles, global });
  const top = base.slice().reverse();
  const out = { flags: {} };

  for (const [flag, def] of Object.entries(defs)) {
    if (!def.sticky) continue;
    const key = def.cfgKey || flag;
    let pick;
    if (cliFlags[flag] !== undefined) pick = { value: normalizeFlag(def, cliFlags[flag], 'cli'), source: 'cli' };
    else if (project?.flags?.[flag] !== undefined) {
      pick = { value: normalizeFlag(def, project.flags[flag], 'file'), source: 'project' };
    } else if (stickySet(sticky, key)) pick = { value: sticky[key], source: 'sandbox' };
    else {
      const layer = top.find((l) => l.config.flags?.[flag] !== undefined);
      if (layer) pick = { value: normalizeFlag(def, layer.config.flags[flag], layer.origin), source: layer.source };
    }
    if (def.type === 'list') {
      const adds = base.filter((l) => l.config.flags?.[flag] !== undefined && l.source !== pick?.source)
        .map((l) => ({ source: l.source, items: asList(normalizeFlag(def, l.config.flags[flag], l.origin)) }))
        .filter((a) => a.items.length);
      if (adds.length) {
        const items = union(asList(pick?.value), ...adds.map((a) => a.items));
        pick = {
          value: items.length ? items : false,
          source: [...(isOn(pick?.value) ? [pick.source] : []), ...adds.map((a) => a.source)].join(' + '),
        };
      }
    }
    out.flags[flag] = { key, ...(pick || { value: sticky[key], source: 'built-in' }) };
  }

  for (const key of ['memory', 'cpus', 'agent']) {
    if (cliFlags[key] !== undefined) out[key] = { value: cliFlags[key], source: 'cli' };
    else if (project?.[key] !== undefined) out[key] = { value: project[key], source: 'project' };
    else if (sticky[key] !== undefined) out[key] = { value: sticky[key], source: 'sandbox' };
    else {
      const layer = top.find((l) => l.config[key] !== undefined);
      out[key] = layer ? { value: layer.config[key], source: layer.source } : { value: undefined, source: 'built-in' };
    }
  }

  const egressFrom = [...base, ...(project ? [{ source: 'project', config: project }] : [])]
    .filter((l) => l.config.egress);
  out.egress = egressFrom.length
    ? {
      presets: union(...egressFrom.map((l) => asList(l.config.egress.presets))),
      allow: union(...egressFrom.map((l) => asList(l.config.egress.allow))),
    }
    : null;

  const dockerdFrom = [...base, ...(project ? [{ source: 'project', config: project }] : [])]
    .filter((l) => l.config.dockerd && Object.keys(l.config.dockerd).length);
  out.dockerd = {
    value: dockerdFrom.reduce((acc, l) => mergeDockerd(acc, l.config.dockerd), {}),
    sources: dockerdFrom.map((l) => l.source),
  };
  return out;
}

// agent and runtime for a NEW sandbox: the command line, else the profiles it
// is created with (last wins), else the default file — which, as everywhere,
// counts only when the workspace has no .vivary.json. That file is not used
// here even when present: it is agent-writable and gets approved only once
// the sandbox exists.
export function creationSeeds({ cliFlags = {}, project = null, profiles = [], global = null } = {}) {
  const top = baseLayers({ project, profiles, global }).reverse();
  const seed = {};
  for (const key of ['agent', 'runtime']) {
    seed[key] = cliFlags[key] ?? top.find((l) => l.config[key] !== undefined)?.config[key];
  }
  return seed;
}
