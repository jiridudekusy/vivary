# `.vivary.json` project config + `~/.vivary` home — design spec

**Date:** 2026-07-21 · **Owner:** Jiří Dudek · **Status:** approved, ready for implementation
**Branch:** `egress-plugin` (builds on the egress plugin; presets need it)

## 1. Goal

1. A committable per-project config file **`<workspace>/.vivary.json`** holding
   the full sandbox configuration (agent, VM resources, plugin flags, egress
   policy). Running vivary in that directory uses it as the default config;
   CLI flags that *extend* it are written back (union — never reduction).
2. Rename the home dir **`~/claude-sandboxes` → `~/.vivary`** (auto-migration),
   with **`~/.vivary/vivary.json`** as global defaults (mainly VM: memory,
   cpus, runtime).
3. Built-in **egress presets** for the agents' own APIs: `anthropic`,
   `openai`, `cursor` — so an egress sandbox can talk to its LLM API out of
   the box once the preset is listed.

## 2. Files & precedence

| File | Role |
|---|---|
| `<workspace>/.vivary.json` | Project config, committable. Full sandbox settings. |
| `~/.vivary/vivary.json` | Global defaults. Used ONLY when no project file exists. |
| `~/.vivary/<name>/sandbox.json` | Instance state (as today) + `configApproved` hash. |
| `~/.vivary/<name>/vivary-approved.json` | Verbatim copy of the last approved project config (diff base). |

**Precedence:** CLI flags > `.vivary.json` > (only when no project file)
`~/.vivary/vivary.json` > built-in defaults. The two files do **NOT** merge —
a project file completely replaces the global defaults layer.

When a project file exists, its values also override sticky flags stored in
`sandbox.json` (the file is the source of truth for project defaults); CLI
flags override everything for the invocation and are persisted to BOTH
`sandbox.json` (sticky, as today) and `.vivary.json` (write-back, below).

## 3. Schema

```json
// <workspace>/.vivary.json
{
  "agent": "claude",              // optional
  "runtime": "container",         // optional
  "memory": "8g",                 // optional
  "cpus": "6",                    // optional
  "flags": {                       // sticky plugin flags by flag name
    "egress": true, "ssh": true, "sudo": false
  },
  "egress": {                      // only meaningful with flags.egress
    "presets": ["anthropic"],     // built-in named rule sets
    "allow": ["https://registry.npmjs.org/*"]  // extra URL patterns
  }
}
```

`~/.vivary/vivary.json` supports the same keys except `egress` (policy is
project-scoped). `name` is intentionally NOT in the file — it derives from the
directory/CLI as today, so the file is portable across clones.

Unknown keys: fail loudly (typo protection), do not ignore silently.

## 4. Security: approval gate (agent-writable file!)

The agent inside the sandbox can write `.vivary.json` in the workspace. It
must NOT be able to self-escalate (`--sudo`, egress allow rules) by editing it.

- `sandbox.json` stores `configApproved: <sha256 of file bytes>`;
  `vivary-approved.json` keeps the approved copy for diffing.
- On every `start`/`up`/`shell` with a project file whose hash ≠ approved
  (including first sight): print a unified diff against the approved copy
  (or the whole file on first sight), then:
  - TTY: prompt `[y/N]`; N → die.
  - non-TTY: die loudly with instructions (`run interactively to approve`).
- Approval updates hash + copy. Purely host-side; nothing inside the sandbox
  can approve.
- Write-back changes initiated by CLI flags are auto-approved (the user typed
  the flag = consent) — update file, hash and copy together.

## 5. Write-back (extension only)

- If `.vivary.json` exists and a CLI flag/resource sets something the file
  does not yet have (new flag true, memory/cpus/agent differing): write the
  union back into the file, preserving key order/formatting where practical
  (JSON re-serialize with 2-space indent is fine).
- Never remove or downgrade anything in the file (no reduction — explicitly
  out of scope for now).
