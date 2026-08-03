from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from textual.events import MouseScrollUp
from textual.widgets import Button

from pilink_chat_cli.app import PiLinkApp
from pilink_chat_cli.chat_view import ChatViewport


class TUILayoutTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.chat_file = self.root / "chat.json"
        self.tasks_file = self.root / "tasks.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_state(self, messages: list[dict], tasks: list[dict]) -> None:
        self.chat_file.write_text(json.dumps({"version": 1, "messages": messages}))
        self.tasks_file.write_text(json.dumps({"version": 3, "tasks": tasks}))

    @staticmethod
    def _messages(count: int) -> list[dict]:
        return [
            {
                "cursor": index,
                "agentId": "agent-a",
                "agentName": "Agent A",
                "agentMessage": "message {} {}".format(index, "long text " * 8),
            }
            for index in range(1, count + 1)
        ]

    @staticmethod
    def _tasks(count_per_status: int = 6) -> list[dict]:
        statuses = ["open", "working", "input_required", "completed", "failed", "cancelled"]
        tasks = []
        index = 0
        for status in statuses:
            for _ in range(count_per_status):
                tasks.append(
                    {
                        "taskId": f"{index:08x}-0000-4000-8000-000000000000",
                        "title": "Task {} with a title that must remain readable at narrow widths".format(index),
                        "details": "Details long enough to exercise bounded wrapping and preserve the footer. " * 3,
                        "status": status,
                        "revision": index + 1,
                        "createdByAgentName": "Creator",
                        "ownerAgentName": "Owner",
                        "updatedAt": "2026-08-03T20:{:02d}:00Z".format(index % 60),
                    }
                )
                index += 1
        return tasks

    async def test_chat_mouse_scroll_follow_tail_and_unread_affordance(self) -> None:
        messages = self._messages(30)
        self._write_state(messages, [])
        app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)

        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.pause()
            await pilot.pause()
            viewport = app.chat_stream._stream
            self.assertIsInstance(viewport, ChatViewport)
            assert viewport is not None
            self.assertTrue(viewport.allow_vertical_scroll)
            self.assertGreater(viewport.max_scroll_y, 0)
            self.assertTrue(viewport.at_end())

            app.chat_stream.focus_search()
            await pilot.pause()
            focused = app.focused
            before = viewport.scroll_y
            viewport._on_mouse_scroll_up(
                MouseScrollUp(10, 10, 0, -1, 0, False, False, False)
            )
            await pilot.pause()
            self.assertLess(viewport.scroll_y, before)
            self.assertIs(app.focused, focused)

            viewport.scroll_home(animate=False)
            await pilot.pause()
            detached_offset = viewport.scroll_y
            app.store.messages = messages + [
                {
                    "cursor": 31,
                    "agentId": "agent-b",
                    "agentName": "Agent B",
                    "agentMessage": "new detached message",
                }
            ]
            app.chat_stream.refresh_from_store()
            await pilot.pause()
            await pilot.pause()
            self.assertEqual(viewport.scroll_y, detached_offset)
            self.assertEqual(app.chat_stream._unread_count, 1)
            self.assertEqual(app.chat_stream._jump_row.styles.display, "block")

            clicked = await pilot.click("#chat-jump-latest")
            self.assertTrue(clicked)
            await pilot.pause()
            await pilot.pause()
            self.assertTrue(viewport.at_end())
            self.assertEqual(app.chat_stream._unread_count, 0)
            self.assertEqual(app.chat_stream._jump_row.styles.display, "none")
            self.assertIs(app.focused, viewport)

    async def test_chat_filter_restores_manual_stream_position(self) -> None:
        messages = self._messages(30)
        self._write_state(messages, [])
        app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)

        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            await pilot.pause()
            await pilot.pause()
            viewport = app.chat_stream._stream
            assert viewport is not None
            viewport.scroll_to(y=40, animate=False)
            await pilot.pause()
            manual_offset = viewport.scroll_y

            app.chat_stream.search_query = "message 2"
            app.chat_stream.refresh_from_store()
            await pilot.pause()
            await pilot.pause()
            self.assertEqual(viewport.scroll_y, 0)

            app.chat_stream.search_query = ""
            app.chat_stream.refresh_from_store()
            await pilot.pause()
            await pilot.pause()
            await pilot.pause()
            self.assertEqual(viewport.scroll_y, manual_offset)

    async def test_kanban_responsive_columns_and_status_grouping(self) -> None:
        tasks = self._tasks()
        self._write_state([], tasks)

        app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)
        async with app.run_test(size=(160, 45)) as pilot:
            await pilot.pause()
            app.action_tab_tasks()
            await pilot.pause()
            await pilot.pause()
            board = app.kanban._board
            assert board is not None
            self.assertEqual(app.kanban._mode, "wide")
            self.assertEqual(board.max_scroll_x, 0)
            widths = [column.region.width for column in app.kanban._columns.values()]
            self.assertTrue(all(30 <= width <= 45 for width in widths), widths)
            self.assertEqual(len(app.kanban._column_bodies["open"].query(".task-card")), 6)
            self.assertEqual(len(app.kanban._column_bodies["working"].query(".task-card")), 6)
            self.assertEqual(len(app.kanban._column_bodies["input_required"].query(".task-card")), 6)
            self.assertEqual(len(app.kanban._column_bodies["closed"].query(".task-card")), 18)
            self.assertGreater(app.kanban._column_bodies["closed"].max_scroll_y, 0)

            status_columns = {
                "open": "open",
                "working": "working",
                "input_required": "input_required",
                "completed": "closed",
                "failed": "closed",
                "cancelled": "closed",
            }
            for status, column_key in status_columns.items():
                card = next(
                    candidate
                    for candidate in app.kanban._column_bodies[column_key].query(".task-card")
                    if getattr(candidate, "task_status", None) == status
                )
                card.focus()
                await pilot.pause()
                self.assertEqual(card.styles.border.top[0], "double", status)
                app.kanban.set_selected(card.task_code)
                app.tasks_tab_btn.focus()
                await pilot.pause(0.25)
                self.assertEqual(card.styles.border.top[0], "double", status)
                self.assertEqual(card.styles.background.hex6, "#0F3B4D", status)
                app.kanban.set_selected(None)

        app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)
        async with app.run_test(size=(120, 35)) as pilot:
            await pilot.pause()
            app.action_tab_tasks()
            await pilot.pause()
            await pilot.pause()
            board = app.kanban._board
            assert board is not None
            self.assertEqual(app.kanban._mode, "medium")
            self.assertGreater(board.max_scroll_x, 0)
            self.assertEqual(
                [column.region.width for column in app.kanban._columns.values()],
                [36, 36, 36, 36],
            )
            for key, body in app.kanban._column_bodies.items():
                for card in body.query(".task-card"):
                    self.assertLessEqual(card.region.width, body.region.width, key)

        app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)
        async with app.run_test(size=(80, 24)) as pilot:
            await pilot.pause()
            app.action_tab_tasks()
            await pilot.pause()
            await pilot.pause()
            self.assertEqual(app.kanban._mode, "compact")
            visible = [
                key
                for key, column in app.kanban._columns.items()
                if column.styles.display != "none"
            ]
            self.assertEqual(visible, ["open"])
            first = next(iter(app.kanban._column_bodies["open"].query(".task-card")))
            first.focus()
            await pilot.press("right")
            await pilot.pause()
            visible = [
                key
                for key, column in app.kanban._columns.items()
                if column.styles.display != "none"
            ]
            self.assertEqual(visible, ["working"])
            self.assertEqual(app.kanban._active_column, "working")

    async def test_header_and_role_filters_remain_operable_at_supported_widths(self) -> None:
        self._write_state([], [])
        for width, height in ((120, 35), (100, 30), (80, 24), (60, 20)):
            app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)
            async with app.run_test(size=(width, height)) as pilot:
                await pilot.pause()
                await pilot.pause()
                header = app.query_one(".app-header")
                role_filters = app.query_one(".role-filters")
                self.assertEqual(header.max_scroll_x, 0, width)

                for selector in ("#tab-btn-chat", "#tab-btn-tasks", "#tab-btn-json"):
                    button = app.query_one(selector, Button)
                    self.assertGreaterEqual(button.region.x, app.screen.region.x, (width, selector))
                    self.assertLessEqual(button.region.right, app.screen.region.right, (width, selector))

                if width < 110:
                    self.assertEqual(role_filters.styles.display, "none", width)
                else:
                    self.assertEqual(role_filters.styles.display, "block", width)
                    self.assertGreater(role_filters.max_scroll_x, 0)
                    for chip in role_filters.query(".role-chip"):
                        chip.focus()
                        await pilot.pause()
                        await pilot.pause()
                        self.assertGreaterEqual(chip.region.x, app.screen.region.x, chip.id)
                        self.assertLessEqual(chip.region.right, app.screen.region.right, chip.id)

    async def test_kanban_refresh_and_drawer_preserve_context(self) -> None:
        tasks = self._tasks()
        self._write_state([], tasks)
        app = PiLinkApp(str(self.chat_file), str(self.tasks_file), poll_interval=100)

        async with app.run_test(size=(120, 35)) as pilot:
            await pilot.pause()
            app.action_tab_tasks()
            await pilot.pause()
            await pilot.pause()
            body = app.kanban._column_bodies["working"]
            cards = list(body.query(".task-card"))
            self.assertGreaterEqual(len(cards), 3)
            body.scroll_to(y=8, animate=False)
            cards[2].focus()
            await pilot.pause()
            focused_code = cards[2].task_code
            previous_offset = body.scroll_y

            app.store.tasks = [dict(task) for task in tasks]
            for task in app.store.tasks:
                if str(task.get("taskId", "")).startswith(focused_code):
                    task["revision"] = int(task["revision"]) + 1
            app.kanban.refresh_from_store()
            await pilot.pause()
            await pilot.pause()
            self.assertEqual(body.scroll_y, previous_offset)
            self.assertEqual(getattr(app.focused, "task_code", None), focused_code)

            focused_card = app.focused
            class Event:
                code = focused_code
                button = focused_card

            app.on_task_card_pressed(Event())
            await pilot.pause()
            self.assertTrue(app.drawer.is_open())
            self.assertTrue(focused_card.has_class("selected"))
            self.assertEqual(getattr(app.focused, "id", None), "drawer-close")

            app.drawer.close_drawer()
            await pilot.pause()
            self.assertFalse(focused_card.has_class("selected"))
            self.assertIs(app.focused, focused_card)


if __name__ == "__main__":
    unittest.main()
