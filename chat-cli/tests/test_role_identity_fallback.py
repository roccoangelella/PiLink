from __future__ import annotations

import unittest

from pilink_chat_cli.theme import get_role_info


class RoleIdentityFallbackTests(unittest.TestCase):
    def test_generic_actor_uses_authenticated_client_name_without_role_upgrade(self) -> None:
        message = {
            "agentName": "Dev 1",
            "agentMessage": "manager and AI Engineer are mentioned here",
            "authorRole": {
                "schemaVersion": 1,
                "source": "generic_actor",
                "displayRoleId": "agent",
                "displayRoleLabel": "AGENT",
            },
        }

        role = get_role_info(message)
        self.assertEqual(role["id"], "agent")
        self.assertEqual(role["name"], "Dev 1 · OAUTH")
        self.assertEqual(role["icon"], "🤖")

    def test_generic_actor_accepts_snake_case_payloads(self) -> None:
        message = {
            "agent_name": "AI Engineer",
            "author_role": {
                "schema_version": 1,
                "source": "generic_actor",
                "display_role_id": "agent",
                "display_role_label": "AGENT",
            },
        }

        role = get_role_info(message)
        self.assertEqual(role["id"], "agent")
        self.assertEqual(role["name"], "AI Engineer · OAUTH")

    def test_invalid_generic_actor_name_falls_back_to_agent(self) -> None:
        message = {
            "agentName": "Manager\x1b]52;clipboard",
            "authorRole": {
                "schemaVersion": 1,
                "source": "generic_actor",
                "displayRoleId": "agent",
                "displayRoleLabel": "AGENT",
            },
        }

        role = get_role_info(message)
        self.assertEqual(role["id"], "agent")
        self.assertEqual(role["name"], "Manager]52;clipboard · OAUTH")

    def test_verified_role_remains_authoritative(self) -> None:
        message = {
            "agentName": "Misleading OAuth Name",
            "authorRole": {
                "schemaVersion": 1,
                "source": "verified_collaboration_session",
                "canonicalRoleId": "manager",
                "occupancyLabel": "manager",
                "contractId": "pilink-collaboration/manager",
                "contractVersion": "1.1.0",
                "displayRoleId": "manager",
                "displayRoleLabel": "MANAGER",
            },
        }

        role = get_role_info(message)
        self.assertEqual(role["id"], "manager")
        self.assertEqual(role["name"], "MANAGER")
        self.assertEqual(role["icon"], "👑")


if __name__ == "__main__":
    unittest.main()
