import copy
import io
import json
import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import tailscale


class FederationTests(unittest.TestCase):
    def setUp(self):
        self.config = tailscale.Config("private-test-token", "tag:private-ci")
        self.repository = {
            "full_name": "ben-z/teslacam-replay",
            "id": 123,
            "owner": {"id": 456},
            "permissions": {"admin": True},
        }
        self.desired = tailscale.desired_identity(self.config, self.repository)
        self.identity = {
            **self.desired,
            "id": "test-client",
            "audience": "api.tailscale.com/test-client",
        }
        self.keys = {}
        self.variables = {}
        self.api_writes = []
        self.variable_writes = []
        self.api_mock = patch.object(tailscale, "api", side_effect=self.api)
        self.gh_mock = patch.object(tailscale, "gh", side_effect=self.gh)
        self.api_mock.start()
        self.gh_mock.start()
        self.addCleanup(self.api_mock.stop)
        self.addCleanup(self.gh_mock.stop)
        output_mock = patch("sys.stdout", new_callable=io.StringIO)
        self.output = output_mock.start()
        self.addCleanup(output_mock.stop)

    def api(self, config, method, path, body):
        self.assertEqual(config, self.config)
        if method == "GET" and path.endswith("?all=true"):
            return {"keys": [
                {"id": key, "keyType": value["keyType"]}
                for key, value in self.keys.items()
                if value.get("invalid") is not True
            ]}
        if method == "GET":
            key_id = path.rsplit("/", 1)[1]
            if key_id not in self.keys:
                raise HTTPError("https://api.tailscale.com/api/v2" + path, 404, "Not Found", {}, None)
            return copy.deepcopy(self.keys[key_id])
        self.api_writes.append((method, path, copy.deepcopy(body)))
        key_id = "test-client" if method == "POST" else path.rsplit("/", 1)[1]
        self.keys[key_id] = {
            **body, "id": key_id, "audience": f"api.tailscale.com/{key_id}"
        }
        return copy.deepcopy(self.keys[key_id])

    def gh(self, *arguments):
        if arguments[0] == "api":
            return json.dumps(self.repository)
        if arguments[1] == "list":
            return json.dumps([
                {"name": name, "value": value} for name, value in self.variables.items()
            ])
        self.assertEqual(arguments[:2], ("variable", "set"))
        self.variable_writes.append(arguments)
        self.variables[arguments[2]] = arguments[-1]
        return ""

    def test_creates_exact_production_trust_and_public_variables(self):
        tailscale.reconcile(self.config)
        self.assertEqual(len(self.api_writes), 1)
        method, path, body = self.api_writes[0]
        self.assertEqual((method, path), ("POST", "/tailnet/-/keys"))
        self.assertEqual(body["scopes"], ["auth_keys"])
        self.assertEqual(body["tags"], ["tag:private-ci"])
        self.assertEqual(body["subject"], "repo:ben-z/teslacam-replay:environment:production")
        self.assertEqual(body["customClaimRules"], {
            "repository": "ben-z/teslacam-replay",
            "repository_id": "123",
            "repository_owner_id": "456",
        })
        self.assertNotIn("audience", body)
        self.assertEqual(self.variables, {
            "TAILSCALE_CLIENT_ID": "test-client",
            "TAILSCALE_AUDIENCE": "api.tailscale.com/test-client",
            "TAILSCALE_CI_TAG": "tag:private-ci",
        })
        self.assertNotIn(self.config.api_token, repr(self.config))
        self.assertNotIn(self.config.api_token, self.output.getvalue())
        self.assertNotIn(self.config.api_token, repr(self.variable_writes))

    def test_second_run_performs_no_writes(self):
        tailscale.reconcile(self.config)
        self.api_writes.clear()
        self.variable_writes.clear()
        tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])
        self.assertEqual(self.variable_writes, [])

    def test_null_key_list_supports_first_registration(self):
        original = self.api

        def null_empty_list(config, method, path, body):
            if method == "GET" and path.endswith("?all=true"):
                return {"keys": None}
            return original(config, method, path, body)

        with patch.object(tailscale, "api", side_effect=null_empty_list):
            tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [("POST", tailscale.KEYS_PATH, self.desired)])
        self.assertEqual(self.variables["TAILSCALE_CLIENT_ID"], "test-client")

    def test_null_key_list_does_not_prove_federated_write_permission(self):
        attempts = []

        def denied_registration(config, method, path, body):
            if method == "GET" and path.endswith("?all=true"):
                return {"keys": None}
            attempts.append((method, path, body))
            raise HTTPError("https://api.tailscale.com/api/v2" + path, 403, "Forbidden", {}, None)

        with patch.object(tailscale, "api", side_effect=denied_registration):
            with self.assertRaises(HTTPError) as caught:
                tailscale.reconcile(self.config)
        self.assertEqual(caught.exception.code, 403)
        self.assertEqual(attempts, [("POST", tailscale.KEYS_PATH, self.desired)])
        self.assertEqual(self.variable_writes, [])
        self.assertEqual(self.output.getvalue(), "")

    def test_null_key_list_does_not_replace_saved_identity(self):
        self.keys["test-client"] = copy.deepcopy(self.identity)
        self.variables["TAILSCALE_CLIENT_ID"] = "test-client"
        original = self.api

        def hidden_identity_list(config, method, path, body):
            if method == "GET" and path.endswith("?all=true"):
                return {"keys": None}
            return original(config, method, path, body)

        with patch.object(tailscale, "api", side_effect=hidden_identity_list):
            with self.assertRaisesRegex(ValueError, "does not match"):
                tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])
        self.assertEqual(self.variable_writes, [])

    def test_malformed_key_lists_fail_before_writes(self):
        for listing in (None, [], {}, {"keys": {}}, {"keys": ""}, {"keys": False}):
            with self.subTest(listing=listing), patch.object(tailscale, "api", return_value=listing):
                with self.assertRaisesRegex(ValueError, "Tailscale key listing"):
                    tailscale.reconcile(self.config)
                self.assertEqual(self.api_writes, [])
                self.assertEqual(self.variable_writes, [])

    def test_mixed_key_listing_does_not_read_non_federated_details(self):
        for key_type in ("auth", "client", "api"):
            self.keys[key_type] = {"id": key_type, "keyType": key_type}
        original = self.api

        def scoped_api(config, method, path, body):
            if method == "GET" and path.rsplit("/", 1)[1] in ("auth", "client", "api"):
                self.fail("federated_keys token must not read other key types")
            return original(config, method, path, body)

        with patch.object(tailscale, "api", side_effect=scoped_api):
            tailscale.reconcile(self.config)
        self.assertEqual(len(self.api_writes), 1)
        self.assertEqual(self.variables["TAILSCALE_CLIENT_ID"], "test-client")

    def test_missing_key_type_is_a_schema_error(self):
        with patch.object(tailscale, "api", return_value={"keys": [{"id": "unknown"}]}):
            with self.assertRaisesRegex(KeyError, "keyType"):
                tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])
        self.assertEqual(self.variable_writes, [])

    def test_listing_and_detail_type_mismatch_is_rejected(self):
        self.keys["test-client"] = copy.deepcopy(self.identity)
        original = self.api

        def inconsistent_api(config, method, path, body):
            identity = original(config, method, path, body)
            if method == "GET" and not path.endswith("?all=true"):
                identity["keyType"] = "auth"
            return identity

        with patch.object(tailscale, "api", side_effect=inconsistent_api):
            with self.assertRaisesRegex(ValueError, "disagree"):
                tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])

    def test_recovers_identity_created_before_variable_publication(self):
        self.keys["test-client"] = copy.deepcopy(self.identity)
        tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])
        self.assertEqual(self.variables["TAILSCALE_CLIENT_ID"], "test-client")

    def test_narrows_existing_scopes_and_updates_tag(self):
        self.keys["test-client"] = {
            **self.identity, "scopes": ["auth_keys", "devices:core"], "tags": ["tag:old-ci"]
        }
        tailscale.reconcile(self.config)
        self.assertEqual(len(self.api_writes), 1)
        self.assertEqual(self.api_writes[0][0], "PUT")
        self.assertEqual(self.keys["test-client"]["scopes"], ["auth_keys"])
        self.assertEqual(self.keys["test-client"]["tags"], ["tag:private-ci"])
        self.assertEqual(self.keys["test-client"]["audience"], self.identity["audience"])

    def test_rejects_ambiguous_identities(self):
        self.keys["test-client"] = copy.deepcopy(self.identity)
        self.keys["other-client"] = {
            **self.identity, "id": "other-client", "audience": "api.tailscale.com/other-client"
        }
        with self.assertRaisesRegex(ValueError, "Multiple"):
            tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])
        self.assertEqual(self.variable_writes, [])

    def test_rejects_wrong_trust_without_changing_it(self):
        for field, value in (
            ("issuer", "https://untrusted.example"),
            ("subject", "repo:ben-z/*:environment:production"),
            ("customClaimRules", {"repository_id": "999"}),
            ("audience", "shared-audience"),
        ):
            with self.subTest(field=field):
                self.keys["test-client"] = {**self.identity, field: value}
                with self.assertRaises(ValueError):
                    tailscale.reconcile(self.config)
                self.assertEqual(self.api_writes, [])
                self.assertEqual(self.variable_writes, [])

    def test_rejects_revoked_identity(self):
        self.keys["test-client"] = {**self.identity, "invalid": True}
        self.variables["TAILSCALE_CLIENT_ID"] = "test-client"
        with self.assertRaisesRegex(ValueError, "revoked"):
            tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])

    def test_rejects_mismatched_saved_client(self):
        self.variables["TAILSCALE_CLIENT_ID"] = "different-client"
        self.keys["test-client"] = copy.deepcopy(self.identity)
        with self.assertRaisesRegex(ValueError, "does not match"):
            tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])

    def test_does_not_recreate_missing_saved_identity(self):
        self.variables["TAILSCALE_CLIENT_ID"] = "missing-client"
        with self.assertRaises(HTTPError):
            tailscale.reconcile(self.config)
        self.assertEqual(self.api_writes, [])

    def test_rejects_non_admin_before_tailscale_calls(self):
        self.repository["permissions"]["admin"] = False
        with patch.object(tailscale, "api") as api:
            with self.assertRaisesRegex(ValueError, "administrator"):
                tailscale.reconcile(self.config)
            api.assert_not_called()

    def test_api_errors_do_not_publish_variables(self):
        with patch.object(tailscale, "api", side_effect=HTTPError(
            "https://api.tailscale.com/api/v2/tailnet/-/keys", 403, "Forbidden", {}, None
        )):
            with self.assertRaises(HTTPError):
                tailscale.reconcile(self.config)
        self.assertEqual(self.variable_writes, [])

    def test_unapplied_update_is_detected_before_publishing(self):
        self.keys["test-client"] = {**self.identity, "scopes": ["all"]}
        original = self.api

        def ignored_update(config, method, path, body):
            if method == "PUT":
                return copy.deepcopy(self.identity)
            return original(config, method, path, body)

        with patch.object(tailscale, "api", side_effect=ignored_update):
            with self.assertRaisesRegex(ValueError, "did not apply"):
                tailscale.reconcile(self.config)
        self.assertEqual(self.variable_writes, [])


class InputTests(unittest.TestCase):
    def test_access_token_is_opaque(self):
        with patch.dict(os.environ, {
            "TAILSCALE_API_TOKEN": "opaque-OAuth-access-token", "TAILSCALE_CI_TAG": "tag:ci"
        }, clear=True):
            config = tailscale.load_config()
        self.assertEqual(config.api_token, "opaque-OAuth-access-token")
        self.assertNotIn(config.api_token, repr(config))

    def test_missing_inputs_fail(self):
        for environment in ({}, {"TAILSCALE_API_TOKEN": "token"}, {"TAILSCALE_CI_TAG": "tag:ci"}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(ValueError, "Missing required"):
                    tailscale.load_config()

    def test_rejects_multiple_or_invalid_tags(self):
        for tag in ("tag:ci,tag:admin", "ci", "tag:ci*", "tag:ci\n"):
            with self.subTest(tag=tag), patch.dict(os.environ, {
                "TAILSCALE_API_TOKEN": "token", "TAILSCALE_CI_TAG": tag
            }, clear=True):
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    tailscale.load_config()


if __name__ == "__main__":
    unittest.main()
