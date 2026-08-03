"""Theme / design system for the PiLink chat CLI.

Exact port of the web frontend design tokens (dark glassmorphism look) into
Textual: palette, agent roles, role detection, status maps and the animated
``PulseDot`` widget.

This module is the dependency-free base: it imports ONLY from ``textual``
(``Static``) and the standard library (``re``, ``typing``). Other modules
may import from here, but this module never imports them.
"""

import re
from typing import Dict

from textual.widgets import Static

# ---------------------------------------------------------------------------
# Design tokens (exact port from the web frontend).
# ---------------------------------------------------------------------------

PALETTE: Dict[str, str] = {
    # Backgrounds (solid approximations of the web's rgba glass layers).
    "bg-base": "#0b0f19",
    "bg-surface": "#111827",
    "bg-card": "#1e293b",
    "bg-hover": "#334155",
    # Text.
    "text-primary": "#f8fafc",
    "text-secondary": "#94a3b8",
    "text-muted": "#8b9cb5",
    # Accents.
    "accent-cyan": "#38bdf8",
    "accent-emerald": "#34d399",
    "accent-purple": "#c084fc",
    "accent-amber": "#fbbf24",
    "accent-rose": "#f43f5e",
    "accent-indigo": "#818cf8",
}

# Agent roles: key -> {name, icon, color}. Icons match the web frontend.
ROLE_CONFIG: Dict[str, Dict[str, str]] = {
    "manager": {"name": "Manager", "icon": "👑", "color": "#c084fc"},
    "aieng": {"name": "AI Engineer", "icon": "🧠", "color": "#38bdf8"},
    "dev": {"name": "Dev", "icon": "⚡", "color": "#60a5fa"},
    "researcher": {"name": "Researcher", "icon": "🔬", "color": "#34d399"},
    "reviewer": {"name": "Reviewer", "icon": "🛡️", "color": "#fbbf24"},
    "default": {"name": "Agent", "icon": "🤖", "color": "#38bdf8"},
}

# Task lifecycle status keys -> human labels.
STATUS_LABELS: Dict[str, str] = {
    "open": "OPEN",
    "working": "WORKING",
    "input_required": "INPUT REQUIRED",
    "completed": "COMPLETED",
    "failed": "FAILED",
    "cancelled": "CANCELLED",
}

# Task lifecycle status keys -> palette colors
# (web: open cyan, working/input_required amber, completed emerald,
#  failed rose, cancelled muted).
STATUS_COLORS: Dict[str, str] = {
    "open": PALETTE["accent-cyan"],
    "working": PALETTE["accent-amber"],
    "input_required": PALETTE["accent-amber"],
    "completed": PALETTE["accent-emerald"],
    "failed": PALETTE["accent-rose"],
    "cancelled": PALETTE["text-muted"],
}

_CONTROL_RE = None  # compiled lazily


def sanitize_text(text) -> str:
    """Strip terminal control characters (ANSI/OSC injection vector).

    rich.markup.escape() only escapes markup tags; raw ESC bytes and other
    C0/C1 control chars would reach the terminal driver unchanged and could
    manipulate the user's terminal (title, clipboard, bracketed paste...).
    """
    global _CONTROL_RE
    if _CONTROL_RE is None:
        _CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
    return _CONTROL_RE.sub("", "" if text is None else str(text))


def get_role_info(msg_text: str, agent_name: str) -> Dict[str, str]:
    """Detect the agent role for a chat message.

    Same detection rules as the web frontend, case-insensitive over the
    message text plus the agent name:

    * ``"manager"`` -> manager
    * ``"ai engineer"`` or ``"aieng"`` -> aieng
    * ``"dev1"``, ``"dev2"`` or ``"dev "`` -> dev
    * ``"researcher"`` -> researcher
    * ``"reviewer"`` -> reviewer
    * anything else -> default

    Returns the matching ``ROLE_CONFIG`` entry.
    """
    # Trailing space lets a terminal "dev" token (e.g. bare agent name "Dev")
    # satisfy the web's "dev " rule.
    haystack = "{} {} ".format(msg_text or "", agent_name or "").lower()
    if "manager" in haystack:
        return ROLE_CONFIG["manager"]
    if "ai engineer" in haystack or "aieng" in haystack:
        return ROLE_CONFIG["aieng"]
    if "dev1" in haystack or "dev2" in haystack or "dev " in haystack:
        return ROLE_CONFIG["dev"]
    if "researcher" in haystack:
        return ROLE_CONFIG["researcher"]
    if "reviewer" in haystack:
        return ROLE_CONFIG["reviewer"]
    return ROLE_CONFIG["default"]


class PulseDot(Static):
    """Animated status dot (8x8-ish) that pulses green when live, static red on error.

    Class contract (styled in ``app.tcss``):

    * ``status-dot``   base class (dim dot)
    * ``on`` / ``off`` toggled every ``PULSE_INTERVAL`` seconds while live
    * ``error``        static error state (pulse stopped)

    Textual 0.51 provides ``set_interval`` on widgets (via ``MessagePump``),
    so the pulse is a simple interval timer; ``run_worker`` would be the
    fallback if ``set_interval`` were unavailable.
    """

    PULSE_INTERVAL = 0.8  # seconds between on/off toggles

    def __init__(self, renderable: str = "●", *, ok: bool = False, **kwargs):
        super().__init__(renderable, **kwargs)
        self.add_class("status-dot", "off")
        self._pulse_timer = None  # textual.timer.Timer while live, else None
        if ok:
            self.set_state(True)

    def set_state(self, ok: bool) -> None:
        """Switch between live (pulsing green) and error (static red).

        While ``ok`` a timer toggles the ``on``/``off`` classes every
        ``PULSE_INTERVAL`` seconds; when not ``ok`` the timer is stopped and
        the ``error`` class is applied.
        """
        if ok:
            self.remove_class("error")
            self.remove_class("off")
            self.add_class("on")
            if self._pulse_timer is None:
                self._pulse_timer = self.set_interval(
                    self.PULSE_INTERVAL, self._pulse
                )
        else:
            self.remove_class("on", "off")
            self.add_class("error")
            if self._pulse_timer is not None:
                self._pulse_timer.stop()
                self._pulse_timer = None

    def _pulse(self) -> None:
        """One pulse tick: toggle the ``on``/``off`` classes."""
        if self.has_class("on"):
            self.remove_class("on")
            self.add_class("off")
        else:
            self.remove_class("off")
            self.add_class("on")

    def on_unmount(self) -> None:
        """Stop the pulse timer when the widget leaves the screen."""
        if self._pulse_timer is not None:
            self._pulse_timer.stop()
            self._pulse_timer = None
