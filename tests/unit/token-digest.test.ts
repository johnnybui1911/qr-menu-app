import { describe, expect, it } from 'vitest';
import { constantTimeEqual, generateOpaqueToken, sha256Hex } from '@qr/identity/token-digest';

describe('token digest primitives (C7)', () => {
  it('produces the standard lowercase SHA-256 hex digest', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates unique base64url tokens carrying 32 bytes of entropy', () => {
    const tokens = Array.from({ length: 200 }, generateOpaqueToken);
    expect(new Set(tokens).size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('compares secrets for equality', () => {
    const digest = 'a'.repeat(64);
    expect(constantTimeEqual(digest, 'a'.repeat(64))).toBe(true);
    expect(constantTimeEqual(digest, `${'a'.repeat(63)}b`)).toBe(false);
    expect(constantTimeEqual(digest, 'a'.repeat(63))).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
