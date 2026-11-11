/**
 * Compile-time strictness test for the generated TypeScript client.
 *
 * Passes only if this file compiles with ZERO errors:
 *   npx -p typescript tsc -p frontend/tsconfig.typecheck.json
 *
 * Every `@ts-expect-error` line below MUST produce a type error. If the generated types are
 * too loose (e.g. `any`, `string` instead of a literal union, optional fields), the directive
 * becomes unused and tsc fails with TS2578. Each one isolates a single fault in an otherwise
 * valid call, so it cannot be satisfied by an unrelated error.
 *
 * `./sdk-adapter` is supplied by the candidate (see frontend_specification.md, "Generated Client
 * Type Contract"). It must re-export types derived from the generated client, not hand-written ones.
 */
import { createTransfer, type TransferRequest, type TransferResponse } from './sdk-adapter';

// ---------------------------------------------------------------- type-level assertions
type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Extends<A, B> = [A] extends [B] ? true : false;

export type TypeAssertions = [
  // Types are real, not `any`.
  Assert<Not<IsAny<TransferRequest>>>,
  Assert<Not<IsAny<TransferResponse>>>,
  Assert<Not<IsAny<TransferRequest['currency']>>>,
  Assert<Not<IsAny<TransferResponse['status']>>>,
  // Enums are closed string-literal unions.
  Assert<Equals<TransferRequest['currency'], 'USD' | 'EUR' | 'GBP'>>,
  Assert<Equals<TransferResponse['status'], 'PENDING' | 'SETTLED'>>,
  // Scalar field types.
  Assert<Extends<TransferRequest['source_wallet_id'], string>>,
  Assert<Extends<TransferRequest['target_wallet_id'], string>>,
  Assert<Extends<TransferRequest['amount_cents'], number>>,
  Assert<Extends<TransferResponse['transfer_id'], string>>,
  Assert<Extends<TransferResponse['created_at'], string>>,
  // Every field is required.
  Assert<Extends<'source_wallet_id' | 'target_wallet_id' | 'amount_cents' | 'currency', RequiredKeys<TransferRequest>>>,
  Assert<Extends<'transfer_id' | 'status' | 'created_at', RequiredKeys<TransferResponse>>>,
];

// ---------------------------------------------------------------- call-site checks
const KEY = '123e4567-e89b-42d3-a456-426614174000';

export async function testTyping(): Promise<void> {
  // Currency outside the enum.
  // @ts-expect-error
  await createTransfer({ currency: 'JPY', amount_cents: 500, source_wallet_id: 'wal_abc12345', target_wallet_id: 'wal_xyz98765' }, KEY);

  // amount_cents as a string.
  // @ts-expect-error
  await createTransfer({ currency: 'USD', amount_cents: '500', source_wallet_id: 'wal_abc12345', target_wallet_id: 'wal_xyz98765' }, KEY);

  // Missing required field (target_wallet_id).
  // @ts-expect-error
  await createTransfer({ currency: 'USD', amount_cents: 500, source_wallet_id: 'wal_abc12345' }, KEY);

  // Valid call compiles and is strongly typed.
  const response = await createTransfer(
    { currency: 'USD', amount_cents: 500, source_wallet_id: 'wal_abc12345', target_wallet_id: 'wal_xyz98765' },
    KEY,
  );
  const id: string = response.transfer_id;
  const created: string = response.created_at;

  if (response.status === 'PENDING' || response.status === 'SETTLED') {
    console.log(id, created);
  }

  // Comparing against a status outside the union is a compile error (TS2367).
  // @ts-expect-error
  if (response.status === 'FAILED') {
    console.log('unreachable');
  }
}
