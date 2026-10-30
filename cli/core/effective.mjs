// A sandbox's settings as a start resolves them (see layers.mjs), for the
// start path itself and for commands that only read them (`vivary config`,
// `vivary headed`, ...).
import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVED_COPY_NAME, PROJECT_CONFIG_NAME, loadGlobalConfig, loadProfile, parseConfig,
} from './config.mjs';
import { profileNames, resolveLayers } from './layers.mjs';
import { pluginFlagDefs } from './plugins.mjs';
import { applyResolvedFlags, loadSandbox, sandboxDir } from './sandbox.mjs';

export const loadProfiles = (names, knownFlags) => names.map((n) => loadProfile(n, knownFlags));

// Resolve the layers for a sandbox. `project` is the parsed .vivary.json that
// applies (approved), or null when the workspace has none — which is also the
// only case the default file counts.
export function resolveFor(cfg, { cliFlags = {}, project = null, knownFlags = pluginFlagDefs() } = {}) {
  const global = project ? null : loadGlobalConfig(knownFlags)?.config || null;
  const names = profileNames(cfg.profiles, project?.profiles);
  const profiles = loadProfiles(names, knownFlags);
  return resolveLayers({ cliFlags, project, sticky: cfg, profiles, global, defs: knownFlags });
}

// The project file as last APPROVED, for commands that read settings without
// the approval prompt. A file that exists but was never approved has applied
// nothing yet — it still counts as present, so the defaults do not apply.
export function approvedProject(cfg, knownFlags = pluginFlagDefs()) {
  if (!fs.existsSync(path.join(cfg.workspace, PROJECT_CONFIG_NAME))) return null;
  const copy = path.join(sandboxDir(cfg.name), APPROVED_COPY_NAME);
  try {
    return parseConfig(fs.readFileSync(copy, 'utf8'), { scope: 'project', file: copy, knownFlags });
  } catch {
    return {};
  }
}

// loadSandbox, with every layer applied the way the next start sees it. The
// resolution (with sources) rides along as the non-enumerable `resolved`.
export function effectiveSandbox(name) {
  const cfg = loadSandbox(name);
  if (!cfg) return null;
  const knownFlags = pluginFlagDefs();
  const project = approvedProject(cfg, knownFlags);
  const resolved = resolveFor(cfg, { project, knownFlags });
  applyResolvedFlags(cfg, resolved);
  Object.defineProperty(cfg, 'resolved', { value: resolved, enumerable: false, configurable: true });
  Object.defineProperty(cfg, 'projectConfig', { value: project, enumerable: false, configurable: true });
  return cfg;
}
