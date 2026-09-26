// The one CI-gating e2e spec (D14, decision #2): scan QR → add items → place order → pay via the dev-sign script
// (deterministic, offline PayFS stand-in — decision #1) → storefront shows paid → kitchen sees it → prepare →
// fulfil. Everything here drives real UI: the payment reference comes from the payment screen, never the
// database (construction note of decision #5); the console session is a real better-auth cookie minted by
// `tests/e2e/support/console-session.ts`, not a stub.
import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { mintConsoleSession } from './support/console-session.ts';
import { CLOUDFLARE_ENVIRONMENT, CONSOLE_BASE_URL, E2E_DEV_VARS, readE2eContext, REPO_ROOT, STOREFRONT_BASE_URL } from './support/harness.ts';

const KITCHEN_VISIBILITY_BOUND_MS = 3500;
// Generous outer wait so a slow CI box never masks the real assertion below (elapsed < KITCHEN_VISIBILITY_BOUND_MS).
const KITCHEN_VISIBILITY_SAFETY_TIMEOUT_MS = 8000;

function parseVndMinor(displayed: string): number {
  const digits = displayed.replace(/[^\d]/g, '');
  return Number(digits);
}

/**
 * Runs `scripts/dev/sign-payfs-payload.ts --post` exactly the way the phase-9 A2 manual run did. Decision #3's
 * negative proof (A1) reuses this same helper with a deliberately wrong `secret` — the branch lives entirely in
 * this test-harness file (`tests/e2e/**`), never in `apps/worker` or `packages/orders`.
 */
function postPayfsWebhook(payload: Record<string, unknown>, secret: string): { status: number; body: string } {
  // Node colors console.log's numeric argument (response.status) with ANSI escapes whenever FORCE_COLOR is set in
  // the environment (true under Playwright here) — strip them before parsing "<status> <body>".
  const parse = (raw: string): { status: number; body: string } => {
    const clean = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
    const match = /^(\d+)\s+([\s\S]*)$/.exec(clean);
    if (!match) throw new Error(`sign-payfs-payload.ts produced unparseable output: ${JSON.stringify(raw)}`);
    return { status: Number(match[1]), body: match[2] };
  };
  try {
    const stdout = execFileSync(
      'npx',
      ['tsx', 'scripts/dev/sign-payfs-payload.ts', '--payload', '-', '--secret', secret, '--api-key', E2E_DEV_VARS.PAYFS_WEBHOOK_API_KEY, '--post', `${CONSOLE_BASE_URL}/api/payfs/webhook`],
      { cwd: REPO_ROOT, input: JSON.stringify(payload), encoding: 'utf8' },
    );
    return parse(stdout);
  } catch (error) {
    return parse(String((error as { stdout?: string }).stdout ?? ''));
  }
}

async function addTwoCoffeesAndOneTea(page: Page): Promise<void> {
  await page.getByRole('listitem').filter({ hasText: 'Cà phê sữa đá' }).getByRole('button', { name: 'Thêm vào giỏ' }).click();
  await page.getByRole('button', { name: 'Tăng số lượng Cà phê sữa đá' }).click();
  await page.getByRole('listitem').filter({ hasText: 'Trà đào cam sả' }).getByRole('button', { name: 'Thêm vào giỏ' }).click();
}

