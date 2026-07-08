import { expect, test } from 'vitest';
import { theme } from './theme.svelte';

test('applies OS theme, cycles system→light→dark→system, and persists', () => {
  localStorage.removeItem('tavern.theme');
  theme.mode = 'system';
  theme.init();

  const applied = document.documentElement.getAttribute('data-theme');
  expect(applied === 'light' || applied === 'dark').toBe(true);
  expect(theme.mode).toBe('system');

  theme.cycle();
  expect(theme.mode).toBe('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem('tavern.theme')).toBe('light');

  theme.cycle();
  expect(theme.mode).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(localStorage.getItem('tavern.theme')).toBe('dark');

  theme.cycle();
  expect(theme.mode).toBe('system');
});

test('init reads a persisted override', () => {
  localStorage.setItem('tavern.theme', 'dark');
  theme.mode = 'system';
  theme.init();
  expect(theme.mode).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});
