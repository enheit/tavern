import { expect, test } from 'vitest';
import { nicknameError, passwordError } from './validate';

test('nickname: accepts 2–32 [A-Za-z0-9_], rejects others', () => {
  expect(nicknameError('al')).toBeNull();
  expect(nicknameError('Alice_99')).toBeNull();
  expect(nicknameError('a')).not.toBeNull(); // too short
  expect(nicknameError('a'.repeat(33))).not.toBeNull(); // too long
  expect(nicknameError('has space')).not.toBeNull();
  expect(nicknameError('bad-dash')).not.toBeNull();
});

test('password: 8–128 code points', () => {
  expect(passwordError('password')).toBeNull();
  expect(passwordError('short7!')).not.toBeNull(); // 7 chars
  expect(passwordError('x'.repeat(128))).toBeNull();
  expect(passwordError('x'.repeat(129))).not.toBeNull();
});
