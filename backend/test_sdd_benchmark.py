"""SDD Benchmark - backend judge.

Runs against a live server. Override the target with:
    SDD_BASE_URL=http://localhost:8000 pytest backend/test_sdd_benchmark.py -v
"""
import os
import re
import uuid
from datetime import datetime

import pytest
import requests

BASE_URL = os.environ.get("SDD_BASE_URL", "http://localhost:8000").rstrip("/")
TRANSFERS_URL = f"{BASE_URL}/api/v1/transfers"
TIMEOUT = float(os.environ.get("SDD_TIMEOUT", "10"))

TRANSFER_ID_RE = re.compile(r"^tx_[a-z0-9]{12}$")
CREATED_AT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


# --------------------------------------------------------------------------- helpers

def post(payload=None, headers=None, data=None):
    """POST to the transfers endpoint. Pass `data` (bytes/str) to send a raw body."""
    if data is not None:
        hdrs = {"Content-Type": "application/json", **(headers or {})}
        return requests.post(TRANSFERS_URL, data=data, headers=hdrs, timeout=TIMEOUT)
    return requests.post(TRANSFERS_URL, json=payload, headers=headers or {}, timeout=TIMEOUT)


def json_body(res):
    try:
        body = res.json()
    except ValueError:
        pytest.fail(f"Response is not JSON (HTTP {res.status_code}): {res.text[:300]!r}")
    assert isinstance(body, dict), f"Expected a JSON object, got: {body!r}"
    return body


def assert_error(res, status, error_code):
    assert res.status_code == status, (
        f"Expected HTTP {status}, got {res.status_code}. Response: {res.text[:500]}"
    )
    body = json_body(res)
    assert body.get("error_code") == error_code, (
        f"Expected error_code={error_code!r}, got {body.get('error_code')!r}. Body: {body}"
    )
    assert isinstance(body.get("message"), str) and body["message"].strip(), (
        f"Error body must contain a non-empty string 'message'. Body: {body}"
    )


def assert_success_body(body):
    assert isinstance(body.get("transfer_id"), str) and TRANSFER_ID_RE.match(body["transfer_id"]), (
        f"transfer_id must match {TRANSFER_ID_RE.pattern}, got {body.get('transfer_id')!r}"
    )
    assert body.get("status") in ("PENDING", "SETTLED"), f"Invalid status: {body.get('status')!r}"
    created_at = body.get("created_at")
    assert isinstance(created_at, str) and CREATED_AT_RE.match(created_at), (
        f"created_at must be ISO 8601 UTC with a 'Z' suffix, got {created_at!r}"
    )
    # Must also be a real date/time, not just the right shape.
    datetime.fromisoformat(created_at.replace("Z", "+00:00"))


# --------------------------------------------------------------------------- fixtures

@pytest.fixture(scope="session", autouse=True)
def server_is_up():
    try:
        requests.get(BASE_URL, timeout=TIMEOUT)
    except requests.exceptions.ConnectionError:
        pytest.exit(f"Server not reachable at {BASE_URL}. Start it or set SDD_BASE_URL.", returncode=2)


@pytest.fixture
def headers():
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture
def valid_payload():
    return {
        "source_wallet_id": "wal_abc12345",
        "target_wallet_id": "wal_xyz98765",
        "amount_cents": 5000,
        "currency": "USD",
    }


# --------------------------------------------------------------------------- 01 happy path

def test_01_happy_path_201(headers, valid_payload):
    res = post(valid_payload, headers)
    assert res.status_code == 201, f"Expected 201, got {res.status_code}. Response: {res.text}"
    assert_success_body(json_body(res))


@pytest.mark.parametrize("currency", ["USD", "EUR", "GBP"])
def test_01b_all_currencies_accepted(headers, valid_payload, currency):
    res = post({**valid_payload, "currency": currency}, headers)
    assert res.status_code == 201, f"{currency}: expected 201, got {res.status_code}. {res.text}"


# --------------------------------------------------------------------------- 02 boundaries