test('luồng tiền đầu-cuối: quét QR → đặt đơn → thanh toán → bếp → giao món', async ({ browser }) => {
  const { stateDir, tableToken } = readE2eContext();

  const customerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const customerPage = await customerContext.newPage();

  const kitchenContext = await browser.newContext();
  const session = await mintConsoleSession('wrangler.jsonc', CLOUDFLARE_ENVIRONMENT, stateDir);
  await kitchenContext.addCookies([
    { name: session.cookieName, value: session.cookieValue, domain: new URL(CONSOLE_BASE_URL).hostname, path: '/' },
  ]);
  const kitchenPage = await kitchenContext.newPage();

  let paymentReference = '';
  let webhookReceivedAt = 0;

  await test.step('quét QR → chọn 2 món → đặt đơn → thấy QR + paymentReference', async () => {
    await customerPage.goto(`${STOREFRONT_BASE_URL}/t#${tableToken}`);
    await expect(customerPage.getByText('Bàn số 5')).toBeVisible();

    await addTwoCoffeesAndOneTea(customerPage);
    await customerPage.getByRole('button', { name: 'Đặt đơn' }).click();

    const referenceText = await customerPage.locator('.payment-reference').innerText();
    const match = /QM[0-9A-Z]{8}/.exec(referenceText);
    expect(match).not.toBeNull();
    paymentReference = match![0];

    const amountText = await customerPage.locator('.payment-amount').innerText();
    expect(parseVndMinor(amountText)).toBe(85000); // 2×25.000 (cà phê) + 1×35.000 (trà) — seed data (scripts/e2e-seed.ts).
    await expect(customerPage.locator('img[alt="Mã QR VietQR để thanh toán"]')).toBeVisible();
  });

  await test.step('mở màn bếp (đơn chưa thanh toán → bảng trống)', async () => {
    await kitchenPage.goto(`${CONSOLE_BASE_URL}/console/kitchen`);
    await expect(kitchenPage.getByText('Chưa có đơn nào đang chờ.')).toBeVisible();
  });

  await test.step('chạy dev-sign → webhook 200 → khách chuyển "Đã thanh toán"', async () => {
    // A1 (decision #3): `QR_E2E_WRONG_PAYFS_SECRET=1 npx playwright test` deliberately signs with the wrong
    // secret so the webhook's signature check must fail (401 `signature_invalid`) and the customer screen must
    // never reach "paid" — proof this gate has teeth. The switch lives only here, in the test harness
    // (tests/e2e/**); the worker never sees a flag that could skip recording a payment (decision #3 forbids that).
    const payfsWebhookSecret = process.env.QR_E2E_WRONG_PAYFS_SECRET ? 'deliberately-wrong-secret-for-a1-proof' : E2E_DEV_VARS.PAYFS_WEBHOOK_SECRET;
    const result = postPayfsWebhook(
      { transfer_type: 'credit', transaction_id: `e2e-${Date.now()}`, amount: 85000, content: `Thanh toan don hang ${paymentReference}` },
      payfsWebhookSecret,
    );
    webhookReceivedAt = Date.now();
    expect(result.status).toBe(200);
    expect(result.body).toContain('"outcome":"paid"');

    await expect(customerPage.locator('.tracking-step.done', { hasText: 'Đã thanh toán' })).toBeVisible();
  });

  await test.step('đơn nổ về bếp ≤3.5 giây sau webhook 200', async () => {
    const ticket = kitchenPage.locator('.kitchen-ticket', { hasText: 'Cà phê sữa đá' });
    await expect(ticket).toBeVisible({ timeout: KITCHEN_VISIBILITY_SAFETY_TIMEOUT_MS });
    const elapsedMs = Date.now() - webhookReceivedAt;
    console.log(`[T2] kitchen board showed the paid order ${elapsedMs}ms after the webhook's 200 response`);
    expect(elapsedMs).toBeLessThan(KITCHEN_VISIBILITY_BOUND_MS);
    await expect(ticket).toContainText('2× Cà phê sữa đá');
    await expect(ticket).toContainText('1× Trà đào cam sả');
  });

  await test.step('bếp: Nhận đơn & Chế biến → Giao món', async () => {
    const ticket = kitchenPage.locator('.kitchen-ticket', { hasText: 'Cà phê sữa đá' });
    await ticket.getByRole('button', { name: 'Nhận đơn & Chế biến' }).click();
    await expect(ticket.getByRole('button', { name: 'Giao món' })).toBeVisible();

    await ticket.getByRole('button', { name: 'Giao món' }).click();
    await expect(kitchenPage.getByText('Chưa có đơn nào đang chờ.')).toBeVisible();
  });

  await test.step('khách thấy "Đã giao món"', async () => {
    await expect(customerPage.locator('.tracking-step.done', { hasText: 'Đã giao món' })).toBeVisible({ timeout: KITCHEN_VISIBILITY_SAFETY_TIMEOUT_MS });
  });

  await customerContext.close();
  await kitchenContext.close();
});
