#!/usr/bin/env python3
import base64
import json
import os
import struct
import sys
import time
import zlib

try:
    import gi
    gi.require_version("Gio", "2.0")
    gi.require_version("Gst", "1.0")
    from gi.repository import Gio, GLib, Gst
except Exception as exc:
    print(json.dumps({"id": None, "ok": False, "error": f"PyGObject/GStreamer is unavailable: {exc}"}), flush=True)
    sys.exit(2)

Gst.init(None)

SERVICE = "org.freedesktop.portal.Desktop"
OBJECT = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
PROPERTIES = "org.freedesktop.DBus.Properties"
MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
PORTAL_RESPONSE_TIMEOUT_MS = 120_000

BUTTONS = {
    "left": 0x110,
    "right": 0x111,
    "middle": 0x112,
}

KEYSYMS = {
    "CTRL": 0xFFE3,
    "CONTROL": 0xFFE3,
    "ALT": 0xFFE9,
    "SHIFT": 0xFFE1,
    "META": 0xFFEB,
    "SUPER": 0xFFEB,
    "CMD": 0xFFEB,
    "COMMAND": 0xFFEB,
    "ENTER": 0xFF0D,
    "RETURN": 0xFF0D,
    "TAB": 0xFF09,
    "ESC": 0xFF1B,
    "ESCAPE": 0xFF1B,
    "SPACE": 0x20,
    "BACKSPACE": 0xFF08,
    "DELETE": 0xFFFF,
    "HOME": 0xFF50,
    "END": 0xFF57,
    "PAGEUP": 0xFF55,
    "PAGEDOWN": 0xFF56,
    "UP": 0xFF52,
    "DOWN": 0xFF54,
    "LEFT": 0xFF51,
    "RIGHT": 0xFF53,
}


class PortalError(RuntimeError):
    pass


