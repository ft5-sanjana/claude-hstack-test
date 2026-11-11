# Spec-Driven Development (SDD) Benchmark Kit - Final Edition

This kit evaluates API-first frameworks and AI code-generation tools on how strictly they enforce a contract. The target stack is a FastAPI backend and a TypeScript + Shadcn UI frontend.

## Kit Contents
| # | File | Role |
|---|---|---|
| 1 | `backend/specification.md` | Canonical API contract (FastAPI). |
| 2 | `backend/test_sdd_benchmark.py` | Automated integration suite: **the Judge** (45 tests). |
| 3 | `frontend/frontend_specification.md` | Canonical UI contract (TypeScript / Shadcn / Zod), including the test-harness and SDK-adapter contracts. |
| 4 | `frontend/transfer-form.spec.ts` | Playwright E2E suite for client-side enforcement (15 tests). API calls are mocked in the browser, so no backend is needed. |
| 5 | `frontend/type-check.ts` | Compile-time strictness test for the generated TypeScript client. |
| 6 | `frontend/tsconfig.typecheck.json` | Compiler settings for item 5. `tsc <file>` ignores tsconfig files, so this pins `strict` and a modern target. |

## Quick Start

### 0. Generate the candidate
Ask the SDD tool under test to implement `backend/specification.md` and `frontend/frontend_specification.md` in the target stack. As part of the frontend task, it also writes the small `frontend/sdk-adapter.ts` described in the frontend spec.

### 1. Backend judge
Start the backend on port 8000, then:
```bash
pip install pytest requests
pytest backend/test_sdd_benchmark.py -v
```
To target another host or port, set `SDD_BASE_URL`, for example `SDD_BASE_URL=http://localhost:9000`. The suite stops early with a clear message if the server is unreachable.

### 2. Schemathesis fuzzing (optional)
```bash
pip install schemathesis
st run http://localhost:8000/openapi.json --checks all --exclude-checks positive_data_acceptance
```
- Don't pass a fixed `--header "Idempotency-Key: ..."`. Every fuzzed payload after the first would reuse that key with a different body and get a 409. Instead, document the header (with its UUID v4 `pattern`) in OpenAPI and let Schemathesis generate keys.
- `positive_data_acceptance` is excluded because the spec deliberately rejects some schema-valid requests (self-transfer gets 422, `amount_cents = 999999` gets 402).
- Schemathesis 4.x uses `--url`, not `--base-url`. Here the base URL is taken from the schema location, so neither flag is needed.
- On Windows, set `PYTHONUTF8=1` if `st` crashes with a `UnicodeEncodeError`.

### 3. Frontend E2E (Playwright)
Start the candidate frontend dev server so that the form is at `http://localhost:3000/transfer`, then run this from the kit root:
```bash
npm init -y
npm install -D @playwright/test typescript
npx playwright install chromium
npx playwright test frontend/transfer-form.spec.ts
```
To target another host or port, set `FRONTEND_URL`, for example `FRONTEND_URL=http://localhost:5173`.

### 4. TypeScript strictness check
Copy the candidate's generated client next to `frontend/type-check.ts`, add `frontend/sdk-adapter.ts` as defined in the frontend spec, then:
```bash
npx -p typescript tsc -p frontend/tsconfig.typecheck.json
```
It passes only with zero errors. An unused `@ts-expect-error` (TS2578) or a failed `Assert<...>` (TS2344) means the generated types are looser than the contract. Use `npx -p typescript`, not bare `npx tsc`: if TypeScript isn't installed, bare `npx tsc` runs an unrelated npm package named `tsc`.

## Scoring
| Suite | Tests | Notes |
|---|---|---|
| Backend judge | 45 | Each parametrized case counts once. |
| Frontend E2E | 15 | |
| Type check | 1 (pass/fail) | Report the TS error count as a secondary signal. |
| Schemathesis | Informational | Report the number of unique failures. |

Review `frontend/sdk-adapter.ts` by hand. It must only wire generated code to the canonical signature, and must not hand-write the request or response types.
