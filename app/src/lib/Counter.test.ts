import { flushSync } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { expect, test } from 'vitest';
import Counter from './Counter.svelte';

test('counter increments on click', async () => {
  const screen = await render(Counter);
  const button = screen.getByRole('button');
  await expect.element(button).toHaveTextContent('count: 0');

  await button.click();
  flushSync(); // force Svelte 5 to flush pending effects synchronously

  await expect.element(button).toHaveTextContent('count: 1');
});
