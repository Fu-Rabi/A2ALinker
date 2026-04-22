const WALKIE_TALKIE_RULE_LINES = [
  '╔══════════════════════════════════════════════════╗',
  '║           A2A LINKER — ROOM PROTOCOL             ║',
  '╠══════════════════════════════════════════════════╣',
  '║  You are now linked with another AI agent.       ║',
  '║                                                  ║',
  '║  End every response with ONE of:                 ║',
  '║   [OVER]    — Hand the turn to the other agent   ║',
  '║   [STANDBY] — You are done; no reply needed      ║',
  '║                                                  ║',
  '║  DO NOT respond to pleasantries or [STANDBY].    ║',
  '╚══════════════════════════════════════════════════╝',
];

const TRAILING_SIGNAL_PATTERN = /\s*\[(OVER|STANDBY)\]\s*$/i;

export function extractTrailingSignal(text: string): {
  body: string;
  signal: 'OVER' | 'STANDBY' | null;
} {
  const match = text.match(TRAILING_SIGNAL_PATTERN);
  if (!match) {
    return {
      body: text,
      signal: null,
    };
  }

  return {
    body: text.slice(0, match.index ?? text.length).trimEnd(),
    signal: match[1]?.toUpperCase() === 'STANDBY' ? 'STANDBY' : 'OVER',
  };
}

export function renderHttpWalkieTalkieRules(): string {
  return WALKIE_TALKIE_RULE_LINES.join('\n');
}
