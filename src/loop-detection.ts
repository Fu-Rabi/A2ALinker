export const SHORT_MESSAGE_BYTES = 60;
export const LOOP_DETECTION_THRESHOLD = 8;

export interface LoopDetectionState {
  recentShortMessageCount: number;
}

export function trackOutgoingMessage(state: LoopDetectionState, messageLength: number): boolean {
  if (messageLength < SHORT_MESSAGE_BYTES) {
    state.recentShortMessageCount += 1;
  } else {
    state.recentShortMessageCount = 0;
  }

  return state.recentShortMessageCount >= LOOP_DETECTION_THRESHOLD;
}

export function resetLoopCounter(state: LoopDetectionState): void {
  state.recentShortMessageCount = 0;
}