- No project file → no write-back (today's behavior; global defaults apply).
- **`vivary init`** — new command: generate `.vivary.json` from the sandbox's
  current effective config (or defaults when no sandbox exists yet) and mark
  it approved. This is the intended creation path.

## 6. Egress policy sync (firewall rules in config)

- On `start`/`up` of an egress sandbox, after `ensureAgent`, sync ASHP rules
  for THIS sandbox's agent to match the config:
  - Effective pattern list = union of expanded `presets` + `allow`.
  - vivary-managed rules are identified by name prefix **`vivary:<sandbox>:`**
    and the agent's `agent_id`. Sync = create missing, delete vivary-prefixed
    rules no longer in the config. Rules without the prefix (hand-made in the
    ASHP UI) are never touched.
  - Rule shape: `{ name, url_pattern, action: 'allow', agent_id }` via
    `POST/DELETE /api/rules` (basic-auth admin; see ashp.mjs `mgmt()`).
- No `egress` section / no project file → no managed rules (deny-all default,
  approval via ASHP UI as before).

## 7. Built-in presets (empirical, not guessed)

`cli/plugins/egress/presets.mjs` exports `{ anthropic: [...], openai: [...],
cursor: [...] }` of URL patterns.

**Method (do this during implementation, don't guess):** for each agent, run
an egress sandbox WITHOUT any allow rules, exercise login + a simple prompt +
(claude) MCP-less basic usage, and harvest the denied hosts from ASHP's log /
GUI API. Minimal-necessary domains only — the preset should make the agent
WORK, not whitelist half the internet (e.g. Statsig/Sentry telemetry: include
only if the agent malfunctions without it). Verify each preset end-to-end:
fresh sandbox + preset → agent completes a prompt round-trip.

Expected ballpark (VERIFY): anthropic → `api.anthropic.com`, auth/OAuth hosts;
openai → `api.openai.com`, `auth.openai.com`, ChatGPT backend for codex;
cursor → `api2.cursor.sh`-family. Document the verified lists in the preset
file with a dated comment.

## 8. `~/claude-sandboxes` → `~/.vivary` migration

- `SANDBOXES_DIR` in `cli/core/util.mjs` → `~/.vivary` (keep any existing env
  override working).
- Auto-migration on any command: old dir exists && new missing →
  `fs.renameSync` + loud notice. Everything inside (`.broker`, `.ashp`,
  per-sandbox dirs) moves with it.
- **`~/.ssh/config` managed blocks reference identity files under the old
  path** — rewrite them during migration (ssh plugin owns the block format).
- Running containers keep working (mounts already bound); new paths apply from
  the next start. Docs/strings mentioning claude-sandboxes: update.

## 9. Implementation phases (each ends with a real verification)

1. **Home rename + migration** (util.mjs, ssh config rewrite, docs). Verify:
   fresh command migrates, `vivary ls` works, ssh into an existing sandbox
   still connects after re-up.
2. **Config loader + precedence** — pure functions (load, validate, precedence
   resolve) exported for unit tests; wire into `ensureSandbox`/`prepare`.
   Unknown-key loud failure. Verify with unit tests + manual matrix (no file /
   project file / global only / CLI overrides).
3. **Approval gate** (hash, approved copy, diff, TTY prompt, non-TTY die).
   Verify: edit file as "agent" → next start shows diff and refuses in
   non-TTY; approve on TTY → starts; unchanged file → silent.
4. **Write-back + `vivary init`**. Verify: `--sudo` on a project with file
   adds `flags.sudo: true` to it (and auto-approves); `vivary init` emits a
   valid, approved file.
5. **Egress sync** (presets.mjs skeleton + rule sync). Verify: config with
   `allow` pattern → rule appears in ASHP (`vivary:` prefix), request passes;
   removing it from config removes the rule; UI-made rule survives sync.
6. **Presets harvested empirically** (method in §7) for anthropic, openai,
   cursor + end-to-end agent round-trip per preset.
7. **Full smoke**: egress sandbox with `.vivary.json` (preset + custom allow +
   ssh) from scratch on Apple runtime; regression: sandbox without any file.

## 10. Conventions

- Match the codebase (see repo CLAUDE.md): plugin API, loud failures, sticky
  flags, code/docs English, commits `Co-Authored-By: Claude Fable 5`.
- `npm install -g ./cli` after CLI changes; `vivary build` after image-side
  changes (this feature is expected to be host-side only — no image change).
- The egress plugin's empirical gotchas are in CLAUDE.md — read before
  touching ASHP integration.
