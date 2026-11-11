import { test, expect, type Page, type Request, type Route } from '@playwright/test';

const FRONTEND_URL = (process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_PATTERN = '**/api/v1/transfers';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

type MockReply = { status: number; body: unknown };

/**
 * Intercepts POST /api/v1/transfers in the browser. Records every POST and answers
 * with the reply produced by `reply`, after an optional gate promise resolves.
 * CORS preflights are answered so the app may call the backend cross-origin.
 */
async function mockTransfers(
  page: Page,
  reply: (callIndex: number) => MockReply,
  gate?: Promise<void>,
): Promise<Request[]> {
  const calls: Request[] = [];
  await page.route(API_PATTERN, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS });
    }
    calls.push(req);
    const { status, body } = reply(calls.length - 1);
    if (gate) await gate;
    await route.fulfill({
      status,
      headers: CORS_HEADERS,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return calls;
}

const success = (transfer_id = 'tx_success12345'): MockReply => ({
  status: 201,
  body: { transfer_id, status: 'PENDING', created_at: new Date().toISOString() },
});

const failure = (status: number, error_code: string, message: string): MockReply => ({
  status,
  body: { error_code, message },
});

const currencyTrigger = (page: Page) => page.getByRole('combobox', { name: 'Currency' });
const isNativeSelect = (page: Page) => currencyTrigger(page).evaluate((el) => el.tagName === 'SELECT');

async function chooseCurrency(page: Page, code: string) {
  // Test 01 fails a native <select>; falling back here keeps that one defect from failing every test.
  if (await isNativeSelect(page)) {
    await currencyTrigger(page).selectOption(code);
    return;
  }
  await currencyTrigger(page).click();
  await page.getByRole('option', { name: code, exact: true }).click();
}

async function fillForm(page: Page, values: { target: string; amount: string; currency?: string }) {
  await page.getByLabel('Target Wallet ID', { exact: true }).fill(values.target);
  await page.getByLabel('Amount in Cents', { exact: true }).fill(values.amount);
  await chooseCurrency(page, values.currency ?? 'USD');
}

const submit = (page: Page) => page.locator('button[type="submit"]').click();

async function expectFieldError(page: Page, label: string) {
  const field = page.getByLabel(label, { exact: true });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/\S/);
}

test.describe('Spec-Driven Frontend: Transfer Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/transfer`);
  });

  test('01. UI Enforces Enum Values (Shadcn Select)', async ({ page }) => {
    expect(await isNativeSelect(page), 'Currency must be a Shadcn <Select>, not a native <select>').toBe(false);
    await currencyTrigger(page).click();
    const options = (await page.getByRole('option').allInnerTexts()).map((t) => t.trim());
    expect(options.sort()).toEqual(['EUR', 'GBP', 'USD']);
  });

  for (const [amount, why] of [['99', 'below min'], ['50', 'below min'], ['1000001', 'above max']]) {
    test(`02. Client-Side Boundary Validation: ${amount} (${why})`, async ({ page }) => {
      const calls = await mockTransfers(page, () => success());
      await fillForm(page, { target: 'wal_xyz98765', amount });
      await submit(page);
      await expectFieldError(page, 'Amount in Cents');
      expect(calls, 'No request may be sent for invalid input').toHaveLength(0);
    });
  }

  for (const target of ['invalid-format', 'wal_ABC12345', 'wal_abc1234']) {
    test(`03. Client-Side Regex Validation: "${target}"`, async ({ page }) => {
      const calls = await mockTransfers(page, () => success());
      await fillForm(page, { target, amount: '5000' });
      await submit(page);
      await expectFieldError(page, 'Target Wallet ID');
      expect(calls, 'No request may be sent for invalid input').toHaveLength(0);
    });
  }

  test('04. Happy Path, Request Contract & Success State', async ({ page }) => {
    const calls = await mockTransfers(page, () => success('tx_success12345'));
    await fillForm(page, { target: 'wal_xyz98765', amount: '5000', currency: 'EUR' });
    await submit(page);
    await expect(page.getByText('tx_success12345')).toBeVisible();

    expect(calls).toHaveLength(1);
    expect(calls[0].method()).toBe('POST');
    expect(calls[0].postDataJSON()).toEqual({
      source_wallet_id: 'wal_abc12345',
      target_wallet_id: 'wal_xyz98765',
      amount_cents: 5000, // a number, not "5000"
      currency: 'EUR',
    });
    expect(calls[0].headers()['idempotency-key'] ?? '').toMatch(UUID_V4);
  });

  test('04b. Inclusive boundaries are accepted (100 and 1000000)', async ({ page }) => {
    const calls = await mockTransfers(page, (i) => success(`tx_boundary0${i}00`));
    for (const [i, amount] of ['100', '1000000'].entries()) {
      await fillForm(page, { target: 'wal_xyz98765', amount });
      await submit(page);
      await expect(page.getByText(`tx_boundary0${i}00`)).toBeVisible();
    }
    expect(calls.map((c) => c.postDataJSON().amount_cents)).toEqual([100, 1000000]);
  });

  const errorCases: [number, string, string][] = [
    [402, 'INSUFFICIENT_FUNDS', 'Your wallet balance is too low.'],
    [409, 'IDEMPOTENCY_CONFLICT', 'This request conflicts with a previous one.'],
    [422, 'VALIDATION_FAILED', 'Source and target wallets must differ.'],
    [400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID v4.'],
  ];
  for (const [status, code, message] of errorCases) {
    test(`05. Structured Error Handling: HTTP ${status} ${code}`, async ({ page }) => {
      await mockTransfers(page, () => failure(status, code, message));
      await fillForm(page, { target: 'wal_xyz98765', amount: '5000' });
      await submit(page);
      await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
    });
  }

  test('06. Loading State: button disabled + spinner while in flight', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = await mockTransfers(page, () => success('tx_loading12345'), gate);

    await fillForm(page, { target: 'wal_xyz98765', amount: '5000' });
    const button = page.locator('button[type="submit"]');
    await button.click();

    await expect.poll(() => calls.length).toBe(1);
    await expect(button).toBeDisabled();
    await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();

    release();
    await expect(page.getByText('tx_loading12345')).toBeVisible();
    await expect(button).toBeEnabled();
    expect(calls).toHaveLength(1);
  });

  test('07. Idempotency-Key: reused on retry after error, rotated after success', async ({ page }) => {
    const replies = [
      failure(402, 'INSUFFICIENT_FUNDS', 'Your wallet balance is too low.'),
      success('tx_retry0000001'),
      success('tx_second000001'),
    ];
    const calls = await mockTransfers(page, (i) => replies[i]);

    await fillForm(page, { target: 'wal_xyz98765', amount: '999999' });
    await submit(page);
    await expect(page.getByRole('alert').filter({ hasText: 'Your wallet balance is too low.' })).toBeVisible();

    await page.getByLabel('Amount in Cents', { exact: true }).fill('5000');
    await submit(page);
    await expect(page.getByText('tx_retry0000001')).toBeVisible();

    await fillForm(page, { target: 'wal_def45678', amount: '7000' });
    await submit(page);
    await expect(page.getByText('tx_second000001')).toBeVisible();

    const keys = calls.map((c) => c.headers()['idempotency-key']);
    expect(keys).toHaveLength(3);
    keys.forEach((k) => expect(k ?? '').toMatch(UUID_V4));
    expect(keys[1], 'Retry after an error must reuse the key').toBe(keys[0]);
    expect(keys[2], 'A new transfer after success must use a new key').not.toBe(keys[1]);
  });
});
