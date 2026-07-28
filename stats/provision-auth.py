#!/usr/bin/env python3
"""Provision Cinder's private stats audience without printing secret material."""

from __future__ import annotations

import json
from pathlib import Path
import secrets
import subprocess


REGION = "us-east-1"
EXPECTED_ACCOUNT = "553806908724"
SURFACE_SECRET_ID = "cinder-stats-secrets"
SHARED_SECRET_ID = "stats-shared-credential"
AUDIENCE = "stats.cinder.ink"
KEYCHAIN_SERVICE = "org.uxuiai.stats.grant.v2"
KEYCHAIN_UPSERT = Path.home() / ".agents/scripts/keychain-upsert.swift"


def aws(*arguments: str, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["aws", *arguments, "--region", REGION],
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
    )


def read_secret(secret_id: str) -> dict | None:
    result = aws(
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        secret_id,
        "--query",
        "SecretString",
        "--output",
        "text",
    )
    if result.returncode:
        return None
    document = json.loads(result.stdout)
    return document if isinstance(document, dict) else None


def write_secret(secret_id: str, document: dict, create: bool) -> None:
    action = "create-secret" if create else "put-secret-value"
    identifier = "--name" if create else "--secret-id"
    result = aws(
        "secretsmanager",
        action,
        identifier,
        secret_id,
        "--secret-string",
        "file:///dev/stdin",
        input_text=json.dumps(document, separators=(",", ":")),
    )
    if result.returncode:
        raise SystemExit(f"failed to provision {secret_id}")


def store_keychain(secret: str) -> None:
    if not KEYCHAIN_UPSERT.is_file():
        raise SystemExit("private Keychain helper is unavailable")
    result = subprocess.run(
        ["/usr/bin/xcrun", "swift", str(KEYCHAIN_UPSERT), "put", KEYCHAIN_SERVICE, AUDIENCE],
        input=secret,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit("failed to store the audience grant in Keychain")


def main() -> None:
    identity = aws("sts", "get-caller-identity", "--query", "Account", "--output", "text")
    if identity.returncode or identity.stdout.strip() != EXPECTED_ACCOUNT:
        raise SystemExit("refusing stats provisioning outside the expected AWS account")

    shared = read_secret(SHARED_SECRET_ID)
    if not shared or not isinstance(shared.get("password_hashes"), list):
        raise SystemExit("shared credential document is unavailable or malformed")
    grants = shared.get("grant_secrets")
    if not isinstance(grants, dict):
        raise SystemExit("shared grant map is malformed")

    grant_secret = grants.get(AUDIENCE)
    changed = False
    if grant_secret is not None and (not isinstance(grant_secret, str) or len(grant_secret) < 32):
        raise SystemExit("existing Cinder audience grant is malformed")
    if grant_secret is None:
        grant_secret = secrets.token_hex(32)
        grants[AUDIENCE] = grant_secret
        write_secret(SHARED_SECRET_ID, shared, create=False)
        changed = True
    store_keychain(grant_secret)

    surface = read_secret(SURFACE_SECRET_ID)
    created = surface is None
    if created:
        surface = {"session_secret": secrets.token_hex(32), "password_hashes": []}
        write_secret(SURFACE_SECRET_ID, surface, create=True)
    elif not isinstance(surface.get("session_secret"), str):
        raise SystemExit("surface secret document is malformed")

    print(
        f"Cinder auth ready: shared_audience_added={'yes' if changed else 'no'} "
        f"surface_created={'yes' if created else 'no'} keychain=yes"
    )


if __name__ == "__main__":
    main()
