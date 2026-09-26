import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEvent } from '../../apps/worker/src/log.ts';

afterEach(() => vi.restoreAllMocks());

describe('logEvent', () => {
  it('redacts customer tokens and credentials at any depth', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
    logEvent({
      event: 'order_created',
      orderToken: 'order-secret',
      detail: {
        tableToken: 'table-secret',
        tokenUrl: 'https://x/#t=abc',
        headers: { Authorization: 'Bearer abc', 'x-client-api-key': 'webhook-key' },
        apiKey: 'api-key-value',
      },
      orderCode: 'ABC123',
    });
    expect(lines).toHaveLength(1);
    const output = lines[0];
    for (const secret of ['order-secret', 'table-secret', '#t=abc', 'Bearer abc', 'webhook-key', 'api-key-value']) {
      expect(output).not.toContain(secret);
    }
    expect(JSON.parse(output)).toMatchObject({ event: 'order_created', orderCode: 'ABC123', orderToken: '[redacted]' });
  });
});