@pytest.mark.parametrize("amount", [100, 1000000])
def test_02a_inclusive_boundaries_accepted(headers, valid_payload, amount):
    res = post({**valid_payload, "amount_cents": amount}, headers)
    assert res.status_code == 201, f"amount_cents={amount} is in range; expected 201, got {res.status_code}. {res.text}"


@pytest.mark.parametrize("amount", [99, 1000001, 0, -100])
def test_02b_out_of_range_rejected(headers, valid_payload, amount):
    res = post({**valid_payload, "amount_cents": amount}, headers)
    assert_error(res, 422, "VALIDATION_FAILED")


# --------------------------------------------------------------------------- 03 types, regex, enums

@pytest.mark.parametrize("field, invalid_value", [
    ("source_wallet_id", "invalid_id_format"),
    ("source_wallet_id", "wal_ABC12345"),        # uppercase not allowed
    ("source_wallet_id", "wal_abc1234"),         # too short
    ("source_wallet_id", "wal_abc123456"),       # too long
    ("target_wallet_id", "wal_xyz-9876"),
    ("target_wallet_id", 12345678),
    ("currency", "JPY"),
    ("currency", "usd"),                         # enum is case-sensitive
    ("amount_cents", "5000"),                    # numeric string must not be coerced
    ("amount_cents", 100.5),                     # fractional
    ("amount_cents", True),                      # boolean
    ("amount_cents", None),
])
def test_03_type_regex_enum_enforcement(headers, valid_payload, field, invalid_value):
    res = post({**valid_payload, field: invalid_value}, headers)
    assert_error(res, 422, "VALIDATION_FAILED")


@pytest.mark.parametrize("missing", ["source_wallet_id", "target_wallet_id", "amount_cents", "currency"])
def test_03b_missing_field_rejected(headers, valid_payload, missing):
    payload = {k: v for k, v in valid_payload.items() if k != missing}
    res = post(payload, headers)
    assert_error(res, 422, "VALIDATION_FAILED")


def test_03c_malformed_json_rejected(headers):
    res = post(headers=headers, data=b'{"source_wallet_id": "wal_abc12345",')
    assert_error(res, 422, "VALIDATION_FAILED")


def test_03d_undecodable_body_rejected(headers):
    # Invalid UTF-8. FastAPI's default here is HTTP 400 {"detail": "There was an error parsing the body"}.
    res = post(headers=headers, data=b"\xff\xfe\xfd")
    assert_error(res, 422, "VALIDATION_FAILED")


# --------------------------------------------------------------------------- 04 business rules

def test_04_business_rule_self_transfer(headers, valid_payload):
    payload = {**valid_payload, "source_wallet_id": "wal_same0001", "target_wallet_id": "wal_same0001"}
    res = post(payload, headers)
    assert_error(res, 422, "VALIDATION_FAILED")


def test_05_insufficient_funds_mock(headers, valid_payload):
    res = post({**valid_payload, "amount_cents": 999999}, headers)
    assert_error(res, 402, "INSUFFICIENT_FUNDS")


# --------------------------------------------------------------------------- 06 idempotency

def test_06_idempotency_behavior(headers, valid_payload):
    r1 = post(valid_payload, headers)
    assert r1.status_code == 201, f"Expected 201, got {r1.status_code}. {r1.text}"

    # Same key, same payload (different key order) -> exact original body with 200.
    reordered = dict(reversed(list(valid_payload.items())))
    r2 = post(reordered, headers)
    assert r2.status_code == 200, f"Replay: expected 200, got {r2.status_code}. {r2.text}"
    assert json_body(r2) == json_body(r1), "Replay must return the original response body unchanged"

    # Same key, different payload -> 409.
    r3 = post({**valid_payload, "amount_cents": 1200}, headers)
    assert_error(r3, 409, "IDEMPOTENCY_CONFLICT")

    # The conflict must not have overwritten the stored result.
    r4 = post(valid_payload, headers)
    assert r4.status_code == 200, f"Replay after conflict: expected 200, got {r4.status_code}. {r4.text}"
    assert json_body(r4) == json_body(r1)


