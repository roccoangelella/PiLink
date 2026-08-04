"""Data layer for the PiLink chat CLI viewer.

Polling snapshot store for PiLink chat/task JSON state (legacy defaults:
/tmp/pilink-chat-web/chat.json and /tmp/pilink-chat-web/tasks.json, both
overridable via the constructor). Pure stdlib (json + asyncio) — no textual
imports — so this layer is independently testable.

Data shapes (mirrored by tests/fixtures.py):

- chat.json:  {"version": 3, "nextCursor": int,
               "messages": [{"cursor": int, "agentId": str,
                             "agentInstanceId": str, "agentName": str,
                             "collaborationSessionId"?: str,
                             "authorRole": {"schemaVersion": 1,
                                            "source": str,
                                            "displayRoleId": str,
                                            "displayRoleLabel": str, ...},
                             "agentMessage": str}]}
- tasks.json: {"tasks": [{"taskId": str(uuid), "title": str, "details": str,
               "status": "open" | "working" | "input_required" |
                         "completed" | "failed" | "cancelled",
               "createdByAgentName": str, "ownerAgentName"?: str,
               "leaseExpiresAt"?: str, "createdAt": str, "updatedAt": str,
               "revision": int, "statusMessage"?: str, "artifact"?: str}]}

The files are written by an external process and may be observed mid-write
(truncated / partial JSON). Every read failure is contained per file: an
invalid file keeps its previous snapshot and never counts against the other
file.
"""

import asyncio
import json
import logging
from typing import Any, Callable, Dict, List, Optional

DEFAULT_CHAT_FILE = "/tmp/pilink-chat-web/chat.json"
DEFAULT_TASKS_FILE = "/tmp/pilink-chat-web/tasks.json"

# Statuses understood by the web frontend / lifecycle layer. Anything else
# (missing, unknown, malformed) falls back to "working" in status_of().
ALLOWED_STATUSES = frozenset(
    {"open", "working", "input_required", "completed", "failed", "cancelled"}
)


