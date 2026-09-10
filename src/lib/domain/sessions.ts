import type { SessionData, SessionDraft } from './types';
import { emptyDoc } from './defaults';
export const emptySessionDraft = (): SessionDraft => ({
  body: emptyDoc(),
  category: 'observation',
  expected: '',
  actual: '',
});
export function sessionSeconds(data: SessionData, now = Date.now()): number {
  const anchor = Date.parse(data.activeSince ?? '');
  const elapsed =
    data.state === 'active' && Number.isFinite(anchor)
      ? Math.max(0, Math.floor((now - anchor) / 1000))
      : 0;
  return Math.max(0, data.durationSeconds) + elapsed;
}
export function transitionSession(
  data: SessionData,
  state: SessionData['state'],
  now = Date.now(),
): SessionData {
  const at = new Date(now).toISOString();
  return {
    ...data,
    state,
    durationSeconds: sessionSeconds(data, now),
    activeSince: state === 'active' ? at : undefined,
    endedAt: state === 'completed' ? at : undefined,
  };
}
export function checkpointSession(data: SessionData, now = Date.now()): SessionData {
  if (data.state !== 'active') return data;
  return {
    ...data,
    durationSeconds: sessionSeconds(data, now),
    activeSince: new Date(now).toISOString(),
  };
}
export function formatSessionTime(seconds: number) {
  const total = Math.floor(Math.max(0, seconds));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
