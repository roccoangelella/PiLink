"""Chat stream view for the PiLink chat CLI.

Terminal port of the web chat stream: toolbar (search + role filter chips),
incremental message rendering (existing cards are never rebuilt; only newly
arrived messages are appended, keyed by cursor), task chips (clickable
buttons for task codes inside messages) and entrance animation for new cards.
"""

from __future__ import annotations

import hashlib
import re
from typing import Dict, List, Optional, Set

from rich.markup import escape
from rich.text import Text
from textual.containers import Horizontal, HorizontalScroll, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Input, Static

from pilink_chat_cli.data import ChatStore
from pilink_chat_cli.theme import PALETTE, ROLE_CONFIG, get_role_info, sanitize_text

# Task codes: full UUID v4 or an 8-hex short code (same regex as the web).
TASK_CODE_RE = re.compile(
    r"\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})\b",
    re.IGNORECASE,
)
BOLD_CODE_RE = re.compile(r"\*\*(.+?)\*\*|`([^`]+)`")


class TaskChipPressed(Message):
    """Posted when the user activates a task chip inside a message card."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__()


def _fallback_key(msg: dict) -> str:
    """Stable fallback key for cursor-less messages."""
    raw = "{}|{}".format(msg.get("agentId", ""), msg.get("agentMessage", ""))
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()


def _message_key(msg: dict) -> str:
    cursor = msg.get("cursor")
    if cursor is not None:
        return "c{}".format(cursor)
    return "x" + _fallback_key(msg)


def _render_body(text: str) -> Text:
    """Sanitize + escape the raw agent text, then apply **bold** and
    `code` styling.

    ``sanitize_text`` strips terminal control characters (ANSI/OSC
    injection vector) first; ``rich.markup.escape`` runs next, so markup
    injection via the agent message is impossible too; the bold/code
    regexes then operate on the escaped text only.
    """
    escaped = escape(sanitize_text(text or ""))
    styled = Text()
    pos = 0
    for match in BOLD_CODE_RE.finditer(escaped):
        styled.append(escaped[pos:match.start()])
        if match.group(1) is not None:
            styled.append(match.group(1), style="bold")
        else:
            styled.append(
                match.group(2),
                style="italic {}".format(PALETTE["accent-cyan"]),
            )
        pos = match.end()
    styled.append(escaped[pos:])
    return styled


class MessageCard(Vertical):
    """One rendered chat message: header, body text and task chips."""

    def __init__(self, msg: dict, store: ChatStore, **kwargs) -> None:
        super().__init__(**kwargs)
        self.add_class("message-card")
        # Size to content: a Vertical defaults to height: 1fr in Textual 0.51,
        # which would shrink cards (and overflow the chips row) when several
        # cards share the stream height. Explicit auto keeps cards self-
        # sufficient even when the app stylesheet is not loaded (headless tests).
        self.styles.height = "auto"
        self._store = store
        self._msg = msg
        self._chips: List[Button] = []

    def compose(self) -> None:
        msg = self._msg
        role = get_role_info(msg)
        color = role["color"]
        cursor = msg.get("cursor")

        # Header row: avatar | author + role tag ... meta (cursor, agent id).
        with Horizontal(classes="msg-header"):
            avatar = Static(role["icon"], classes="avatar")
            avatar.styles.color = color
            avatar.styles.border = ("round", color)
            yield avatar
            with Vertical() as author_block:
                # explicit height: containers default to 1fr and would
                # otherwise expand their auto-height parent (Textual 0.51)
                author_block.styles.height = "auto"
                author_name = Static(escape(sanitize_text(msg.get("agentName", "") or "Agent")), classes="author-name")
                author_name.styles.color = PALETTE["text-primary"]
                yield author_name
                role_tag = Static(role["name"].upper(), classes="role-tag")
                role_tag.styles.color = color
                yield role_tag
            with Horizontal(classes="msg-meta") as meta:
                meta.styles.height = "auto"
                yield Static(
                    "#{}".format(escape(sanitize_text(cursor)) if cursor is not None else "—"),
                    classes="cursor-badge",
                )
                yield Static(
                    "ID: {}".format(escape(sanitize_text(str(msg.get("agentId", ""))[:8]))),
                    classes="msg-id",
                )

        yield Static(_render_body(msg.get("agentMessage", "")), classes="msg-body")

        # One interactive Button per distinct task code in the message.
        seen: Set[str] = set()
        codes: List[str] = []
        for match in TASK_CODE_RE.finditer(msg.get("agentMessage", "") or ""):
            short = match.group(1)[:8]
            if short in seen:
                continue
            seen.add(short)
            codes.append(short)
        # cap: a pathological message must not explode into thousands of buttons
        codes = codes[:50]
        if codes:
            with Horizontal(classes="msg-chips") as chips_row:
                chips_row.styles.height = "auto"
                # CSS ids may only contain [a-zA-Z0-9_-]: sanitize the cursor
                # ("x" is the fallback for cursor-less messages).
                safe_cursor = (
                    re.sub(r"[^a-zA-Z0-9_-]", "", str(cursor))
                    if cursor is not None
                    else "x"
                )
                for short in codes:
                    status = self._store.status_of(short)
                    chip = Button(
                        "🔑 {}".format(short),
                        id="task-chip-{}-{}".format(safe_cursor, short),
                        classes="task-chip {}".format(status),
                    )
                    chip.task_code = short  # type: ignore[attr-defined]
                    chip.styles.max_width = 22
                    self._chips.append(chip)
                    yield chip

    # -- updates ----------------------------------------------------------

    def chips(self) -> List[Button]:
        return list(self._chips)

    def update_chip_styles(self) -> None:
        """Refresh chip status classes in place (no DOM churn)."""
        for chip in self._chips:
            status = self._store.status_of(chip.task_code)  # type: ignore[attr-defined]
            chip.set_classes("task-chip {}".format(status))


class ChatViewport(VerticalScroll):
    """Scrollable message viewport that reports when the live tail is reached."""

    class TailStateChanged(Message):
        def __init__(self, at_end: bool) -> None:
            self.at_end = at_end
            super().__init__()

    def watch_scroll_y(self, old_value: float, new_value: float) -> None:
        super().watch_scroll_y(old_value, new_value)
        self.post_message(self.TailStateChanged(self.at_end()))

    def at_end(self, tolerance: float = 2.0) -> bool:
        return self.max_scroll_y <= tolerance or self.scroll_y >= self.max_scroll_y - tolerance


class ChatStream(Vertical):
    """Toolbar (search + role chips) over a scrollable incremental message stream."""

    def __init__(self, store: ChatStore, **kwargs) -> None:
        super().__init__(**kwargs)
        self._store = store
        self.search_query: str = ""
        self.role_filter: str = "all"
        self._rendered_cursors: Set[str] = set()
        self._rendered_version: Optional[int] = None
        self._was_filtered = False
        self._stream: Optional[ChatViewport] = None
        self._empty_state: Optional[Static] = None
        self._toolbar: Optional[Horizontal] = None
        self._search_input: Optional[Input] = None
        self._jump_latest: Optional[Button] = None
        self._jump_row: Optional[Horizontal] = None
        self._unread_count = 0
        self._initial_tail_applied = False
        self._pre_filter_scroll_y = 0.0
        self._pre_filter_follow = True

    def compose(self):
        with Horizontal(classes="toolbar") as toolbar:
            # Explicit layout styles: keep the widget self-sufficient even when
            # the app stylesheet is not loaded (headless tests).
            toolbar.styles.dock = "top"
            toolbar.styles.height = "auto"
            self._search_input = Input(
                placeholder="Search chat, agents, task IDs…",
                classes="search-box",
                id="chat-search",
            )
            self._search_input.styles.width = 36
            yield self._search_input
            with HorizontalScroll(classes="role-filters") as role_filters:
                # This row owns its horizontal overflow. On medium terminals,
                # every role remains reachable by wheel/keyboard and focused
                # chips are brought into view by Textual's focus scrolling.
                role_filters.styles.height = "auto"
                all_btn = Button("All Roles", classes="role-chip active", id="role-chip-all")
                all_btn.role_key = "all"  # type: ignore[attr-defined]
                yield all_btn
                for key, cfg in ROLE_CONFIG.items():
                    chip = Button(
                        "{} {}".format(cfg["icon"], cfg["name"]),
                        classes="role-chip",
                        id="role-chip-{}".format(key),
                    )
                    chip.role_key = key  # type: ignore[attr-defined]
                    yield chip
        self._jump_row = Horizontal(classes="chat-jump-row")
        self._jump_row.styles.display = "none"
        with self._jump_row:
            self._jump_latest = Button(
                "↓ 0 new",
                id="chat-jump-latest",
                classes="chat-jump-latest",
            )
            yield self._jump_latest
        self._stream = ChatViewport(id="chat-stream")
        self._stream.styles.height = "1fr"
        yield self._stream

    def on_mount(self) -> None:
        self.refresh_from_store()

    # -- filtering --------------------------------------------------------

    def _passes_filters(self, msg: dict) -> bool:
        role = get_role_info(msg)
        if self.role_filter != "all" and role.get("id") != self.role_filter:
            return False
        query = self.search_query.strip().lower()
        if query:
            text = (msg.get("agentMessage", "") or "").lower()
            author = (msg.get("agentName", "") or "").lower()
            cursor = "cursor {}".format(msg.get("cursor", "")).lower()
            if query not in text and query not in author and query not in cursor:
                return False
        return True

    def _filtered_mode(self) -> bool:
        return bool(self.search_query.strip()) or self.role_filter != "all"

    # -- rendering --------------------------------------------------------

    def refresh_from_store(self) -> None:
        if self._stream is None:
            return
        stream = self._stream
        filtered = self._filtered_mode()
        was_filtered = self._was_filtered
        filter_changed = filtered != was_filtered
        at_end_before = stream.at_end()
        version = self._store.version

        # Capture the live-stream state before entering filtered mode. Search
        # results are a temporary view and must not silently change whether the
        # user was following the tail or reading older messages.
        if filter_changed and filtered:
            self._pre_filter_scroll_y = stream.scroll_y
            self._pre_filter_follow = at_end_before
            self._clear_unread()

        # Version reset (file rewritten from scratch) -> clean rebuild.
        if version is not None and self._rendered_version is not None and version != self._rendered_version:
            self._clear_cards()
            self._rendered_cursors.clear()
        self._rendered_version = version

        # Transition filtered <-> unfiltered -> full rebuild.
        if filter_changed:
            self._clear_cards()
            self._rendered_cursors.clear()
        self._was_filtered = filtered

        new_cards = 0
        mount_waiters = []
        if filtered:
            self._render_filtered()
        else:
            new_cards, mount_waiters = self._render_incremental()

        # Keep existing chips' status classes in sync with the store.
        self._update_existing_chips()
        self._sync_empty_state()

        if filtered:
            if filter_changed:
                self.call_after_refresh(stream.scroll_home, animate=False)
            return

        if filter_changed and was_filtered:
            if self._pre_filter_follow:
                self._resume_live_tail_after_mount(mount_waiters)
            else:
                self._restore_pre_filter_after_mount(mount_waiters)
            return

        if not self._initial_tail_applied:
            self._initial_tail_applied = True
            self._resume_live_tail_after_mount(mount_waiters)
        elif new_cards:
            if at_end_before:
                self._resume_live_tail_after_mount(mount_waiters)
            else:
                self._unread_count += new_cards
                self._update_unread_affordance()

    def _clear_cards(self) -> None:
        if self._stream is None:
            return
        for card in self._stream.query(".message-card"):
            card.remove()

    def _render_filtered(self) -> None:
        if self._stream is None:
            return
        shown = 0
        for msg in self._store.messages:
            if not isinstance(msg, dict):
                continue
            if self._passes_filters(msg):
                key = _message_key(msg)
                if key not in self._rendered_cursors:
                    card = MessageCard(msg, self._store)
                    self._stream.mount(card)
                    self._rendered_cursors.add(key)
                shown += 1
        if shown == 0:
            self._ensure_empty_state(
                "No messages match your filters."
                if self._filtered_mode()
                else "Waiting for agent activity…"
            )
        else:
            self._remove_empty_state()

    def _render_incremental(self):
        """Append-only: return mounted count and mount awaitables."""
        if self._stream is None:
            return 0, []
        mounted = 0
        mount_waiters = []
        for msg in self._store.messages:
            if not isinstance(msg, dict):
                continue
            key = _message_key(msg)
            if key in self._rendered_cursors:
                continue
            card = MessageCard(msg, self._store)
            card.styles.opacity = 0.0
            card.add_class("new")
            mount_waiters.append(self._stream.mount(card))
            try:
                card.styles.animate("opacity", 1.0, duration=0.4)
            except Exception:
                # a failed animation must never leave a card invisible
                card.styles.opacity = 1.0
            self._rendered_cursors.add(key)
            mounted += 1
        return mounted, mount_waiters

    def _update_existing_chips(self) -> None:
        if self._stream is None:
            return
        for card in self._stream.query(MessageCard):
            card.update_chip_styles()

    # -- empty state ------------------------------------------------------

    def _ensure_empty_state(self, hint: str) -> None:
        if self._stream is None:
            return
        if self._empty_state is None:
            self._empty_state = Static(
                "💬 No messages to display\n{}".format(hint), classes="empty-state"
            )
            self._stream.mount(self._empty_state)
        else:
            self._empty_state.update("💬 No messages to display\n{}".format(hint))

    def _remove_empty_state(self) -> None:
        if self._empty_state is not None and self._empty_state.is_attached:
            self._empty_state.remove()
            self._empty_state = None

    def _sync_empty_state(self) -> None:
        if self._stream is None:
            return
        if not self._stream.query(".message-card"):
            self._ensure_empty_state(
                "No messages match your filters."
                if self._filtered_mode()
                else "Waiting for agent activity…"
            )
        else:
            self._remove_empty_state()

    # -- live-tail state --------------------------------------------------

    def _restore_pre_filter_scroll(self) -> None:
        if self._stream is None:
            return
        self._stream.scroll_to(y=min(self._pre_filter_scroll_y, self._stream.max_scroll_y), animate=False)

    def _restore_pre_filter_after_mount(self, mount_waiters) -> None:
        if not mount_waiters:
            self.call_after_refresh(self._restore_pre_filter_scroll)
            return
        self.run_worker(
            self._await_mounts_and_restore_pre_filter(mount_waiters),
            exit_on_error=False,
        )

    async def _await_mounts_and_restore_pre_filter(self, mount_waiters) -> None:
        for waiter in mount_waiters:
            await waiter
        self.call_after_refresh(self._restore_pre_filter_scroll)

    def resume_live_tail(self) -> None:
        """Return to the latest message and clear the detached unread count."""
        self._clear_unread()
        if self._stream is not None:
            self.call_after_refresh(self._scroll_tail_after_layout)

    def _resume_live_tail_after_mount(self, mount_waiters) -> None:
        self._clear_unread()
        if not mount_waiters:
            self.resume_live_tail()
            return
        self.run_worker(
            self._await_mounts_and_scroll_tail(mount_waiters),
            exit_on_error=False,
        )

    async def _await_mounts_and_scroll_tail(self, mount_waiters) -> None:
        for waiter in mount_waiters:
            await waiter
        self._scroll_tail_after_layout()

    def _scroll_tail_after_layout(self) -> None:
        """Scroll after mounts settle, then confirm once on the next refresh."""
        if self._stream is None:
            return
        self._stream.scroll_end(animate=False)
        self.call_after_refresh(self._stream.scroll_end, animate=False)

    def _clear_unread(self) -> None:
        self._unread_count = 0
        self._update_unread_affordance()

    def _update_unread_affordance(self) -> None:
        if self._jump_latest is None or self._jump_row is None:
            return
        if self._unread_count > 0 and not self._filtered_mode():
            self._jump_latest.label = "↓ {} new".format(self._unread_count)
            self._jump_row.styles.display = "block"
        else:
            self._jump_row.styles.display = "none"

    def on_chat_viewport_tail_state_changed(self, event: ChatViewport.TailStateChanged) -> None:
        if event.at_end and not self._filtered_mode():
            self._clear_unread()

    # -- interactions -----------------------------------------------------

    def focus_search(self) -> None:
        if self._search_input is not None:
            self._search_input.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "chat-search":
            self.search_query = (event.value or "").strip()
            self.refresh_from_store()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button = event.button
        if button.id == "chat-jump-latest":
            self.resume_live_tail()
            if self._stream is not None:
                self.call_after_refresh(self._stream.focus)
        elif button.has_class("role-chip"):
            self._toggle_role(button)
        elif button.has_class("task-chip"):
            code = getattr(button, "task_code", None)
            if code:
                self.post_message(TaskChipPressed(code))

    def _toggle_role(self, button: Button) -> None:
        role_key = getattr(button, "role_key", "all")
        if self.role_filter == role_key and role_key != "all":
            # clicking the active chip again clears the filter
            role_key = "all"
        self.role_filter = role_key
        for chip in self.query(".role-chip"):
            key = getattr(chip, "role_key", "all")
            chip.set_class(key == role_key, "active")
        self.refresh_from_store()
