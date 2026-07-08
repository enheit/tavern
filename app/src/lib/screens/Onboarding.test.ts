import { render } from 'vitest-browser-svelte';
import { expect, test } from 'vitest';
import Onboarding from './Onboarding.svelte';

test('validates fields and gates submit on validity', async () => {
  const screen = render(Onboarding);
  const nick = screen.getByLabelText('Nickname');
  const pw = screen.getByLabelText('Password', { exact: true });
  const repeat = screen.getByLabelText('Repeat password');
  const submit = screen.getByTestId('submit');

  // Empty form: submit disabled, no errors yet.
  await expect.element(submit).toBeDisabled();

  // Invalid nickname surfaces an error.
  await nick.fill('a');
  await expect.element(screen.getByText('2–32 letters, numbers, or underscore')).toBeInTheDocument();
  await expect.element(submit).toBeDisabled();

  // Fill a valid, matching set → submit enables.
  await nick.fill('alice');
  await pw.fill('password1');
  await repeat.fill('password1');
  await expect.element(submit).toBeEnabled();

  // Mismatched repeat re-disables and shows the error.
  await repeat.fill('different1');
  await expect.element(screen.getByText('Passwords do not match')).toBeInTheDocument();
  await expect.element(submit).toBeDisabled();
});
