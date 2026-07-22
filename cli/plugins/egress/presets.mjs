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
  anthropic: [],
  openai: [],
  cursor: [],
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
