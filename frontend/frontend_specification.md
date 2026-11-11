# UI Module: Transfer Funds Form
Build a single-page form that uses the generated API client for the `POST /api/v1/transfers` endpoint defined in `backend/specification.md`.

## Target Tech Stack
- **Language:** TypeScript
- **Framework:** React / Next.js
- **UI Library:** Shadcn UI (using `Form`, `Input`, `Select`, `Button`, `Alert`, and `Sonner` / `Toast`)
- **Validation:** Zod (must integrate with the Shadcn `Form` / react-hook-form resolver)

## UI Requirements
1. **Form Fields (use Shadcn `FormField` + `FormLabel` + `FormControl` so labels and error states are wired up):**
   | Visible label (exact text) | Component | Maps to |
   |---|---|---|
   | `Target Wallet ID` | `Input` (text) | `target_wallet_id` |
   | `Amount in Cents` | `Input` (`type="number"`) | `amount_cents` |
   | `Currency` | `Select` | `currency` |
   - The `Currency` options' visible text is exactly `USD`, `EUR`, `GBP`, with no other options.
   - Submit with a Shadcn `Button` that has `type="submit"`.
2. **Under-the-hood:**
   - Auto-generate the `Idempotency-Key` (UUID v4) on form mount.
   - Reuse the same key when the user resubmits after an error, so retries stay idempotent. Generate a fresh key after a successful (201/200) response, so a second, different transfer from the same form does not get a 409.
   - Hardcode `source_wallet_id` to `"wal_abc12345"` for this component.
   - Send `amount_cents` as a JSON **number**, not a string.
3. **Validation (must inherit from the generated TypeScript SDK / Zod schemas):**
   - Prevent submission (no network request is made) if Amount is < 100 or > 1000000, or if Target Wallet ID does not match `^wal_[a-z0-9]{8}$`.
   - Show an inline error under the offending field using Shadcn `FormMessage`. Its wording is not prescribed; messages from the generated schema are fine. The field must expose `aria-invalid="true"` and be described by the message (Shadcn `FormControl` does both by default).
4. **State Management & UI Feedback:**
   - **Loading:** While the API request is in flight, disable the submit button and show a loading spinner exposed as `role="status"` with the accessible name `Loading`. The Shadcn `Spinner` component does this by default.
   - **Success (201/200):** Display a green Shadcn `Toast` / `Sonner` toast or `Alert` that contains the `transfer_id`.
   - **API Error (400, 402, 409, 422):** Parse the structured error response and display the exact `message` returned by the server in a destructive (red) Shadcn `Alert`, which has `role="alert"`.

## Test Harness Contract
The Playwright suite (`transfer-form.spec.ts`) relies on the following:
- The page is served at **`/transfer`**. The default origin is `http://localhost:3000`; override it with the `FRONTEND_URL` environment variable.
- The API call is made **from the browser** (a client component using `fetch` or the generated client). Do not use a Server Action or server-side proxy call, because the suite intercepts the request in the browser. The request URL path must end with `/api/v1/transfers`. It may be same-origin (for example a Next.js `rewrites` proxy) or go directly to the backend with CORS enabled.
- Fields are located by their visible label, and the Currency `Select` by its trigger, which Shadcn renders with `role="combobox"`, and its options (`role="option"`).

## Generated Client Type Contract (`type-check.ts`)
Generators differ in function names and return shapes, so the candidate provides a thin adapter, `frontend/sdk-adapter.ts`, that exposes the generated client through one canonical signature:

```ts
// frontend/sdk-adapter.ts — glue only; types MUST be imported/derived from generated code, not hand-written.
import { /* generated client + types */ } from './generated-api-client';

export type TransferRequest = /* generated request body type */;
export type TransferResponse = /* generated success response type */;

export async function createTransfer(body: TransferRequest, idempotencyKey: string): Promise<TransferResponse> {
  /* call the generated client, return the parsed 201/200 body, throw on errors */
}
```

The generated types must use string-literal unions for enums (`'USD' | 'EUR' | 'GBP'`), not TypeScript `enum`s, so that plain literals are accepted. All request and response fields must be required (non-optional).
