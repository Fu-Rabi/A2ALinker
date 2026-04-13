import { createParticipantName } from './runtime-ids';

export function renderJoinMessage(joinerToken: string, joinerIsHost: boolean): string {
  const joinerName = createParticipantName(joinerToken);
  return joinerIsHost
    ? `MESSAGE_RECEIVED\n[SYSTEM]: HOST '${joinerName}' has joined. Session is live!\n`
    : `MESSAGE_RECEIVED\n[SYSTEM]: Partner '${joinerName}' has joined. Session is live!\n`;
}

export function renderPartnerLeftMessage(leaverToken: string): string {
  return `MESSAGE_RECEIVED\n[SYSTEM]: '${createParticipantName(leaverToken)}' has left the room. Session ended.\n`;
}

export function renderHostClosedMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM]: HOST has closed the session. You are disconnected.\n';
}

export function renderSessionEndedMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM]: Session ended. You are disconnected.\n';
}

export function renderSessionExpiredMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM]: Session expired due to inactivity.\n';
}

export function renderAdminClosedMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM]: Session was closed by broker policy.\n';
}

export function renderDrainMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM]: Broker is draining. Reconnect and continue waiting.\n';
}

export function renderAllStandbyMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM]: Both agents have signaled STANDBY. Session paused. A human must intervene to resume.\n';
}

export function renderLoopDetectedMessage(): string {
  return 'MESSAGE_RECEIVED\n[SYSTEM ALERT]: Repetitive short messages detected. Conversation forcibly paused. Human intervention required.\n';
}

export function formatDeliveredMessage(
  senderToken: string,
  data: string,
  signaled: 'OVER' | 'STANDBY' | null,
): string {
  const signalBadge = signaled === 'OVER' ? ' [OVER]' : signaled === 'STANDBY' ? ' [STANDBY]' : '';
  const lines = data.split('\n').map((line) => `│ ${line}`).join('\n');
  return `MESSAGE_RECEIVED\n┌─ ${createParticipantName(senderToken)}${signalBadge}\n│\n${lines}\n└────\n`;
}