def test_06b_distinct_keys_create_distinct_transfers(valid_payload):
    r1 = post(valid_payload, {"Idempotency-Key": str(uuid.uuid4())})
    r2 = post(valid_payload, {"Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 201 and r2.status_code == 201, f"{r1.status_code} / {r2.status_code}"
    assert json_body(r1)["transfer_id"] != json_body(r2)["transfer_id"]


def test_06c_failed_request_does_not_bind_key(headers, valid_payload):
    r1 = post({**valid_payload, "amount_cents": 999999}, headers)
    assert_error(r1, 402, "INSUFFICIENT_FUNDS")
    # Rule 5: rejected requests store nothing, so the same key with a new payload succeeds.
    r2 = post(valid_payload, headers)
    assert r2.status_code == 201, f"Key must not be bound by a failed request; got {r2.status_code}. {r2.text}"


# --------------------------------------------------------------------------- 07 Idempotency-Key header

@pytest.mark.parametrize("key", [
    None,                                        # header missing
    "",                                          # empty
    "not-a-uuid",
    "123",
    str(uuid.uuid1()),                           # valid UUID, wrong version
    str(uuid.uuid5(uuid.NAMESPACE_DNS, "x")),    # valid UUID, wrong version
])
def test_07_invalid_idempotency_key_rejected(valid_payload, key):
    hdrs = {} if key is None else {"Idempotency-Key": key}
    res = post(valid_payload, hdrs)
    assert_error(res, 400, "INVALID_IDEMPOTENCY_KEY")


def test_07b_uppercase_uuid_v4_accepted(valid_payload):
    res = post(valid_payload, {"Idempotency-Key": str(uuid.uuid4()).upper()})
    assert res.status_code == 201, f"Uppercase hex is a valid UUID v4; got {res.status_code}. {res.text}"


# --------------------------------------------------------------------------- 08 evaluation order

def test_08a_header_checked_before_body(valid_payload):
    res = post({**valid_payload, "currency": "JPY"}, {})
    assert_error(res, 400, "INVALID_IDEMPOTENCY_KEY")


def test_08b_self_transfer_beats_insufficient_funds(headers, valid_payload):
    payload = {**valid_payload, "target_wallet_id": valid_payload["source_wallet_id"], "amount_cents": 999999}
    res = post(payload, headers)
    assert_error(res, 422, "VALIDATION_FAILED")


def test_08c_schema_validation_beats_idempotency_conflict(headers, valid_payload):
    assert post(valid_payload, headers).status_code == 201
    res = post({**valid_payload, "currency": "JPY"}, headers)
    assert_error(res, 422, "VALIDATION_FAILED")


def test_08d_idempotency_conflict_beats_insufficient_funds(headers, valid_payload):
    assert post(valid_payload, headers).status_code == 201
    res = post({**valid_payload, "amount_cents": 999999}, headers)
    assert_error(res, 409, "IDEMPOTENCY_CONFLICT")


# --------------------------------------------------------------------------- 09 OpenAPI contract

def test_09_openapi_documents_contract():
    res = requests.get(f"{BASE_URL}/openapi.json", timeout=TIMEOUT)
    assert res.status_code == 200, f"GET /openapi.json returned {res.status_code}"
    op = json_body(res).get("paths", {}).get("/api/v1/transfers", {}).get("post")
    assert op, "OpenAPI document has no POST /api/v1/transfers operation"
    header_params = [p for p in op.get("parameters", []) if p.get("in") == "header"]
    assert any(p.get("name", "").lower() == "idempotency-key" and p.get("required") for p in header_params), (
        "Idempotency-Key must be documented as a required header parameter"
    )
    documented = set(op.get("responses", {}))
    missing = {"200", "201", "400", "402", "409", "422"} - documented
    assert not missing, f"Responses not documented in OpenAPI: {sorted(missing)}"
