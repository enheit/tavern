import { expect, test, vi } from 'vitest';
import { onEngineEvent, emitEngineEvent } from './events';

test('delivers payloads to subscribers until unsubscribed', () => {
  const cb = vi.fn();
  const off = onEngineEvent('engine://levels', cb);

  emitEngineEvent('engine://levels', [{ userId: 'u1', rms: 0.5 }]);
  expect(cb).toHaveBeenCalledWith([{ userId: 'u1', rms: 0.5 }]);

  off();
  emitEngineEvent('engine://levels', []);
  expect(cb).toHaveBeenCalledTimes(1);
});

test('scopes delivery by event name', () => {
  const state = vi.fn();
  onEngineEvent('engine://state', state);
  emitEngineEvent('engine://stats', { bytesSent: 1 });
  expect(state).not.toHaveBeenCalled();
});