def deep_unpack(value):
    if isinstance(value, GLib.Variant):
        return deep_unpack(value.unpack())
    if isinstance(value, dict):
        return {key: deep_unpack(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [deep_unpack(item) for item in value]
    return value


def safe_error(exc):
    text = str(exc).replace("\x00", " ").replace("\r", " ").replace("\n", " ").strip()
    return text[:1000] or "Wayland portal operation failed"


def raw_rgba_to_png(width, height, rgba_data):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw_bytes = bytearray()
    row_bytes = width * 4
    for y in range(height):
        raw_bytes.append(0)
        raw_bytes.extend(rgba_data[y * row_bytes : (y + 1) * row_bytes])

    compressed = zlib.compress(bytes(raw_bytes), level=1)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def png_size(data):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise PortalError("GStreamer did not produce a valid PNG frame")
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    if width <= 0 or height <= 0 or width > 32768 or height > 32768:
        raise PortalError("GStreamer returned an invalid frame size")
    return width, height


def _restore_token_path():
    runtime_dir = GLib.get_user_runtime_dir()
    if runtime_dir and os.path.isdir(runtime_dir):
        return os.path.join(runtime_dir, "pilink_wayland_restore_token")
    return None


def _load_restore_token():
    path = _restore_token_path()
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                token = f.read().strip()
                if token:
                    return token
        except Exception:
            pass
    return None


def _save_restore_token(token):
    path = _restore_token_path()
    if path and token:
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(token.strip())
        except Exception:
            pass


def _clear_restore_token():
    path = _restore_token_path()
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except Exception:
            pass


class WaylandPortalSession:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.unique_name = self.bus.get_unique_name()
        if not self.unique_name:
            raise PortalError("No D-Bus session bus is available")
        self.sender_path = self.unique_name.lstrip(":").replace(".", "_")
        self.counter = 0
        self.session_handle = None
        self.stream_node = None
        self.stream_props = {}
        self.devices = 0
        self.pipewire_fd = None
        self.pipeline = None
        self.appsink = None
        self.use_raw_fallback = False
        self.restore_token = _load_restore_token()
        self.frame_width = None
        self.frame_height = None

    def ensure_started(self):
        if self.pipeline is not None:
            return

        try:
            self._init_session()
        except Exception:
            if self.restore_token:
                self.restore_token = None
                _clear_restore_token()
                if self.session_handle:
                    try:
                        self._call(SESSION, "Close", "()", (), object_path=self.session_handle)
                    except Exception:
                        pass
                    self.session_handle = None
                self._init_session()
            else:
                raise

    def _init_session(self):
        created = self._request(
            REMOTE,
            "CreateSession",
            "(a{sv})",
            ({"session_handle_token": GLib.Variant("s", self._token("session"))},),
        )
        session_handle = created.get("session_handle")
        if not isinstance(session_handle, str) or not session_handle.startswith("/org/freedesktop/portal/desktop/session/"):
            raise PortalError("RemoteDesktop portal returned an invalid session handle")
        self.session_handle = session_handle

        devices_options = {
            "types": GLib.Variant("u", 3),
            "persist_mode": GLib.Variant("u", 2),
        }
        if self.restore_token:
            devices_options["restore_token"] = GLib.Variant("s", self.restore_token)

        self._request(
            REMOTE,
            "SelectDevices",
            "(oa{sv})",
            (self.session_handle, devices_options),
        )

        cursor_mode = 1
        try:
            modes = int(self._property(SCREENCAST, "AvailableCursorModes"))
            if modes & 2:
                cursor_mode = 2
        except Exception:
            pass

        sources_options = {
            "types": GLib.Variant("u", 1),
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", cursor_mode),
            "persist_mode": GLib.Variant("u", 2),
        }
        if self.restore_token:
            sources_options["restore_token"] = GLib.Variant("s", self.restore_token)

        self._request(
            SCREENCAST,
            "SelectSources",
            "(oa{sv})",
            (
                self.session_handle,
                sources_options,
            ),
        )

        started = self._request(
            REMOTE,
            "Start",
            "(osa{sv})",
            (self.session_handle, "", {}),
        )
        new_token = started.get("restore_token")
        if new_token and isinstance(new_token, str):
            self.restore_token = new_token
            _save_restore_token(new_token)

        self.devices = int(started.get("devices", 0))
        if (self.devices & 3) != 3:
            raise PortalError("Desktop permission did not grant both pointer and keyboard control")
        streams = started.get("streams")
        if not isinstance(streams, list) or not streams:
            raise PortalError("Desktop permission did not grant a screen stream")

        first = streams[0]
        if not isinstance(first, list) or len(first) != 2:
            raise PortalError("ScreenCast portal returned an invalid stream")
        self.stream_node = int(first[0])
        self.stream_props = first[1] if isinstance(first[1], dict) else {}
        self.pipewire_fd = self._open_pipewire_remote()
        self._start_pipeline()

    def capture_png(self):
        self.ensure_started()
        sample = self.appsink.emit("try-pull-sample", 5 * Gst.SECOND)
        if sample is None:
            raise PortalError("Timed out waiting for a PipeWire desktop frame")
        buffer = sample.get_buffer()
        ok, mapping = buffer.map(Gst.MapFlags.READ)
        if not ok:
            raise PortalError("Could not map the captured PipeWire frame")
        try:
            raw_data = bytes(mapping.data)
        finally:
            buffer.unmap(mapping)
        if not raw_data:
            raise PortalError("PipeWire produced an empty frame")
        if self.use_raw_fallback:
            caps = sample.get_caps()
            if not caps or caps.get_size() == 0:
                raise PortalError("Could not determine frame format from PipeWire stream")
            structure = caps.get_structure(0)
            width = structure.get_value("width")
            height = structure.get_value("height")
            if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
                raise PortalError("Invalid frame dimensions from PipeWire stream")
            data = raw_rgba_to_png(width, height, raw_data)
        else:
            data = raw_data
        if len(data) > MAX_SCREENSHOT_BYTES:
            raise PortalError("PipeWire produced an oversized PNG frame")
        self.frame_width, self.frame_height = png_size(data)
        return data

    def perform(self, action):
        kind = action.get("action")
        if kind == "wait":
            duration = self._int(action.get("durationMs"), 0, 10000, "durationMs")
            time.sleep(duration / 1000.0)
            return

        self.ensure_started()
        if kind == "type":
            text = action.get("text")
            if not isinstance(text, str) or "\x00" in text or len(text.encode("utf-8")) > 16384:
                raise PortalError("Typed text is invalid or exceeds 16 KiB")
            for char in text:
                self._tap_keysym(self._text_keysym(char))
            return

        if kind == "keypress":
            keys = action.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 8:
                raise PortalError("keys must contain between 1 and 8 key names")
            keysyms = [self._named_keysym(key) for key in keys]
            for keysym in keysyms:
                self._keyboard(keysym, 1)
            for keysym in reversed(keysyms):
                self._keyboard(keysym, 0)
            return

        if kind == "scroll":
            dx = self._int(action.get("dx"), -100, 100, "dx")
            dy = self._int(action.get("dy"), -100, 100, "dy")
            if dy:
                self._call(REMOTE, "NotifyPointerAxisDiscrete", "(oa{sv}ui)", (self.session_handle, {}, 0, dy))
            if dx:
                self._call(REMOTE, "NotifyPointerAxisDiscrete", "(oa{sv}ui)", (self.session_handle, {}, 1, dx))
            return

        if kind == "drag":
            self._move_pixel(action.get("fromX"), action.get("fromY"))
            button = self._button(action.get("button"))
            self._pointer_button(button, 1)
            try:
                start_x = self._int(action.get("fromX"), 0, 32767, "fromX")
                start_y = self._int(action.get("fromY"), 0, 32767, "fromY")
                end_x = self._int(action.get("toX"), 0, 32767, "toX")
                end_y = self._int(action.get("toY"), 0, 32767, "toY")
                for step in range(1, 9):
                    x = round(start_x + (end_x - start_x) * step / 8)
                    y = round(start_y + (end_y - start_y) * step / 8)
                    self._move_pixel(x, y)
                    time.sleep(0.012)
            finally:
                self._pointer_button(button, 0)
            return

        if kind in ("move", "click", "double_click"):
            self._move_pixel(action.get("x"), action.get("y"))
            if kind == "move":
                return
            button = self._button(action.get("button"))
            count = 2 if kind == "double_click" else 1
            for index in range(count):
                self._pointer_button(button, 1)
                self._pointer_button(button, 0)
                if index + 1 < count:
                    time.sleep(0.12)
            return

        raise PortalError(f"Unsupported desktop action '{kind}'")

    def close(self):
        if self.pipeline is not None:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
            self.appsink = None
        if self.pipewire_fd is not None:
            try:
                os.close(self.pipewire_fd)
            except OSError:
                pass
            self.pipewire_fd = None
        if self.session_handle:
            try:
                self._call(SESSION, "Close", "()", (), object_path=self.session_handle)
            except Exception:
                pass
            self.session_handle = None

    def _request(self, interface, method, signature, values):
        token = self._token("request")
        request_path = f"/org/freedesktop/portal/desktop/request/{self.sender_path}/{token}"
        values = list(values)
        options = dict(values[-1])
        options["handle_token"] = GLib.Variant("s", token)
        values[-1] = options
        parameters = GLib.Variant(signature, tuple(values))

        loop = GLib.MainLoop()
        holder = {}

        def on_response(_connection, _sender, _path, _interface, _signal, params, _user_data):
            response, results = params.unpack()
            holder["response"] = int(response)
            holder["results"] = deep_unpack(results)
            loop.quit()

        subscription = self.bus.signal_subscribe(
            SERVICE,
            REQUEST,
            "Response",
            request_path,
            None,
            Gio.DBusSignalFlags.NONE,
            on_response,
            None,
        )

        timed_out = {"value": False}

        def on_timeout():
            timed_out["value"] = True
            loop.quit()
            return False

        timeout_source = GLib.timeout_add(PORTAL_RESPONSE_TIMEOUT_MS, on_timeout)
        try:
            self.bus.call_sync(
                SERVICE,
                OBJECT,
                interface,
                method,
                parameters,
                GLib.VariantType.new("(o)"),
                Gio.DBusCallFlags.NONE,
                15000,
                None,
            )
            loop.run()
        finally:
            self.bus.signal_unsubscribe(subscription)
            if not timed_out["value"]:
                try:
                    GLib.source_remove(timeout_source)
                except Exception:
                    pass

        if timed_out["value"]:
            raise PortalError("Timed out waiting for the desktop permission portal")
        response = holder.get("response")
        if response != 0:
            if response == 1:
                raise PortalError("Desktop permission was cancelled or denied locally")
            raise PortalError(f"Desktop portal request failed with response {response}")
        return holder.get("results", {})

    def _property(self, interface, name):
        result = self.bus.call_sync(
            SERVICE,
            OBJECT,
            PROPERTIES,
            "Get",
            GLib.Variant("(ss)", (interface, name)),
            GLib.VariantType.new("(v)"),
            Gio.DBusCallFlags.NONE,
            5000,
            None,
        )
        return deep_unpack(result.unpack()[0])

    def _open_pipewire_remote(self):
        result, fd_list = self.bus.call_with_unix_fd_list_sync(
            SERVICE,
            OBJECT,
            SCREENCAST,
            "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (self.session_handle, {})),
            GLib.VariantType.new("(h)"),
            Gio.DBusCallFlags.NONE,
            15000,
            None,
            None,
        )
        if fd_list is None:
            raise PortalError("ScreenCast portal returned no PipeWire file descriptor")
        handle = int(result.unpack()[0])
        fd = fd_list.get(handle)
        if fd < 0:
            raise PortalError("ScreenCast portal returned an invalid PipeWire file descriptor")
        return fd

    def _start_pipeline(self):
        pipeline = Gst.Pipeline.new("pilink-wayland")
        source = Gst.ElementFactory.make("pipewiresrc", "source")
        convert = Gst.ElementFactory.make("videoconvert", "convert")
        encoder = Gst.ElementFactory.make("pngenc", "encoder")
        sink = Gst.ElementFactory.make("appsink", "sink")
        if not all((pipeline, source, convert, sink)):
            raise PortalError(
                "Required GStreamer elements are missing; install the PipeWire GStreamer plugin and standard base plugins"
            )
        source.set_property("fd", self.pipewire_fd)
        source.set_property("path", str(self.stream_node))
        if source.find_property("always-copy") is not None:
            source.set_property("always-copy", True)
        sink.set_property("emit-signals", False)
        sink.set_property("sync", False)
        sink.set_property("max-buffers", 1)
        if sink.find_property("drop") is not None:
            sink.set_property("drop", True)
        pipeline.add(source)
        pipeline.add(convert)
        if encoder is not None:
            self.use_raw_fallback = False
            pipeline.add(encoder)
            pipeline.add(sink)
            if not source.link(convert) or not convert.link(encoder) or not encoder.link(sink):
                raise PortalError("Could not build the PipeWire-to-PNG GStreamer pipeline")
        else:
            self.use_raw_fallback = True
            sink.set_property("caps", Gst.Caps.from_string("video/x-raw,format=RGBA"))
            pipeline.add(sink)
            if not source.link(convert) or not convert.link(sink):
                raise PortalError("Could not build the PipeWire raw video GStreamer pipeline")
        result = pipeline.set_state(Gst.State.PLAYING)
        if result == Gst.StateChangeReturn.FAILURE:
            pipeline.set_state(Gst.State.NULL)
            raise PortalError("GStreamer could not start the PipeWire desktop stream")
        state_result, _state, _pending = pipeline.get_state(5 * Gst.SECOND)
        if state_result == Gst.StateChangeReturn.FAILURE:
            pipeline.set_state(Gst.State.NULL)
            raise PortalError("GStreamer failed while starting the PipeWire desktop stream")
        self.pipeline = pipeline
        self.appsink = sink

    def _move_pixel(self, raw_x, raw_y):
        x = self._int(raw_x, 0, 32767, "x")
        y = self._int(raw_y, 0, 32767, "y")
        if self.frame_width is None or self.frame_height is None:
            self.capture_png()
        if x >= self.frame_width or y >= self.frame_height:
            raise PortalError(f"Desktop coordinates ({x}, {y}) are outside the {self.frame_width}x{self.frame_height} screenshot")
        logical_width, logical_height = self._logical_size()
        mapped_x = x * logical_width / self.frame_width
        mapped_y = y * logical_height / self.frame_height
        self._call(
            REMOTE,
            "NotifyPointerMotionAbsolute",
            "(oa{sv}udd)",
            (self.session_handle, {}, self.stream_node, float(mapped_x), float(mapped_y)),
        )

    def _logical_size(self):
        candidate = self.stream_props.get("logical_size") or self.stream_props.get("size")
        if isinstance(candidate, list) and len(candidate) == 2:
            width, height = int(candidate[0]), int(candidate[1])
            if width > 0 and height > 0:
                return width, height
        return self.frame_width, self.frame_height

    def _pointer_button(self, button, state):
        self._call(
            REMOTE,
            "NotifyPointerButton",
            "(oa{sv}iu)",
            (self.session_handle, {}, button, state),
        )

    def _keyboard(self, keysym, state):
        self._call(
            REMOTE,
            "NotifyKeyboardKeysym",
            "(oa{sv}iu)",
            (self.session_handle, {}, int(keysym), state),
        )

    def _tap_keysym(self, keysym):
        self._keyboard(keysym, 1)
        self._keyboard(keysym, 0)

    def _button(self, value):
        name = "left" if value is None else value
        if name not in BUTTONS:
            raise PortalError("Unsupported mouse button")
        return BUTTONS[name]

    def _named_keysym(self, value):
        if not isinstance(value, str) or not value.strip() or len(value) > 32:
            raise PortalError("Unsupported key name")
        token = value.strip().upper()
        if token in KEYSYMS:
            return KEYSYMS[token]
        if len(token) == 1 and token.isalnum():
            return ord(token.lower())
        if token.startswith("F") and token[1:].isdigit():
            number = int(token[1:])
            if 1 <= number <= 24:
                return 0xFFBE + number - 1
        raise PortalError(f"Unsupported key name '{value}'")

    def _text_keysym(self, char):
        if char == "\n" or char == "\r":
            return KEYSYMS["ENTER"]
        if char == "\t":
            return KEYSYMS["TAB"]
        if char == "\b":
            return KEYSYMS["BACKSPACE"]
        codepoint = ord(char)
        if codepoint <= 0xFF:
            return codepoint
        return 0x01000000 | codepoint

    def _call(self, interface, method, signature, values, object_path=OBJECT):
        self.bus.call_sync(
            SERVICE,
            object_path,
            interface,
            method,
            GLib.Variant(signature, tuple(values)),
            GLib.VariantType.new("()"),
            Gio.DBusCallFlags.NONE,
            15000,
            None,
        )

    def _int(self, value, minimum, maximum, label):
        if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
            raise PortalError(f"{label} must be an integer between {minimum} and {maximum}")
        return value

    def _token(self, prefix):
        self.counter += 1
        return f"pilink_{prefix}_{os.getpid()}_{self.counter}"


session = None
try:
    session = WaylandPortalSession()
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if not isinstance(request_id, int):
                raise PortalError("Request id is invalid")
            operation = request.get("op")
            if operation == "observe":
                data = session.capture_png()
                response = {
                    "id": request_id,
                    "ok": True,
                    "data": base64.b64encode(data).decode("ascii"),
                }
            elif operation == "action":
                action = request.get("input")
                if not isinstance(action, dict):
                    raise PortalError("Desktop action is invalid")
                session.perform(action)
                response = {"id": request_id, "ok": True}
            else:
                raise PortalError("Unsupported Wayland helper operation")
        except Exception as exc:
            response = {"id": request_id, "ok": False, "error": safe_error(exc)}
        print(json.dumps(response, separators=(",", ":")), flush=True)
finally:
    if session is not None:
        session.close()
