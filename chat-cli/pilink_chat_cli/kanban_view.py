"""Responsive Kanban board for the PiLink chat CLI.

The board deliberately gives overflow to the widgets that own it:

* a horizontal board viewport for medium terminals;
* one independent vertical viewport per workflow column;
* a single-column tabbed mode for narrow terminals.

Task cards remain keyboard and mouse actionable and post ``TaskCardPressed``
when activated.
"""

from __future__ import annotations

import hashlib
import json
import re
import textwrap
from datetime import datetime
from typing import Optional

from rich.text import Text
from textual.containers import Horizontal, HorizontalScroll, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Static

from pilink_chat_cli.data import ChatStore
from pilink_chat_cli.theme import STATUS_LABELS, sanitize_text

# (workflow key, title, concrete task statuses) in display order.
COLUMN_DEFINITIONS = (
    ("open", "Open", ("open",)),
    ("working", "Working", ("working",)),
    ("input_required", "Needs Input", ("input_required",)),
    ("closed", "Closed", ("completed", "failed", "cancelled")),
)

_COLUMN_KEYS = tuple(key for key, _title, _statuses in COLUMN_DEFINITIONS)
_STATUS_TO_COLUMN = {
    status: key
    for key, _title, statuses in COLUMN_DEFINITIONS
    for status in statuses
}

# The medium layout uses fixed-width columns. Card copy is wrapped for the
# minimum usable content width so code, status and owner/time remain visible.
_CARD_TEXT_WIDTH = 28
_TITLE_LINES = 2
_DETAIL_LINES = 2


class TaskCardPressed(Message):
    """Posted when a task card is activated (click or Enter key)."""

    def __init__(self, code: str, button: Button) -> None:
        super().__init__()
        self.code = code
        self.button = button


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


def _updated_sort_key(task: dict) -> float:
    dt = _parse_dt(task.get("updatedAt"))
    if dt is None:
        return 0.0
    try:
        return dt.timestamp()
    except (OverflowError, OSError, ValueError):
        return 0.0


def _wrapped_lines(value: object, width: int, maximum_lines: int) -> list[str]:
    """Return bounded visual lines with an ellipsis on clipped content."""
    collapsed = " ".join(str(value or "").split())
    if not collapsed:
        return []
    lines = textwrap.wrap(
        collapsed,
        width=max(8, width),
        break_long_words=True,
        break_on_hyphens=False,
        replace_whitespace=True,
    )
    if len(lines) <= maximum_lines:
        return lines
    kept = lines[:maximum_lines]
    last = kept[-1].rstrip()
    if len(last) >= width:
        last = last[: max(1, width - 1)].rstrip()
    kept[-1] = last + "…"
    return kept


