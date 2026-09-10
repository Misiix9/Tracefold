import { describe, it, expect } from 'vitest';
import { defaultData } from './defaults';
import { checkpointSession, sessionSeconds, transitionSession } from './sessions';
const start = Date.parse('2026-09-09T12:00:00Z');
describe('exploratory session clock', () => {
  it('excludes pauses and preserves accumulated time across resume', () => {
    const active = { ...defaultData('session'), activeSince: new Date(start).toISOString() };
    const paused = transitionSession(active, 'paused', start + 90000);
    expect(sessionSeconds(paused, start + 3600000)).toBe(90);
    const resumed = transitionSession(paused, 'active', start + 3600000);
    expect(sessionSeconds(resumed, start + 3615000)).toBe(105);
  });
  it('checkpoints without counting the same interval twice', () => {
    const active = { ...defaultData('session'), activeSince: new Date(start).toISOString() };
    const checkpoint = checkpointSession(active, start + 15000);
    expect(checkpoint.durationSeconds).toBe(15);
    expect(sessionSeconds(checkpoint, start + 30000)).toBe(30);
  });
  it('completion freezes the clock and reopening starts a fresh interval', () => {
    const active = { ...defaultData('session'), activeSince: new Date(start).toISOString() };
    const completed = transitionSession(active, 'completed', start + 45000);
    expect(completed.endedAt).toBe(new Date(start + 45000).toISOString());
    expect(sessionSeconds(completed, start + 90000)).toBe(45);
    expect(transitionSession(completed, 'active', start + 90000).endedAt).toBeUndefined();
  });
  it('does not invent elapsed time for old records or backwards clocks', () => {
    expect(
      sessionSeconds(
        { ...defaultData('session'), activeSince: undefined, durationSeconds: 42 },
        start,
      ),
    ).toBe(42);
    expect(
      sessionSeconds(
        { ...defaultData('session'), activeSince: new Date(start).toISOString() },
        start - 1000,
      ),
    ).toBe(0);
  });
});
