# Computer Use (Single Agent preview)

PiLink can optionally expose the desktop to one authenticated **Single agent**
MCP client through an observe/act loop. This capability is deliberately
independent from Full Access: desktop control does not grant unrestricted
filesystem or shell access, and Full Access does not implicitly grant desktop
control.

## Enable it

Start Single agent with the explicit launch flag:

```bash
pilink start --mode single --allow-computer-control
```

For a local-only server:

```bash
pilink serve --mode single --allow-computer-control
```

The flag is rejected for Agents chat and CLI pilink-endpoint/gateway launches.
It is transient: restarting PiLink without the flag removes the desktop tools.
The launcher sets `PI_COMPUTER_CONTROL=true` only for that child process. If no
explicit allowlist is already present, it sets
`PI_COMPUTER_CONTROL_CLIENT_IDS=*` for that launch, matching the explicit local
operator decision. Operators with multiple OAuth clients should instead set an
explicit allowlist before launch, for example:

```bash
PI_COMPUTER_CONTROL_CLIENT_IDS=pi_0123456789abcdef \
  pilink start --mode single --allow-computer-control
```

Direct environment configuration is also supported, but it must name at least
one authorized client:

```text
PI_RUNTIME_MODE=single
PI_COMPUTER_CONTROL=true
PI_COMPUTER_CONTROL_CLIENT_IDS=pi_0123456789abcdef
```

`PI_COMPUTER_CONTROL=true` with collaboration mode fails closed.

## MCP contract

When the authenticated connection is eligible, PiLink adds exactly two tools:

- `computer_observe` captures the current desktop and returns a PNG MCP image
  block plus structured width, height, capture time, and backend metadata. It
  requires `mcp:read` or `mcp:tools`.
- `computer_action` performs one click, double-click, move, drag, scroll, type,
  keypress, or wait action, waits briefly for the UI to settle, and returns a
  fresh PNG screenshot. It requires `mcp:write` or `mcp:tools`.

The intended model loop is:

```text
observe -> visually reason -> act -> receive post-action screenshot -> repeat
```

PiLink does not stream video through MCP. The model receives state transitions
as screenshots, which keeps bandwidth and model context bounded while still
showing the consequence of every action.

Tool audit records contain metadata only (tool name, client/session identity,
timing, outcome, and existing access-mode classification). Screenshot pixels,
typed text, and coordinates are not written into the tool audit log.

## Linux X11

The X11 backend uses ordinary user-session helpers:

- `DISPLAY` must identify the interactive desktop session;
- mouse/keyboard actions require `xdotool` in the PiLink user's `PATH`;
- screenshots require one of `gnome-screenshot`, `scrot`, or ImageMagick
  `import` in `PATH`.

If screenshot support is present but `xdotool` is absent, observation can work
while state-changing actions fail with an explicit dependency error.

## Linux Wayland

Wayland uses the compositor-approved XDG Desktop Portal path rather than X11
input injection or a privileged virtual-input daemon. PiLink creates one
combined `RemoteDesktop` + `ScreenCast` session, requests keyboard and pointer
control, opens the session's PipeWire stream, and keeps that session alive for
the observe/act loop.

The first `computer_observe` or state-changing `computer_action` normally causes
the desktop to show its own local screen sharing / remote control permission UI.
The user chooses the monitor and approves the requested control locally. PiLink
cannot bypass a denial and does not persist a restore token in this preview.

PiLink's Wayland helper requires the normal desktop portal stack plus Python GI
and GStreamer. On Ubuntu/Debian-family desktops the relevant packages are
typically:

```bash
sudo apt install python3-gi gir1.2-gstreamer-1.0 \
  gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  xdg-desktop-portal
```

The desktop-specific portal backend must also be installed and running (for
example the GNOME or KDE portal supplied by the desktop environment). PiLink
uses the existing user session D-Bus and PipeWire services; it does not start a
root daemon and does not require `ydotool`.

The PipeWire stream is converted to PNG frames in the helper process. For
absolute mouse operations, PiLink maps screenshot pixels back into the portal
stream's logical coordinate space, which is important on scaled/HiDPI Wayland
desktops.

The initial implementation requests one monitor (`multiple=false`) and embeds
the pointer into the captured stream when the portal supports that cursor mode.
Multi-monitor composition and persistent restore tokens are intentionally left
for a later iteration.

### Wayland troubleshooting

If Computer Use reports that Python GI or GStreamer is unavailable, verify that
`python3` can import `gi` and that the PipeWire GStreamer plugin is installed.
If the permission dialog never appears, verify the user session has a working
`xdg-desktop-portal` implementation and a session D-Bus/PipeWire environment.
If the user cancels or denies the portal prompt, PiLink returns that denial to
the MCP client and does not fall back to unrestricted input injection.

## Security boundary

Computer Use is high authority even without a shell. A GUI action can send a
message, modify cloud data, launch programs, disclose visible secrets, or
trigger irreversible actions in another application. Enable it only for a
trusted OAuth client and only while the local desktop is safe to expose.

The safeguards are intentionally layered:

1. explicit local launch opt-in (`--allow-computer-control`) or equivalent
   private environment configuration;
2. runtime enforcement that Computer Use is Single Agent-only;
3. per-client allowlist policy;
4. normal OAuth scope checks (`mcp:read` for observation and `mcp:write` for
   actions, with `mcp:tools` covering both);
5. X11 helper validation or Wayland compositor/portal authorization;
6. bounded and validated coordinates, scroll counts, text sizes, key names,
   waits, image sizes, helper output, and helper runtime;
7. metadata-only tool auditing.

Future Windows/macOS backends should preserve the same policy boundary rather
than tying Computer Use to `PI_UNSAFE_FULL_ACCESS`.
