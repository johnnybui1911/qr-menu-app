// PayFS signs canonical JSON, not the raw body (F11). Shared by the verifier and scripts/dev/sign-payfs-payload.ts
// so the two can never disagree on canonicalisation.

export function sortKeysRecursive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysRecursive);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, sortKeysRecursive(source[key])]),
  );
}

/** The exact string PayFS feeds to HMAC-SHA256: `timestamp + "." + JSON.stringify(sortKeysRecursive(payload))`. */
export function payfsSigningInput(timestamp: string, payload: unknown): string {
  return `${timestamp}.${JSON.stringify(sortKeysRecursive(payload))}`;
}
