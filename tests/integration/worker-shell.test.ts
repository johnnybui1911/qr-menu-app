import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../apps/worker/src/index.ts';
import { resetDb } from '../support/test-env.ts';

beforeEach(resetDb);

describe('worker shell', () => {
  it('answers unmapped /api paths with a JSON 404 that leaks no internals', async () => {
    const response = await exports.default.fetch('http://app.test/api/nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'not_found' });
    expect(body).not.toMatch(/at \w|\.ts:\d/);
  });

  it.each(['*/1 * * * *', '*/5 * * * *'])('accepts the %s cron', async (cron) => {
    const ctx = createExecutionContext();
    await worker.scheduled!({ cron, scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
  });

  it('refuses an unknown cron pattern instead of silently skipping jobs', async () => {
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled!({ cron: '0 0 * * *', scheduledTime: Date.now(), type: 'scheduled', noRetry() {} } as ScheduledController, env, ctx),
    ).rejects.toThrow(/unknown cron/i);
  });
});
