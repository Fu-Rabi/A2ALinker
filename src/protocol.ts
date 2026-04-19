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

export function renderHttpWalkieTalkieRules(): string {
  return WALKIE_TALKIE_RULE_LINES.join('\n');
}
