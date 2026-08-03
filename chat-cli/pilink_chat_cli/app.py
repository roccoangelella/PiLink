"""PiLink Live Chat & Lifecycle — terminal edition (app shell).

A Textual monitor for PiLink's canonical private chat and task state: dark theme,
animated header with brand + status pill + nav tabs, three tab panes
(chat stream, kanban board, raw JSON), a right-docked task-lifecycle
drawer and a footer with key hints. Data is polled from chat.json /
tasks.json by the shared ChatStore (see pilink_chat_cli.data).
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from typing import List, Optional

from textual.app import App
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.widgets import Button, Static

from pilink_chat_cli import __version__
from pilink_chat_cli.chat_view import ChatStream
from pilink_chat_cli.data import ChatStore
from pilink_chat_cli.drawer import TaskDrawer
from pilink_chat_cli.kanban_view import KanbanView
from pilink_chat_cli.theme import PulseDot

DEFAULT_CHAT_FILE = "/tmp/pilink-chat-web/chat.json"
DEFAULT_TASKS_FILE = "/tmp/pilink-chat-web/tasks.json"

FOOTER_HINTS = "1/2/3 tabs · / search · r refresh · esc close · ctrl+q quit"


class PiLinkApp(App):
    """Terminal clone of the PiLink web chat frontend."""

    CSS_PATH = "app.tcss"
    TITLE = "PiLink Live Chat & Lifecycle"

    BINDINGS = [
        ("ctrl+q", "quit", "Quit"),
        ("slash", "search", "Search"),
        ("escape", "escape", "Close drawer / blur"),
        ("r", "refresh", "Refresh now"),
        ("1", "tab_chat", "Chat tab"),
        ("2", "tab_tasks", "Tasks tab"),
        ("3", "tab_json", "JSON tab"),
    ]

    def __init__(
        self,
        chat_file: Optional[str] = None,
        tasks_file: Optional[str] = None,
        poll_interval: float = 2.0,
        missing_as_empty: bool = False,
    ) -> None:
        super().__init__()
        self.chat_file = chat_file or DEFAULT_CHAT_FILE
        self.tasks_file = tasks_file or DEFAULT_TASKS_FILE
        self.poll_interval = poll_interval
        self.active_tab = "chat"
        self._store_stopped = False
        # The store is created here (not in on_mount) because the views take
        # the store in their constructors and are composed before on_mount.
        # ChatStore.start() is deferred to on_mount: it must run on a live
        # asyncio loop. Creating the store performs no I/O and never starts
        # tasks, so booting with missing data files is safe.
        self.store = ChatStore(
            chat_file=self.chat_file,
            tasks_file=self.tasks_file,
            poll_interval=self.poll_interval,
            on_update=self._on_store_update,
            on_error=self._on_store_error,
            missing_is_empty=missing_as_empty,
        )

    # ------------------------------------------------------------------ UI

    def compose(self):
        # Header: brand block | status pill | nav tabs.
        with Horizontal(classes="app-header"):
            with Horizontal(classes="brand"):
                yield Static("π", classes="brand-logo")
                with Vertical() as brand_titles:
                    # fixed width: `auto` collapses containers to 0 in 0.51
                    # (title is 26 cols + padding)
                    brand_titles.styles.width = 30
                    yield Static("PiLink Live Chat & Lifecycle", classes="brand-title")
                    yield Static("terminal edition", classes="subtitle")
            self.status_pill = Horizontal(classes="status-pill")
            with self.status_pill:
                self.pulse_dot = PulseDot()
                yield self.pulse_dot
                self.status_text = Static("Polling live…", id="update-status")
                yield self.status_text
            with Horizontal(classes="nav-tabs"):
                self.chat_tab_btn = Button(
                    "💬 Live Chat (0)", classes="nav-btn active", id="tab-btn-chat"
                )
                self.tasks_tab_btn = Button(
                    "📋 Task Board (0)", classes="nav-btn", id="tab-btn-tasks"
                )
                self.json_tab_btn = Button(
                    "🔍 Live JSON", classes="nav-btn", id="tab-btn-json"
                )
                yield self.chat_tab_btn
                yield self.tasks_tab_btn
                yield self.json_tab_btn

        # Body: three tab panes, only the active one is displayed.
        with Vertical(id="app-container"):
            self.chat_pane = Vertical(id="view-chat")
            with self.chat_pane:
                self.chat_stream = ChatStream(self.store)
                yield self.chat_stream
            self.tasks_pane = Vertical(id="view-tasks")
            with self.tasks_pane:
                self.kanban = KanbanView(self.store)
                yield self.kanban
            self.json_pane = VerticalScroll(id="view-json")
            with self.json_pane:
                yield Static("Agent Chat JSON — chat.json")
                self.json_chat = Static(
                    "// waiting for first poll…",
                    classes="json-view",
                    id="raw-chat-json",
                    markup=False,
                )
                yield self.json_chat
                yield Static("Agent Tasks JSON — tasks.json")
                self.json_tasks = Static(
                    "// waiting for first poll…",
                    classes="json-view",
                    id="raw-tasks-json",
                    markup=False,
                )
                yield self.json_tasks

        yield Static(FOOTER_HINTS, classes="footer-hints", id="footer-hints")

        # Task drawer: mounted last, docked right, hidden until opened.
        self.drawer = TaskDrawer(self.store)
        yield self.drawer

        # Only the chat tab is visible on startup.
        self.tasks_pane.styles.display = "none"
        self.json_pane.styles.display = "none"

    async def on_mount(self) -> None:
        # start() must be called from a running asyncio loop.
        result = self.store.start()
        if asyncio.iscoroutine(result):
            await result
        # Force an immediate poll so the UI is populated right away instead
        # of waiting for the first poll interval; missing files surface the
        # error pill through the store's on_error callback (or this fallback).
        try:
            await self.store.refresh()
        except Exception as error:  # noqa: BLE001 - data files may be absent
            self._on_store_error(str(error))

    def on_unmount(self) -> None:
        self._stop_store()

    # --------------------------------------------------------------- tabs

    def _set_tab(self, name: str) -> None:
        """Show one tab pane, hide the others and move the .active class."""
        self.active_tab = name
        panes = {
            "chat": self.chat_pane,
            "tasks": self.tasks_pane,
            "json": self.json_pane,
        }
        for tab_name, pane in panes.items():
            pane.styles.display = "block" if tab_name == name else "none"
        buttons = {
            "chat": self.chat_tab_btn,
            "tasks": self.tasks_tab_btn,
            "json": self.json_tab_btn,
        }
        for tab_name, button in buttons.items():
            button.set_class(tab_name == name, "active")
        if name == "tasks":
            self.kanban.refresh_from_store()
        elif name == "json":
            self._refresh_json_views()

    def action_tab_chat(self) -> None:
        self._set_tab("chat")

    def action_tab_tasks(self) -> None:
        self._set_tab("tasks")

    def action_tab_json(self) -> None:
        self._set_tab("json")

    # ------------------------------------------------------------ actions

    def action_search(self) -> None:
        self._set_tab("chat")
        self.chat_stream.focus_search()

    def action_refresh(self) -> None:
        # Fire-and-forget refresh so the keypress never blocks the UI.
        self.run_worker(self._refresh_now(), name="refresh-now", exit_on_error=False)

    async def _refresh_now(self) -> None:
        try:
            await self.store.refresh()
        except Exception as error:  # noqa: BLE001 - surface unexpected failures
            self._on_store_error(str(error))

    def action_escape(self) -> None:
        if self.drawer.is_open():
            self.drawer.close_drawer()
            return
        focused = self.focused
        if focused is not None:
            focused.blur()

    async def action_quit(self) -> None:
        self._stop_store()
        self.exit()

    # ------------------------------------------------------------ events

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button is self.chat_tab_btn:
            self.action_tab_chat()
        elif event.button is self.tasks_tab_btn:
            self.action_tab_tasks()
        elif event.button is self.json_tab_btn:
            self.action_tab_json()

    def on_task_chip_pressed(self, event) -> None:
        self.drawer.open_task(event.code)

    def on_task_card_pressed(self, event) -> None:
        self.drawer.open_task(event.code)

    # ------------------------------------------------------ store wiring

    def _on_store_update(self) -> None:
        messages = self.store.messages or []
        tasks = self.store.tasks or []
        now = datetime.now().strftime("%H:%M:%S")
        self.pulse_dot.set_state(True)
        self.status_pill.set_class(False, "error")
        self.status_text.update("Live · {0}".format(now))
        self.chat_tab_btn.label = "💬 Live Chat ({0})".format(len(messages))
        self.tasks_tab_btn.label = "📋 Task Board ({0})".format(len(tasks))
        self.chat_stream.refresh_from_store()
        self.kanban.refresh_from_store()
        self.drawer.refresh_from_store()
        # JSON views are only refreshed while their tab is visible.
        if self.active_tab == "json":
            self._refresh_json_views()

    def _on_store_error(self, message: str) -> None:
        failures = self.store.consecutive_failures if self.store is not None else 0
        self.pulse_dot.set_state(False)
        self.status_pill.set_class(True, "error")
        self.status_text.update("Reconnecting… ({0})".format(failures))

    def _stop_store(self) -> None:
        if self.store is not None and not self._store_stopped:
            self._store_stopped = True
            self.store.stop()

    # --------------------------------------------------------- json tab

    def _refresh_json_views(self) -> None:
        self.json_chat.update(self._json_document(chat=True))
        self.json_tasks.update(self._json_document(chat=False))

    def _json_document(self, chat: bool) -> str:
        if chat:
            label = "chat.json"
            payload = {
                "version": self.store.version,
                "messages": self.store.messages or [],
            }
            has_data = bool(self.store.messages)
        else:
            label = "tasks.json"
            payload = {"tasks": self.store.tasks or []}
            has_data = bool(self.store.tasks)
        text = json.dumps(payload, indent=2, default=str)
        if not has_data and not self.store.connected:
            return "// {0} not available yet — waiting for first poll\n{1}".format(
                label, text
            )
        return text


# ------------------------------------------------------------------- main


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(
        prog="pilink-chat",
        description="PiLink Live Chat & Lifecycle — terminal edition",
    )
    parser.add_argument(
        "--chat-file",
        default=DEFAULT_CHAT_FILE,
        help="path to the chat JSON file (default: %(default)s)",
    )
    parser.add_argument(
        "--tasks-file",
        default=DEFAULT_TASKS_FILE,
        help="path to the tasks JSON file (default: %(default)s)",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=2.0,
        help="seconds between polls of the data files (default: %(default)s)",
    )
    parser.add_argument(
        "--missing-as-empty",
        action="store_true",
        help="treat absent PiLink state files as healthy empty chat/task snapshots",
    )
    parser.add_argument("--version", action="version", version="%(prog)s " + __version__)
    args = parser.parse_args(argv)

    if not os.path.isfile(args.chat_file):
        print(
            "Warning: PiLink chat state is not available at {0} yet; the monitor "
            "will keep polling (legacy default: {1}).".format(
                args.chat_file, DEFAULT_CHAT_FILE
            ),
            file=sys.stderr,
        )
    if not os.path.isfile(args.tasks_file):
        print(
            "Warning: PiLink task state is not available at {0} yet; the monitor "
            "will keep polling (legacy default: {1}).".format(
                args.tasks_file, DEFAULT_TASKS_FILE
            ),
            file=sys.stderr,
        )

    PiLinkApp(
        chat_file=args.chat_file,
        tasks_file=args.tasks_file,
        poll_interval=args.poll_interval,
        missing_as_empty=args.missing_as_empty,
    ).run()


if __name__ == "__main__":
    main()