class KanbanView(Vertical):
    """Responsive four-column workflow board with independent scroll owners."""

    def __init__(self, store: ChatStore, **kwargs) -> None:
        super().__init__(**kwargs)
        self.store = store
        self._tasks_hash: Optional[str] = None
        self._columns: dict[str, Vertical] = {}
        self._column_bodies: dict[str, VerticalScroll] = {}
        self._count_badges: dict[str, Static] = {}
        self._status_tabs: dict[str, Button] = {}
        self._board: Optional[HorizontalScroll] = None
        self._mode = "medium"
        self._active_column = "open"
        self._selected_code: Optional[str] = None

    def compose(self):
        with Horizontal(classes="kanban-status-tabs"):
            for key, title, _statuses in COLUMN_DEFINITIONS:
                tab = Button(
                    f"{title} 0",
                    classes="kanban-status-tab",
                    id=f"kanban-tab-{key}",
                )
                tab.column_key = key  # type: ignore[attr-defined]
                self._status_tabs[key] = tab
                yield tab

        self._board = HorizontalScroll(classes="kanban-board-scroll", id="kanban-board-scroll")
        with self._board:
            for key, title, _statuses in COLUMN_DEFINITIONS:
                column = Vertical(classes=f"kanban-col {key}")
                column.column_key = key  # type: ignore[attr-defined]
                self._columns[key] = column
                with column:
                    with Horizontal(classes="col-header"):
                        with Horizontal(classes="col-title"):
                            yield Static("●", classes=f"status-dot {key}")
                            yield Static(title)
                        badge = Static("0", classes="badge-count")
                        self._count_badges[key] = badge
                        yield badge
                    body = VerticalScroll(classes="kanban-body", id=f"kanban-body-{key}")
                    self._column_bodies[key] = body
                    yield body

    def on_mount(self) -> None:
        self.set_viewport_width(self.app.size.width)
        self._tasks_hash = None
        self.refresh_from_store()

    # -- responsive layout ------------------------------------------------

    def set_viewport_width(self, width: int) -> None:
        mode = "wide" if width >= 140 else "medium" if width >= 90 else "compact"
        if mode == self._mode and self.has_class(mode):
            return
        if mode == "compact":
            focused = self.screen.focused
            if focused is not None and focused.has_class("task-card"):
                status = getattr(focused, "task_status", "open")
                self._active_column = _STATUS_TO_COLUMN.get(status, "open")
        for candidate in ("wide", "medium", "compact"):
            self.remove_class(candidate)
        self.add_class(mode)
        self._mode = mode
        self._apply_column_visibility()

    def _apply_column_visibility(self) -> None:
        compact = self._mode == "compact"
        for key, column in self._columns.items():
            column.styles.display = "block" if not compact or key == self._active_column else "none"
        for key, tab in self._status_tabs.items():
            tab.set_class(key == self._active_column, "active")
        if self._board is not None and compact:
            self.call_after_refresh(self._board.scroll_home, animate=False)

    def _cycle_column(self, direction: int) -> None:
        if self._mode != "compact":
            return
        index = _COLUMN_KEYS.index(self._active_column)
        self._active_column = _COLUMN_KEYS[(index + direction) % len(_COLUMN_KEYS)]
        self._apply_column_visibility()
        self.call_after_refresh(self.focus_active_column)

    def focus_active_column(self) -> None:
        body = self._column_bodies.get(self._active_column)
        if body is None:
            return
        first = next(iter(body.query(".task-card")), None)
        if first is not None:
            first.focus()
        else:
            body.focus()

    # -- rendering --------------------------------------------------------

    def refresh_from_store(self) -> None:
        """Rebuild column bodies only when the task list changed."""
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
        grouped = {key: [] for key in _COLUMN_KEYS}
        for task in tasks:
            if not isinstance(task, dict) or not isinstance(task.get("taskId"), str):
                continue
            status = str(task.get("status") or "open").lower()
            target = _STATUS_TO_COLUMN.get(status, "open")
            grouped[target].append(task)

        # Closed work is a history view: newest terminal transition first.
        grouped["closed"].sort(key=_updated_sort_key, reverse=True)

        for key, title, _statuses in COLUMN_DEFINITIONS:
            self._render_column(key, title, grouped[key])
        self._apply_column_visibility()

    def _render_column(self, key: str, title: str, tasks: list) -> None:
        body = self._column_bodies[key]
        previous_offset = body.scroll_y
        focused_code = self._focused_code_in(body)
        body.remove_children()

        badge = self._count_badges[key]
        badge.update(str(len(tasks)))
        tab = self._status_tabs[key]
        tab.label = f"{title} {len(tasks)}"

        if not tasks:
            body.mount(Static("No tasks yet", classes="empty-col"))
        else:
            for task in tasks:
                body.mount(self._make_card(task))

        self.call_after_refresh(
            self._restore_column_state,
            key,
            previous_offset,
            focused_code,
        )

    def _focused_code_in(self, body: VerticalScroll) -> Optional[str]:
        focused = self.screen.focused
        if focused is None or not focused.has_class("task-card"):
            return None
        for card in body.query(".task-card"):
            if card is focused:
                return getattr(card, "task_code", None)
        return None

    def _restore_column_state(
        self,
        key: str,
        previous_offset: float,
        focused_code: Optional[str],
    ) -> None:
        body = self._column_bodies[key]
        body.scroll_to(y=min(previous_offset, body.max_scroll_y), animate=False)
        if focused_code is None:
            return
        for card in body.query(".task-card"):
            if getattr(card, "task_code", None) == focused_code and card.display:
                card.focus()
                return

    def _make_card(self, task: dict) -> Button:
        code = self._short_code(task.get("taskId", ""))
        status = str(task.get("status") or "open").lower()
        if status not in STATUS_LABELS:
            status = "open"
        button = Button(
            self._card_label(task, code, status),
            classes=f"task-card {status}",
            id="task-card-{}".format(re.sub(r"[^a-zA-Z0-9_-]", "", str(code))),
        )
        button.task_code = code  # type: ignore[attr-defined]
        button.task_status = status  # type: ignore[attr-defined]
        button.set_class(code == self._selected_code, "selected")
        return button

    def _short_code(self, task_id: object) -> str:
        try:
            code = self.store.short_code(task_id)
        except Exception:
            code = None
        if not code:
            code = task_id
        return str(code)[:8]

    def _card_label(self, task: dict, code: str, status: str) -> Text:
        title_lines = _wrapped_lines(
            task.get("title") or "Untitled Task",
            _CARD_TEXT_WIDTH,
            _TITLE_LINES,
        )
        detail_lines = _wrapped_lines(
            task.get("details") or "",
            _CARD_TEXT_WIDTH,
            _DETAIL_LINES,
        )
        owner = str(task.get("ownerAgentName") or task.get("createdByAgentName") or "Agent")
        updated = _updated_time(task.get("updatedAt"))
        status_label = STATUS_LABELS.get(status, status.upper())

        label = Text()
        label.append("🔑 " + sanitize_text(code), style="bold #38bdf8")
        label.append("  ")
        label.append(sanitize_text(status_label), style="bold")
        for line in title_lines:
            label.append("\n")
            label.append(sanitize_text(line), style="bold")
        for line in detail_lines:
            label.append("\n")
            label.append(sanitize_text(line), style="dim")
        label.append("\n")
        label.append("👤 " + sanitize_text(owner), style="dim")
        if updated:
            label.append("  " + sanitize_text(updated), style="dim")
        return label

    # -- selection and interactions --------------------------------------

    def set_selected(self, code: Optional[str]) -> None:
        self._selected_code = str(code)[:8] if code else None
        for card in self.query(".task-card"):
            card.set_class(
                self._selected_code is not None
                and getattr(card, "task_code", None) == self._selected_code,
                "selected",
            )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button = event.button
        if button.has_class("kanban-status-tab"):
            key = getattr(button, "column_key", "open")
            if key in _COLUMN_KEYS:
                self._active_column = key
                self._apply_column_visibility()
                self.call_after_refresh(self.focus_active_column)
            return
        code = getattr(button, "task_code", None)
        if code:
            self.set_selected(code)
            self.post_message(TaskCardPressed(code, button))

    def on_key(self, event) -> None:
        if self._board is None:
            return
        if self._mode == "compact":
            if event.key == "left":
                event.prevent_default()
                event.stop()
                self._cycle_column(-1)
            elif event.key == "right":
                event.prevent_default()
                event.stop()
                self._cycle_column(1)
            return
        if self._mode == "medium":
            if event.key == "left":
                event.prevent_default()
                event.stop()
                self._board.scroll_left(animate=False)
            elif event.key == "right":
                event.prevent_default()
                event.stop()
                self._board.scroll_right(animate=False)
            elif event.key == "ctrl+pageup":
                event.prevent_default()
                event.stop()
                self._board.scroll_page_left(animate=False)
            elif event.key == "ctrl+pagedown":
                event.prevent_default()
                event.stop()
                self._board.scroll_page_right(animate=False)