class ChatStore:
    """Polling snapshot store for chat messages and the task board."""

    def __init__(
        self,
        chat_file: str = DEFAULT_CHAT_FILE,
        tasks_file: str = DEFAULT_TASKS_FILE,
        poll_interval: float = 2.0,
        on_update: Optional[Callable[[], None]] = None,
        on_error: Optional[Callable[[str], None]] = None,
        missing_is_empty: bool = False,
    ) -> None:
        self.chat_file = chat_file
        self.tasks_file = tasks_file
        self.poll_interval = poll_interval
        self.on_update = on_update
        self.on_error = on_error
        self.missing_is_empty = missing_is_empty

        # Public snapshot attributes — updated atomically per refresh().
        self.messages: List[dict] = []
        self.tasks: List[dict] = []
        self.version: Optional[int] = None
        self.next_cursor: Optional[int] = None
        self.connected: bool = False
        self.consecutive_failures: int = 0
        self.last_error: Optional[str] = None

        # Internal state.
        self._running: bool = False
        self._task: Optional[asyncio.Task] = None
        self._chat_error: Optional[str] = None
        self._tasks_error: Optional[str] = None

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Spawn the background poll worker.

        Must be called from a running asyncio loop (e.g. App.on_mount);
        asyncio.create_task raises if no loop is running. Calling start()
        while already running is a no-op.
        """
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop())

    def stop(self) -> None:
        """Stop the poll worker and cancel its background task.

        Safe to call multiple times and safe when the worker was never
        started or already finished.
        """
        self._running = False
        if self._task is not None:
            self._task.cancel()

    async def refresh(self) -> None:
        """Perform one poll of both files. NEVER raises.

        Each file is read independently: a valid payload replaces that
        file's previous snapshot; an invalid payload (missing file, malformed
        JSON, wrong shape) keeps the previous snapshot for that file.

        The poll succeeds (on_update, connected=True, failure counter reset)
        if at least one file parsed OK this poll. Only when both files fail
        does the failure counter increment, connected become False and
        on_error(msg) fire with a human-readable last_error.
        """
        chat_ok = self._read_chat()
        tasks_ok = self._read_tasks()

        if chat_ok or tasks_ok:
            self.consecutive_failures = 0
            self.connected = True
            self.last_error = None
            if self.on_update is not None:
                self._safe_call(self.on_update)
        else:
            self.consecutive_failures += 1
            self.connected = False
            errors = [e for e in (self._chat_error, self._tasks_error) if e]
            self.last_error = (
                "; ".join(errors) if errors else "chat.json and tasks.json unreadable"
            )
            if self.on_error is not None:
                self._safe_call(self.on_error, self.last_error)

    async def _poll_loop(self) -> None:
        """Background worker: refresh every poll_interval until stop()."""
        while self._running:
            try:
                await self.refresh()
                await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                # stop() cancelled us — exit cleanly, nothing to clean up.
                break
            except Exception:
                # refresh() is contractually non-raising; if anything
                # unexpected escapes, end the worker rather than spin.
                break

    # ------------------------------------------------------------------
    # per-file readers
    # ------------------------------------------------------------------

    def _read_chat(self) -> bool:
        self._chat_error = None
        try:
            with open(self.chat_file, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            if self.missing_is_empty:
                self.messages = []
                self.version = None
                self.next_cursor = 1
                return True
            self._chat_error = "chat.json: file not found"
        except (OSError, ValueError) as exc:
            # ValueError covers json.JSONDecodeError (partial/truncated writes).
            self._chat_error = "chat.json: {}".format(exc)
        else:
            if isinstance(payload, dict) and isinstance(
                payload.get("messages"), list
            ):
                self.messages = list(payload["messages"])
                self.version = payload.get("version")
                self.next_cursor = payload.get("nextCursor")
                return True
            self._chat_error = (
                'chat.json: invalid shape (expected object with "messages" list)'
            )
        return False

    def _read_tasks(self) -> bool:
        self._tasks_error = None
        try:
            with open(self.tasks_file, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            if self.missing_is_empty:
                self.tasks = []
                return True
            self._tasks_error = "tasks.json: file not found"
        except (OSError, ValueError) as exc:
            self._tasks_error = "tasks.json: {}".format(exc)
        else:
            if isinstance(payload, dict) and isinstance(payload.get("tasks"), list):
                self.tasks = list(payload["tasks"])
                return True
            self._tasks_error = (
                'tasks.json: invalid shape (expected object with "tasks" list)'
            )
        return False

    # ------------------------------------------------------------------
    # lookups
    # ------------------------------------------------------------------

    def task_by_code(self, code: str) -> Optional[dict]:
        """Resolve a task by full taskId or its 8-hex prefix.

        Never raises: non-dict task entries and non-string taskIds are
        skipped. Exact (case-insensitive) match wins over the 8-hex prefix
        match, so an 8-char short code resolves to the task whose taskId
        starts with those 8 characters.
        """
        if not isinstance(code, str) or not code:
            return None
        code_lower = code.lower()
        for task in self.tasks:
            if not isinstance(task, dict):
                continue
            task_id = task.get("taskId")
            if isinstance(task_id, str) and task_id.lower() == code_lower:
                return task
        for task in self.tasks:
            if not isinstance(task, dict):
                continue
            task_id = task.get("taskId")
            if isinstance(task_id, str) and code_lower == task_id.lower()[:8]:
                return task
        return None

    def short_code(self, task_id: str) -> str:
        """8-hex short code for a task id (its first 8 characters)."""
        if isinstance(task_id, str):
            return task_id[:8]
        return ""

    def status_of(self, code: str) -> str:
        """Safe task status for styling; falls back to 'working' when the
        task, its status, or the code is unknown/malformed."""
        task = self.task_by_code(code)
        if task is None:
            return "working"
        status = task.get("status")
        if isinstance(status, str) and status in ALLOWED_STATUSES:
            return status
        return "working"

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _safe_call(callback: Callable, *args: Any) -> None:
        """Invoke a UI-side callback, containing any of its exceptions so
        refresh() keeps its never-raises contract. Failures are logged with
        a traceback (they would otherwise be silently swallowed)."""
        try:
            callback(*args)
        except Exception:
            logging.exception("ChatStore callback failed")
