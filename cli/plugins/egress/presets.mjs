// Built-in egress presets: the minimal URL patterns each agent needs to talk
// to its own API (login + prompt round-trip) through the default-deny ASHP
// proxy. Patterns are ASHP url_pattern values (Go regex, matched unanchored
// against scheme://host/path — the `host/*` form matches like the rules the
// policy UI itself creates).
//
// The lists are harvested EMPIRICALLY (run the agent behind deny-all, collect
// the denied hosts from ASHP's request log, keep the minimal set that makes
// the agent work) — see the dated comments per preset. Telemetry hosts are
// included only when the agent malfunctions without them.
export const PRESETS = {
  // Harvested 2026-07-22 (Claude Code 2.1.216 behind deny-all ASHP):
  // denied were api.anthropic.com (v1/messages + bootstrap/settings/oauth
  // profile) and platform.claude.com/v1/oauth/token (OAuth token refresh —
  // without it stored credentials fail with "Failed to authenticate" once
  // the access token expires). Verified end-to-end: fresh sandbox + this
  // preset -> prompt round-trip. Not needed for a round-trip (left out):
  // downloads.claude.ai + raw.githubusercontent.com/anthropics/claude-code
  // (auto-update assets), statsig/sentry telemetry.
  anthropic: [
    'api.anthropic.com/*',
    'platform.claude.com/*',
  ],
  // Harvested 2026-07-22 (Codex CLI, ChatGPT-subscription auth_mode, behind
  // deny-all ASHP): every denied request went to chatgpt.com/backend-api/*
  // (codex/responses websocket+https, codex/models, plugins, analytics).
  // Verified end-to-end: fresh sandbox + this preset -> `codex exec` round-
  // trip. api.openai.com (API-key auth mode) and auth.openai.com (OAuth
  // login/refresh) did NOT occur in the harvest (token was fresh) — they are
  // OpenAI's documented endpoints for those flows, included UNVERIFIED so
  // the preset also covers API-key users and token refresh.
  // NOTE: codex first tries a WebSocket transport (wss://chatgpt.com/...)
  // which does not survive the ASHP MITM; it falls back to HTTPS by itself
  // (slower start, ~15 s of retries, then works).
  openai: [
    'chatgpt.com/*',
    'api.openai.com/*',
    'auth.openai.com/*',
  ],
  // Harvested 2026-07-22 (cursor-agent 2026.07.20 behind deny-all ASHP):
  // the deny log showed api2.cursor.sh (dashboard/auth/analytics),
  // api3.cursor.sh, agentn.global.api5.cursor.sh (the agent LLM backend;
  // the api5 pattern also covers regional variants) and repo42.cursor.sh
  // (repo indexing handshake). downloads.cursor.com (CLI self-update) left
  // out. UNVERIFIED end-to-end: the api5 agent backend is HTTP/2-only
  // (curl --http1.1 against it fails even directly), and ASHP's transparent
  // proxy forwards upstream as HTTP/1.1 — so cursor-agent currently CANNOT
  // complete a prompt round-trip through ASHP regardless of the allow list
  // (it loops on "Connection lost, reconnecting"). Preset kept for the day
  // ASHP learns h2 upstream; api2-only traffic (login, dashboard) works.
  cursor: [
    'api2.cursor.sh/*',
    'api3.cursor.sh/*',
    'api5.cursor.sh/*',
    'repo42.cursor.sh/*',
  ],
};

// Expand preset names to a flat pattern list; unknown names die loudly.
export function expandPresets(names = []) {
  const patterns = [];
  for (const name of names) {
    const preset = PRESETS[name];
    if (!preset) {
      throw new Error(`unknown egress preset '${name}' (available: ${Object.keys(PRESETS).join(', ')})`);
    }
    patterns.push(...preset);
  }
  return patterns;
}
