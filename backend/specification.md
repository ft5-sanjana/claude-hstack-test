# Module: Transfer & Settlement Engine
API Path: `POST /api/v1/transfers`

## Target Tech Stack
- **Framework:** FastAPI (Python)
- **Validation:** Pydantic (must be generated/synced from spec)
- **Contract:** The service must publish its OpenAPI document at `GET /openapi.json` (FastAPI default). That document must describe the `Idempotency-Key` header as a required parameter, the request body, and every response status listed in Section 4. Constraints should be declared, not just enforced in code, so fuzzers generate valid data. This includes the header's UUID v4 `pattern`, the wallet regexes, the amount range and the currency enum.

## 1. Headers
- `Idempotency-Key` (Required, string, UUID **version 4** in canonical hyphenated form, e.g. `123e4567-e89b-42d3-a456-426614174000`; hex digits are case-insensitive).
  - Missing, empty, malformed, or a valid UUID of another version (v1, v3, v5, v7, ...) → reject with **HTTP 400**, `error_code: "INVALID_IDEMPOTENCY_KEY"`.

## 2. Request Payload (`Content-Type: application/json`)
| Field | Type | Rules |
|---|---|---|
| `source_wallet_id` | string | Required. Regex: `^wal_[a-z0-9]{8}$` (lowercase only) |
| `target_wallet_id` | string | Required. Regex: `^wal_[a-z0-9]{8}$` (lowercase only) |
| `amount_cents` | integer | Required. Min `100`, max `1000000` (both **inclusive**). Must be a JSON integer: strings (`"5000"`), booleans, and fractional numbers (`100.5`) are rejected, not coerced. Integral floats such as `5000.0` may be accepted or rejected; the judge does not test them. |
| `currency` | string | Required. Enum: `"USD"`, `"EUR"`, `"GBP"` (case-sensitive) |

Any violation of this table (missing field, wrong type, regex/range/enum failure, or a body that is not valid JSON) → reject with **HTTP 422**, `error_code: "VALIDATION_FAILED"`.

## 3. Business & State Rules
1. **Self-Transfer:** `source_wallet_id` and `target_wallet_id` must NOT be identical. Reject with **HTTP 422**, `error_code: "VALIDATION_FAILED"`.
2. **Insufficient Funds:** For testing predictability, if `amount_cents` is exactly `999999`, reject with **HTTP 402**, `error_code: "INSUFFICIENT_FUNDS"`.
3. **Idempotency (Exact Match):** If the `Idempotency-Key` was previously used for a *successful* transfer with the exact same payload, return the original response body unchanged (same `transfer_id`, `status`, and `created_at`) but with **HTTP 200** instead of 201. No new transfer is created.
4. **Idempotency (Mismatch):** If the `Idempotency-Key` was previously used for a successful transfer with a DIFFERENT payload, reject with **HTTP 409**, `error_code: "IDEMPOTENCY_CONFLICT"`.
5. **What binds a key:** Only a successful (201) request binds an `Idempotency-Key` to its payload. Rejected requests (400/402/409/422) do not store anything, so retrying with the same key is evaluated from scratch.
6. **Payload equality:** "Same payload" means the four fields above have equal values. JSON key order and whitespace are irrelevant.

### Evaluation Order
When a request violates several rules, the **first** matching rule in this list determines the response:
1. `Idempotency-Key` header check → 400
2. Request payload schema (Section 2) → 422
3. Self-transfer → 422
4. Idempotency lookup → 200 (exact replay) or 409 (mismatch)
5. Insufficient funds → 402
6. Create the transfer → 201

## 4. Response Schemas
**Success (HTTP 201 Created / 200 OK idempotent replay):**
- `transfer_id` (string, regex: `^tx_[a-z0-9]{12}$`)
- `status` (string, enum: `"PENDING"`, `"SETTLED"`)
- `created_at` (string, ISO 8601 UTC timestamp using the `Z` suffix, e.g. `2025-01-31T12:34:56Z` or `2025-01-31T12:34:56.123456Z`; `+00:00` offsets are not accepted)

**Error (HTTP 400, 402, 409, 422):**
Every error response, including validation errors that FastAPI would normally emit as `{"detail": [...]}`, must be a JSON object containing:
- `error_code` (string, one of `"INVALID_IDEMPOTENCY_KEY"`, `"VALIDATION_FAILED"`, `"INSUFFICIENT_FUNDS"`, `"IDEMPOTENCY_CONFLICT"`)
- `message` (string, non-empty, human-readable reason)

The body may additionally carry RFC 9457 / RFC 7807 Problem Details members (`type`, `title`, `status`, `detail`, `instance`). It may be served as `application/json` or `application/problem+json`.

| Status | `error_code` | Trigger |
|---|---|---|
| 400 | `INVALID_IDEMPOTENCY_KEY` | Section 1 |
| 402 | `INSUFFICIENT_FUNDS` | Rule 2 |
| 409 | `IDEMPOTENCY_CONFLICT` | Rule 4 |
| 422 | `VALIDATION_FAILED` | Section 2, Rule 1 |
