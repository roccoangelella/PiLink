"""Kanban board widget for the PiLink chat CLI.

Four-column task board mirroring the web frontend: Working, Completed,
Open and Cancelled. Tasks with an unknown status land in the Open column.
Cards are `Button` widgets (mouse + keyboard friendly) and post a
`TaskCardPressed` message when activated.
"""

from __future__ import annotations

import hashlib
import re
import json
from datetime import datetime
from typing import Optional

from rich.text import Text
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.message import Message
from textual.widgets import Button, Static

from pilink_chat_cli.data import ChatStore
from pilink_chat_cli.theme import sanitize_text

# (status key, column title) in display order.
COLUMN_ORDER = (
    ("working", "Working"),
    ("completed", "Completed"),
    ("open", "Open"),
    ("cancelled", "Cancelled"),
)

# Approximate width of two dimmed detail lines on a 34-wide column.
_DETAILS_MAX_CHARS = 100

# Title line limit on a 34-wide column (ellipsized like the details).
_TITLE_MAX_CHARS = 28

# Column width in cells; the grid scrolls horizontally when the terminal
# is narrower than the four columns combined.
_COLUMN_MIN_WIDTH = 34


class TaskCardPressed(Message):
    """Posted when a task card is activated (click or Enter key)."""

    def __init__(self, code: str) -> None:
        super().__init__()
        self.code = code


def _parse_dt(value: object) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp (optionally with a trailing 'Z')."""
    if value is None:
        return None
    try:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text)
    except (ValueError, TypeError):
        return None


def _updated_time(value: object) -> str:
    """'HH:MM:SS' for a task's updatedAt, or '' when unparsable."""
    dt = _parse_dt(value)
    return dt.strftime("%H:%M:%S") if dt else ""


def _ellipsize(text: object, limit: int = _DETAILS_MAX_CHARS) -> str:
    """Collapse whitespace and truncate with '…' at ~2 lines."""
    collapsed = " ".join(str(text).split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


class KanbanView(ScrollableContainer):
    """4-column kanban: Working, Completed, Open, Cancelled (unknown statuses -> Open)."""

    def __init__(self, store: ChatStore, **kwargs) -> None:
        super().__init__(**kwargs)
        self.store = store
        self._tasks_hash: Optional[str] = None
        self._columns: dict = {}
        self._count_badges: dict = {}

    def compose(self):
        with Horizontal(classes="kanban-grid"):
            for status, title in COLUMN_ORDER:
                column = Vertical(classes=f"kanban-col {status}")
                column.styles.min_width = _COLUMN_MIN_WIDTH
                self._columns[status] = column
                with column:
                    header = Horizontal(classes="col-header")
                    with header:
                        with Horizontal(classes="col-title"):
                            yield Static("●", classes=f"status-dot {status}")
                            yield Static(title)
                        badge = Static("0", classes="badge-count")
                        self._count_badges[status] = badge
                        yield badge

    def on_mount(self) -> None:
        # Always render at least once; refresh_from_store() skips afterwards
        # while the underlying task list has not changed.
        self._tasks_hash = None
        self.refresh_from_store()

    def refresh_from_store(self) -> None:
        """Full rebuild (cheap) only when the task list changed."""
        tasks = list(getattr(self.store, "tasks", None) or [])
        digest = self._digest(tasks)
        if digest == self._tasks_hash:
            return
        self._tasks_hash = digest
        self._rebuild(tasks)

    @staticmethod
    def _digest(tasks: list) -> str:
        """Stable hash of the task list (JSON.stringify equivalent)."""
        try:
            payload = json.dumps(tasks, sort_keys=True, default=str)
        except (TypeError, ValueError):
            payload = repr(tasks)
        return hashlib.md5(payload.encode("utf-8", "replace")).hexdigest()

    def _rebuild(self, tasks: list) -> None:
        grouped = {status: [] for status, _title in COLUMN_ORDER}
        for task in tasks:
            if not isinstance(task, dict) or not isinstance(task.get("taskId"), str):
                continue
            status = str(task.get("status") or "open").lower()
            target = status if status in grouped else "open"
            grouped[target].append(task)
        for status, title in COLUMN_ORDER:
            self._render_column(status, title, grouped[status])

    def _render_column(self, status: str, title: str, tasks: list) -> None:
        column = self._columns[status]
        column.remove_children()

        header = Horizontal(classes="col-header")
        col_title = Horizontal(classes="col-title")
        col_title.mount(Static("●", classes=f"status-dot {status}"))
        col_title.mount(Static(title))
        header.mount(col_title)
        badge = Static(str(len(tasks)), classes="badge-count")
        self._count_badges[status] = badge
        header.mount(badge)
        column.mount(header)

        if not tasks:
            column.mount(Static("No tasks yet", classes="empty-col"))
            return
        for task in tasks:
            column.mount(self._make_card(task))

    def _make_card(self, task: dict) -> Button:
        code = self._short_code(task.get("taskId", ""))
        button = Button(
            self._card_label(task, code),
            classes="task-card",
            id="task-card-{}".format(re.sub(r"[^a-zA-Z0-9_-]", "", str(code))),
        )
        button.task_code = code
        return button

    def _short_code(self, task_id: object) -> str:
        try:
            code = self.store.short_code(task_id)
        except Exception:
            code = None
        if not code:
            code = task_id
        return str(code)[:8]

    def _card_label(self, task: dict, code: str) -> Text:
        title = _ellipsize(task.get("title") or "Untitled Task", _TITLE_MAX_CHARS)
        details = _ellipsize(task.get("details") or "")
        owner = str(
            task.get("ownerAgentName") or task.get("createdByAgentName") or "Agent"
        )
        revision = task.get("revision") if isinstance(task.get("revision"), int) else 1
        updated = _updated_time(task.get("updatedAt"))

        label = Text()
        label.append("🔑 " + sanitize_text(code), style="bold #38bdf8")
        label.append("   ")
        label.append(f"Rev #{revision}", style="dim")
        label.append("\n")
        # Text.append is literal (markup-safe), but control chars would still
        # reach the terminal: sanitize every untrusted field before appending.
        label.append(sanitize_text(title), style="bold")
        label.append("\n")
        label.append(sanitize_text(details), style="dim")
        label.append("\n")
        label.append("👤 " + sanitize_text(owner), style="dim")
        label.append("   ")
        label.append(sanitize_text(updated), style="dim")
        return label

    def on_button_pressed(self, event: Button.Pressed) -> None:
        code = getattr(event.button, "task_code", None)
        if code:
            self.post_message(TaskCardPressed(code))
