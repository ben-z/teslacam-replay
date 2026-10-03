#!/usr/bin/env python3
"""Reconcile production GitHub OIDC access to the private ingress."""

import argparse
from dataclasses import dataclass, field
import json
import os
import re
import subprocess
from urllib.parse import quote
from urllib.request import Request, urlopen


REPOSITORY = "ben-z/teslacam-replay"
ENVIRONMENT = "production"
DESCRIPTION = "TeslaCam Replay production CI"
KEYS_PATH = "/tailnet/-/keys"


@dataclass(frozen=True)
class Config:
    api_token: str = field(repr=False)
    ci_tag: str
    timeout_seconds: int = 30


def load_config():
    for name in ("TAILSCALE_API_TOKEN", "TAILSCALE_CI_TAG"):
        if not os.environ.get(name):
            raise ValueError(f"Missing required environment variable: {name}")
    tag = os.environ["TAILSCALE_CI_TAG"]
    if not re.fullmatch(r"tag:[A-Za-z][A-Za-z0-9-]*", tag):
        raise ValueError("TAILSCALE_CI_TAG must contain exactly one valid Tailscale tag")
    token = os.environ["TAILSCALE_API_TOKEN"]
    if any(character.isspace() for character in token):
        raise ValueError("TAILSCALE_API_TOKEN must not contain whitespace")
    return Config(token, tag)


def gh(*arguments):
    return subprocess.run(
        ["gh", *arguments], check=True, text=True, stdout=subprocess.PIPE
    ).stdout


def api(config, method, path, body):
    request = Request(
        "https://api.tailscale.com/api/v2" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + config.api_token,
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urlopen(request, timeout=config.timeout_seconds) as response:
        return json.load(response)


def desired_identity(config, repository):
    if repository["full_name"] != REPOSITORY or not repository["permissions"]["admin"]:
        raise ValueError(f"GitHub administrator access to {REPOSITORY} is required")
    for identifier in (repository["id"], repository["owner"]["id"]):
        if type(identifier) is not int or identifier <= 0:
            raise ValueError("GitHub repository and owner IDs must be positive integers")
    return {
        "keyType": "federated",
        "description": DESCRIPTION,
        "scopes": ["auth_keys"],
        "tags": [config.ci_tag],
        "issuer": "https://token.actions.githubusercontent.com",
        "subject": f"repo:{REPOSITORY}:environment:{ENVIRONMENT}",
        "customClaimRules": {
            "repository": REPOSITORY,
            "repository_id": str(repository["id"]),
            "repository_owner_id": str(repository["owner"]["id"]),
        },
    }


def validate_owner(identity, desired):
    for name in ("keyType", "description", "issuer", "subject", "customClaimRules"):
        if identity[name] != desired[name]:
            raise ValueError(f"Existing Tailscale identity has an incorrect {name}")
    if identity.get("invalid") is True:
        raise ValueError("Existing Tailscale identity is revoked or expired")
    if not isinstance(identity["id"], str) or not identity["id"]:
        raise ValueError("Tailscale identity has no client ID")
    if identity["audience"] != "api.tailscale.com/" + identity["id"]:
        raise ValueError("Tailscale identity has an unexpected audience")
    for name in ("scopes", "tags"):
        if not isinstance(identity[name], list):
            raise ValueError(f"Tailscale identity has invalid {name}")


def reconcile(config):
    repository = json.loads(gh("api", f"repos/{REPOSITORY}"))
    desired = desired_identity(config, repository)
    variables = {
        item["name"]: item["value"]
        for item in json.loads(
            gh("variable", "list", "--repo", REPOSITORY, "--env", ENVIRONMENT,
               "--json", "name,value")
        )
    }
    matches = []
    for key in api(config, "GET", KEYS_PATH + "?all=true", None)["keys"]:
        if key["keyType"] != "federated":
            continue
        identity = api(config, "GET", KEYS_PATH + "/" + quote(key["id"], safe=""), None)
        if identity["keyType"] != key["keyType"]:
            raise ValueError("Tailscale key listing and detail disagree about keyType")
        if (
            identity["description"] == DESCRIPTION
            or (identity["issuer"] == desired["issuer"] and identity["subject"] == desired["subject"])
        ):
            matches.append(identity)
    if len(matches) > 1:
        raise ValueError("Multiple Tailscale identities match TeslaCam production CI")
    saved_id = variables.get("TAILSCALE_CLIENT_ID")
    if saved_id is not None and not matches:
        identity = api(config, "GET", KEYS_PATH + "/" + quote(saved_id, safe=""), None)
        validate_owner(identity, desired)
    if saved_id is not None and (not matches or saved_id != matches[0]["id"]):
        raise ValueError("GitHub TAILSCALE_CLIENT_ID does not match the production identity")

    if matches:
        identity = matches[0]
        validate_owner(identity, desired)
        if any(sorted(identity[name]) != sorted(desired[name]) for name in ("scopes", "tags")):
            desired["audience"] = identity["audience"]
            identity = api(config, "PUT", KEYS_PATH + "/" + quote(identity["id"], safe=""), desired)
    else:
        identity = api(config, "POST", KEYS_PATH, desired)

    validate_owner(identity, desired)
    identity = api(config, "GET", KEYS_PATH + "/" + quote(identity["id"], safe=""), None)
    validate_owner(identity, desired)
    if any(sorted(identity[name]) != sorted(desired[name]) for name in ("scopes", "tags")):
        raise ValueError("Tailscale did not apply the requested scopes and tags")
    for name, value in {
        "TAILSCALE_CLIENT_ID": identity["id"],
        "TAILSCALE_AUDIENCE": identity["audience"],
        "TAILSCALE_CI_TAG": config.ci_tag,
    }.items():
        if variables.get(name) != value:
            gh("variable", "set", name, "--repo", REPOSITORY, "--env", ENVIRONMENT, "--body", value)
    print("Tailscale production federation and GitHub variables are configured.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate required inputs without contacting services")
    arguments = parser.parse_args()
    config = load_config()
    if not arguments.check:
        reconcile(config)


if __name__ == "__main__":
    main()
