"""Right-docked slide-over panel with task metadata + lifecycle timeline.

Mirrors the web frontend's task drawer: header (title, status chip, short
code, close button) plus Overview / Specification / Artifacts / Timeline /
Raw JSON body sections. All store-sourced text is markup-escaped before it
reaches a markup-parsing widget; the raw JSON view is plain text.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from rich.markup import escape
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Static

from pilink_chat_cli.data import ChatStore
from pilink_chat_cli.theme import sanitize_text

try:
    from pilink_chat_cli import theme as _theme
except Exception:  # pragma: no cover - theme.py is a colleague-owned module
    _theme = None

# Cap for chat-mention timeline events (mirrors MAX_TIMELINE_CHAT_EVENTS in
# the web frontend).
MAX_TIMELINE_CHAT_EVENTS = 30

# Statuses the web frontend styles; anything else falls back (defense in
# depth: task.status is file-sourced data that ends up in a CSS class).
_ALLOWED_STATUSES = frozenset(
    {"open", "working", "input_required", "completed", "failed", "cancelled"}
)

# (meta label, task key, widget id) for the Overview meta grid.
_META_ITEMS = (
    ("Full Task UUID", "taskId", "meta-uuid"),
    ("Revision Count", "revision", "meta-revision"),
    ("Created By", "createdByAgentName", "meta-creator"),
    ("Assigned Owner", "ownerAgentName", "meta-owner"),
    ("Lease Expires", "leaseExpiresAt", "meta-lease"),
    ("Created At", "createdAt", "meta-created"),
    ("Updated At", "updatedAt", "meta-updated"),
)


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


def _fmt_dt(value: object) -> Optional[str]:
    """Locale-style string for a timestamp, or None when unparsable."""
    dt = _parse_dt(value)
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else None


def _dict_get(obj: object, key: str, fallback: object = None) -> object:
    """dict-style or attribute-style lookup, never raising."""
    try:
        if hasattr(obj, "get"):
            value = obj.get(key)  # type: ignore[attr-defined]
            return fallback if value is None else value
        return getattr(obj, key, fallback)
    except Exception:
        return fallback


def _role_info(message: object) -> dict:
    """Verified role info for a chat message, defensively."""
    if _theme is None:
        return {}
    try:
        info = _theme.get_role_info(message)
    except Exception:
        info = None
    if isinstance(info, dict):
        return info
    default = _dict_get(getattr(_theme, "ROLE_CONFIG", {}), "agent", None)
    return default if isinstance(default, dict) else {}


def _status_label(status: str) -> str:
    """Human label for a status via theme.STATUS_LABELS when available."""
    if _theme is not None:
        label = _dict_get(getattr(_theme, "STATUS_LABELS", {}), status, None)
        if label:
            return str(label)
    return status


class TaskDrawerClosed(Message):
    """Posted after an open task drawer is closed."""


class TaskDrawer(Vertical):
    """Right-docked slide-over panel with task metadata + lifecycle timeline."""

    def __init__(self, store: ChatStore, **kwargs) -> None:
        kwargs.setdefault("classes", "drawer-panel")
        super().__init__(**kwargs)
        self.store = store
        self._open = False
        self._code: Optional[str] = None
        self._content_key: Optional[str] = None
        self._body: Optional[VerticalScroll] = None
        # Hidden by default; App mounts it and toggles visibility.
        self.styles.display = "none"
        self.styles.dock = "right"
        self.styles.width = "60%"
        self.styles.max_width = 80
        self.styles.height = "1fr"

    def compose(self):
        with Horizontal(classes="drawer-header"):
            title_area = Vertical(classes="drawer-title-area")
            title_area.styles.width = "1fr"
            with title_area:
                yield Static("", id="drawer-title", classes="drawer-title")
                with Horizontal(classes="drawer-subtitle"):
                    yield Static("", id="drawer-status-badge", classes="task-chip open")
                    yield Static("", id="drawer-code", classes="drawer-code")
            yield Button("✕", id="drawer-close", classes="drawer-close")
        body = VerticalScroll(classes="drawer-body")
        self._body = body
        yield body

    def on_mount(self) -> None:
        # Populate a task opened before the widget was mounted (keeps
        # open_task() safe when called before the screen is up).
        if self._open and self._code:
            self._populate(self._code)

    def open_task(self, code: str) -> None:
        """Resolve task, populate, show (display = block)."""
        self._code = code
        self._open = True
        self.styles.display = "block"
        self._populate(code)

    def close_drawer(self) -> None:
        """Hide and notify the app so focus can return to the invoking card."""
        was_open = self._open
        self._open = False
        self.styles.display = "none"
        if was_open:
            self.post_message(TaskDrawerClosed())

    def is_open(self) -> bool:
        return self._open

    def refresh_from_store(self) -> None:
        """Live refresh while open (skip if content unchanged)."""
        if not self._open:
            return
        task = self._resolve_task(self._code)
        key = self._content_key_for(task)
        if key == self._content_key:
            return
        self._content_key = key
        self._populate(self._code)

    def on_key(self, event) -> None:
        """Escape closes (also handled at App level; keep both safe)."""
        if event.key == "escape":
            self.close_drawer()
            # stop: the App-level escape action must not also fire and blur
            # the underlying view while the drawer is open.
            event.stop()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "drawer-close":
            self.close_drawer()

    # -- internals -----------------------------------------------------

    def _resolve_task(self, code: Optional[str]):
        if not code:
            return None
        try:
            task = self.store.task_by_code(code)
        except Exception:
            task = None
        if not isinstance(task, dict):
            task = self._find_by_prefix(code)
        return task

    def _find_by_prefix(self, code: str):
        for task in list(getattr(self.store, "tasks", None) or []):
            if isinstance(task, dict) and str(task.get("taskId") or "").startswith(
                code
            ):
                return task
        return None

    def _content_key_for(self, task: Optional[dict]) -> str:
        """(task content hash) | (message count) — mirrors the web drawer."""
        try:
            task_part = (
                json.dumps(task, sort_keys=True, default=str) if task else "None"
            )
        except (TypeError, ValueError):
            task_part = repr(task) if task else "None"
        messages = list(getattr(self.store, "messages", None) or [])
        return f"{task_part}|{len(messages)}"

    def _populate(self, code: str) -> None:
        if self._body is None:
            return
        task = self._resolve_task(code)
        self._content_key = self._content_key_for(task)
        self._render_header(task, code)
        self._render_body(task, code)

    def _render_header(self, task: Optional[dict], code: str) -> None:
        short = str(code or "")[:8]
        title = self.query_one("#drawer-title", Static)
        badge = self.query_one("#drawer-status-badge", Static)
        code_el = self.query_one("#drawer-code", Static)
        if task is None:
            title.update(escape(sanitize_text(f"Referenced Task Code {short}")))
            badge.update(escape(sanitize_text("Referenced in Chat")))
            badge.set_classes("task-chip working")
        else:
            title.update(escape(sanitize_text(str(task.get("title") or "Task Details"))))
            status = self._safe_status(task.get("status"))
            badge.update(escape(sanitize_text(_status_label(status))))
            badge.set_classes(f"task-chip {status}")
        code_el.update(escape(sanitize_text(f"🔑 {short}")))

    def _render_body(self, task: Optional[dict], code: str) -> None:
        assert self._body is not None
        self._body.remove_children()
        self._body.mount(self._overview_section(task, code))
        self._body.mount(self._spec_section(task, code))
        artifacts = self._artifacts_section(task)
        if artifacts is not None:
            self._body.mount(artifacts)
        self._body.mount(self._timeline_section(task, code))
        self._body.mount(self._json_section(task))

    def _safe_status(self, status: object, fallback: str = "open") -> str:
        try:
            status = str(status or "").lower().strip()
        except Exception:
            return fallback
        return status if status in _ALLOWED_STATUSES else fallback

    # -- body sections -------------------------------------------------

    @staticmethod
    def _section_title(text: str) -> Static:
        return Static(escape(sanitize_text(text)), classes="section-title")

    def _overview_section(self, task: Optional[dict], code: str) -> Vertical:
        short = str(code or "")[:8]
        section = Vertical(classes="section-box")
        section.mount(self._section_title("📌 Overview"))
        grid = Vertical(classes="meta-grid")
        for label, key, widget_id in _META_ITEMS:
            item = Vertical(classes="meta-item")
            item.mount(Static(escape(label), classes="meta-label"))
            item.mount(
                Static(
                    escape(self._meta_value(task, key, widget_id, short)),
                    classes="meta-val",
                    id=widget_id,
                )
            )
            grid.mount(item)
        section.mount(grid)
        return section

    def _meta_value(self, task: Optional[dict], key: str, widget_id: str, short: str) -> str:
        """Overview meta value, sanitized (control chars stripped)."""
        return sanitize_text(self._meta_value_raw(task, key, widget_id, short))

    def _meta_value_raw(self, task: Optional[dict], key: str, widget_id: str, short: str) -> str:
        if task is None:
            return short if widget_id == "meta-uuid" else "-"
        if widget_id == "meta-uuid":
            return str(task.get(key) or short)
        if widget_id == "meta-revision":
            revision = task.get(key)
            return "#" + str(revision) if isinstance(revision, int) else "#1"
        if widget_id == "meta-creator":
            return str(task.get(key) or "Agent")
        if widget_id == "meta-owner":
            return str(task.get(key) or "Unassigned")
        if widget_id in ("meta-lease", "meta-created", "meta-updated"):
            return _fmt_dt(task.get(key)) or "-"
        return str(task.get(key) or "-")

    def _spec_section(self, task: Optional[dict], code: str) -> Vertical:
        short = str(code or "")[:8]
        section = Vertical(classes="section-box")
        section.mount(self._section_title("📝 Specification"))
        if task is None:
            text = f"Task {short} was discussed in public agent chat messages."
        else:
            text = str(task.get("details") or "No details provided.")
        section.mount(
            Static(escape(sanitize_text(text)), classes="spec-text", id="drawer-details")
        )
        return section

    def _artifacts_section(self, task: Optional[dict]) -> Optional[Vertical]:
        if task is None:
            return None
        status_message = task.get("statusMessage")
        artifact = task.get("artifact")
        if not status_message and not artifact:
            return None
        section = Vertical(classes="section-box", id="box-artifacts")
        section.mount(self._section_title("🏆 Artifacts & Outcome"))
        if status_message:
            section.mount(
                Static(
                    "Status: " + escape(sanitize_text(str(status_message))),
                    classes="artifact-status",
                    id="drawer-artifact-status",
                )
            )
        if artifact:
            section.mount(
                Static(
                    "Artifact: " + escape(sanitize_text(str(artifact))),
                    classes="artifact-code",
                    id="drawer-artifact-code",
                )
            )
        return section

    def _timeline_section(self, task: Optional[dict], code: str) -> Vertical:
        section = Vertical(classes="section-box")
        section.mount(self._section_title("⚡ Lifecycle Timeline"))
        timeline = Vertical(classes="timeline", id="drawer-timeline")
        events = []

        if task is not None and task.get("createdAt"):
            events.append(
                (
                    "🟢 Task Created",
                    str(task.get("createdByAgentName") or "Agent"),
                    _fmt_dt(task.get("createdAt")) or "",
                    'Task created with initial status "{}"'.format(
                        self._safe_status(task.get("status"))
                    ),
                )
            )

        for msg in self._chat_mentions(code):
            text = str(msg.get("agentMessage") or "")
            cursor = msg.get("cursor")
            cursor_label = f"Cursor #{cursor}" if cursor is not None else ""
            role = _role_info(msg)
            events.append(
                (
                    f"💬 Chat Handoff / Discussion ({cursor_label})",
                    f"{_dict_get(role, 'icon', '🤖')} {msg.get('agentName') or 'Agent'}",
                    cursor_label,
                    text,
                )
            )

        if task is not None and task.get("updatedAt"):
            status = self._safe_status(task.get("status"))
            events.append(
                (
                    f"⚡ Current State ({status.upper()})",
                    str(task.get("ownerAgentName") or "Agent"),
                    _fmt_dt(task.get("updatedAt")) or "",
                    str(
                        task.get("statusMessage")
                        or f"Task revision #{task.get('revision') or 1}"
                    ),
                )
            )

        if not events:
            timeline.mount(
                Static(
                    "No timeline events recorded for this task code.",
                    classes="timeline-empty",
                )
            )
        for title, author, ts, details in events:
            timeline.mount(self._timeline_item(title, author, ts, details))
        section.mount(timeline)
        return section

    def _timeline_item(
        self, title: str, author: str, ts: str, details: str
    ) -> Horizontal:
        item = Horizontal(classes="timeline-item")
        item.mount(Static("", classes="timeline-icon"))
        content = Vertical(classes="timeline-content")
        header = Horizontal(classes="timeline-header")
        header.mount(Static(escape(sanitize_text(title)), classes="timeline-title"))
        header.mount(Static(escape(sanitize_text(ts))))
        content.mount(header)
        content.mount(Static(escape(sanitize_text(author)), classes="timeline-author"))
        content.mount(Static(escape(sanitize_text(details)), classes="timeline-msg"))
        item.mount(content)
        return item

    def _chat_mentions(self, code: str) -> list:
        """Up to MAX_TIMELINE_CHAT_EVENTS most recent messages mentioning code."""
        code_lower = str(code or "").lower()
        mentions = []
        for msg in reversed(list(getattr(self.store, "messages", None) or [])):
            if not isinstance(msg, dict):
                continue
            if code_lower and code_lower in str(msg.get("agentMessage") or "").lower():
                mentions.append(msg)
                if len(mentions) >= MAX_TIMELINE_CHAT_EVENTS:
                    break
        mentions.reverse()
        return mentions

    def _json_section(self, task: Optional[dict]) -> Vertical:
        section = Vertical(classes="section-box")
        section.mount(self._section_title("🔍 Raw JSON"))
        if task is None:
            text = "Task entry not found in active tasks array."
        else:
            text = json.dumps(task, indent=2, default=str)
        # Plain text: no markup parsing.
        section.mount(
            Static(text, markup=False, classes="json-view", id="drawer-raw-json")
        )
        return section
