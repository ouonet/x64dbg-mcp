"""
Offline unit tests for x64dbg_mcp_bridge.py.

Run:  python plugin/tests/test_bridge.py
      pytest plugin/tests/test_bridge.py   (if pytest is installed)

No x64dbg required — all x64dbg SDK calls are stubbed out.
"""

import sys
import os
import threading
import types

# ── stub out x64dbg_bridge_sdk before importing the bridge ──────────────────

_fake_sdk = types.ModuleType("x64dbg_bridge_sdk")
_fake_sdk.INSIDE_X64DBG = False
_fake_sdk.DbgIsDebugging = lambda: False
_fake_sdk.DbgCmdExec = lambda cmd: True
_fake_sdk.DbgEval = lambda expr: 0
_fake_sdk.DbgGetModuleList = lambda: []
sys.modules["x64dbg_bridge_sdk"] = _fake_sdk

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Ensure plugin/ is on the path
sys.path.insert(0, PLUGIN_DIR)

import x64dbg_mcp_bridge as bridge  # noqa: E402

# ── helpers ──────────────────────────────────────────────────────────────────

_passed = 0
_failed = 0


def _ok(name):
    global _passed
    _passed += 1
    print(f"[OK]   {name}")


def _fail(name, detail=""):
    global _failed
    _failed += 1
    print(f"[FAIL] {name}" + (f": {detail}" if detail else ""))


# ── tests ────────────────────────────────────────────────────────────────────

def test_module_loads():
    assert bridge.INSIDE_X64DBG is False
    assert hasattr(bridge, "_dispatch_lock")
    assert isinstance(bridge._dispatch_lock, type(threading.Lock()))
    _ok("module loads: INSIDE_X64DBG=False, _dispatch_lock present")


def test_protection_str():
    cases = [
        (0x01, "---"), (0x02, "R"),   (0x04, "RW"),  (0x08, "WC"),
        (0x10, "X"),   (0x20, "XR"),  (0x40, "XRW"), (0x80, "XWC"),
        (0x20 | 0x100, "XR+G"),
        (0x40 | 0x200, "XRW+N"),
        (0x04 | 0x400, "RW+WC"),
        (0x99, "0x99"),
    ]
    for protect, expected in cases:
        result = bridge._protection_str(protect)
        assert result == expected, \
            f"protect=0x{protect:02X}: got {result!r}, want {expected!r}"
    _ok("_protection_str: 12 cases")


def test_address_normalization():
    def norm(a):
        try:
            return int(str(a), 16)
        except (ValueError, TypeError):
            return -1

    assert norm("0x00401000") == norm("401000") == 0x401000
    assert norm("garbage") == -1
    assert norm(None) == -1
    _ok("address normalization for run_to")


def test_dispatch_log_cap():
    import re
    src_path = os.path.join(PLUGIN_DIR, "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    assert "mcp_dispatch_trace" in src
    assert re.search(r"1[_,]?000[_,]?000", src)
    _ok("dispatch log 1 MB file-based cap present")


def test_findall_unquoted():
    # Historical regression: an earlier implementation routed memory.search
    # through the x64dbg `findall` command and at one point quoted the hex
    # pattern, breaking searches. The current implementation reads memory
    # directly via the SDK and does not call `findall` at all, so the only
    # remaining invariant is that quoted-findall syntax must not reappear.
    src_path = os.path.join(PLUGIN_DIR, "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    assert 'findall 0, "' not in src, "quoted findall pattern reintroduced"
    _ok("findall is not invoked with a quoted hex pattern")


def test_get_imports_address_empty_string():
    import re
    src_path = os.path.join(PLUGIN_DIR, "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_get_imports")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert '"address": None' not in body
    assert re.search(r'"address"\s*:\s*""', body)
    _ok("handle_get_imports uses empty string for address")


def test_callstack_truncates_before_loop():
    import re
    src_path = os.path.join(PLUGIN_DIR, "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_get_callstack")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert re.search(r"\[:max_frames\]", body)
    assert body.find("[:max_frames]") < body.find("for ")
    _ok("handle_get_callstack truncates before loop")


def test_debug_load_failure_check():
    src_path = os.path.join(PLUGIN_DIR, "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_debug_load")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert "DbgIsDebugging" in body
    assert "raise RuntimeError" in body
    _ok("handle_debug_load raises on InitDebug failure")


def test_debug_detach_uses_detach_command():
    original_inside = bridge.INSIDE_X64DBG
    original_is_debugging = bridge.sdk.DbgIsDebugging
    original_cmd_exec = bridge.sdk.DbgCmdExec
    original_loaded = bridge._loaded_exe_path
    commands = []

    try:
        bridge.INSIDE_X64DBG = True
        bridge._loaded_exe_path = "<attached-pid-1234>"
        bridge.sdk.DbgIsDebugging = lambda: False if commands else True
        bridge.sdk.DbgCmdExec = lambda cmd: commands.append(cmd) or True

        result = bridge.handle_debug_detach({})

        assert commands == ["DetachDebugger"]
        assert result == {"detached": True}
        assert bridge._loaded_exe_path is None
    finally:
        bridge.INSIDE_X64DBG = original_inside
        bridge.sdk.DbgIsDebugging = original_is_debugging
        bridge.sdk.DbgCmdExec = original_cmd_exec
        bridge._loaded_exe_path = original_loaded
    _ok("handle_debug_detach uses DetachDebugger and clears loaded executable state")


def test_debug_detach_accepts_pid_zero_half_state():
    original_inside = bridge.INSIDE_X64DBG
    original_is_debugging = bridge.sdk.DbgIsDebugging
    original_cmd_exec = bridge.sdk.DbgCmdExec
    original_eval_expr = bridge._eval_expr
    original_loaded = bridge._loaded_exe_path
    commands = []

    try:
        bridge.INSIDE_X64DBG = True
        bridge._loaded_exe_path = "C:/target.exe"
        bridge.sdk.DbgIsDebugging = lambda: True
        bridge.sdk.DbgCmdExec = lambda cmd: commands.append(cmd) or True
        bridge._eval_expr = lambda expr: 0

        result = bridge.handle_debug_detach({})

        assert commands == ["DetachDebugger"]
        assert result == {"detached": True, "note": "debugger reported pid=0 after detach"}
        assert bridge._loaded_exe_path is None
    finally:
        bridge.INSIDE_X64DBG = original_inside
        bridge.sdk.DbgIsDebugging = original_is_debugging
        bridge.sdk.DbgCmdExec = original_cmd_exec
        bridge._eval_expr = original_eval_expr
        bridge._loaded_exe_path = original_loaded
    _ok("handle_debug_detach accepts pid=0 half-debugging state as detached")


def test_debug_attach_uses_hex_pid_expression():
    original_inside = bridge.INSIDE_X64DBG
    original_is_debugging = bridge.sdk.DbgIsDebugging
    original_is_running = getattr(bridge.sdk, "DbgIsRunning", None)
    original_cmd_exec = bridge.sdk.DbgCmdExec
    original_eval_expr = bridge._eval_expr
    original_get_ptr_size = getattr(bridge.sdk, "get_ptr_size", None)
    original_loaded = bridge._loaded_exe_path
    commands = []

    try:
        bridge.INSIDE_X64DBG = True
        bridge._loaded_exe_path = None

        def fake_is_debugging():
            return bool(commands)

        def fake_cmd_exec(cmd):
            commands.append(cmd)
            return True

        def fake_eval_expr(expr):
            if expr == "$pid":
                return 0x1234 if commands else 0
            if expr == "cip":
                return 0x401000
            return 0

        bridge.sdk.DbgIsDebugging = fake_is_debugging
        bridge.sdk.DbgIsRunning = lambda: False
        bridge.sdk.DbgCmdExec = fake_cmd_exec
        bridge._eval_expr = fake_eval_expr
        bridge.sdk.get_ptr_size = lambda: 8

        result = bridge.handle_debug_attach({"pid": 0x1234, "breakOnEntry": False, "autoAnalyze": False})

        assert commands[0] == "AttachDebugger 0x0000000000001234"
        assert result["pid"] == 0x1234
        assert result["architecture"] == "x64"
    finally:
        bridge.INSIDE_X64DBG = original_inside
        bridge.sdk.DbgIsDebugging = original_is_debugging
        if original_is_running is None:
            delattr(bridge.sdk, "DbgIsRunning")
        else:
            bridge.sdk.DbgIsRunning = original_is_running
        bridge.sdk.DbgCmdExec = original_cmd_exec
        bridge._eval_expr = original_eval_expr
        if original_get_ptr_size is None:
            delattr(bridge.sdk, "get_ptr_size")
        else:
            bridge.sdk.get_ptr_size = original_get_ptr_size
        bridge._loaded_exe_path = original_loaded
    _ok("handle_debug_attach formats PID as explicit hex for AttachDebugger")


def test_remove_breakpoint_command_selection():
    assert bridge._remove_breakpoint_commands("0x401000", None) == [
        "bc 0x401000",
        "bphc 0x401000",
        "bpmc 0x401000",
    ]
    assert bridge._remove_breakpoint_commands("0x401000", 1) == ["bc 0x401000"]
    assert bridge._remove_breakpoint_commands("0x401000", 2) == ["bphc 0x401000"]
    assert bridge._remove_breakpoint_commands("0x401000", 4) == ["bpmc 0x401000"]
    _ok("remove_breakpoint selects clear command by breakpoint type")


def test_set_breakpoint_command_selection():
    assert bridge._set_breakpoint_command("0x401000", "software") == "bp 0x401000"
    assert bridge._set_breakpoint_command("0x401000", "hardware_execute") == "bph 0x401000, x"
    assert bridge._set_breakpoint_command("0x401000", "memory_read") == "bpmrange 0x401000, 1, r"
    assert bridge._set_breakpoint_command("0x401000", "memory_write") == "bpm 0x401000, 0, w"
    assert bridge._set_breakpoint_command("0x401000", "memory_access") == "bpmrange 0x401000, 1, a"
    _ok("set_breakpoint selects command by breakpoint type")


def test_infer_stop_reason_detects_memory_breakpoint_by_snapshot_change():
    original_is_debugging = bridge.sdk.DbgIsDebugging
    original_get_breakpoint_list = getattr(bridge.sdk, "get_breakpoint_list", None)
    try:
        bridge.sdk.DbgIsDebugging = lambda: True
        bridge.sdk.get_breakpoint_list = lambda: []
        before = [{"address": 0x93B000, "type": 4, "enabled": True, "hitCount": 0}]
        after = []
        assert bridge._infer_stop_reason(0x774D8332, before, after) == "breakpoint"
    finally:
        bridge.sdk.DbgIsDebugging = original_is_debugging
        if original_get_breakpoint_list is None:
            delattr(bridge.sdk, "get_breakpoint_list")
        else:
            bridge.sdk.get_breakpoint_list = original_get_breakpoint_list
    _ok("infer_stop_reason treats changed memory breakpoint state as breakpoint hit")


def test_tls_uses_section_lookup():
    src_path = os.path.join(PLUGIN_DIR, "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_detect_anti_debug")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert "mod.main() + pe.tls.va" not in body
    assert "tls" in body.lower()
    _ok("handle_detect_anti_debug uses section-based TLS lookup")


def test_t2_callback_constants_match_x64dbg_enum():
    """D3 — x64dbg CBTYPE enum values must match exactly."""
    assert bridge.CB_INITDEBUG == 1
    assert bridge.CB_STOPDEBUG == 2
    assert bridge.CB_CREATEPROCESS == 3
    assert bridge.CB_EXITPROCESS == 4
    assert bridge.CB_CREATETHREAD == 5
    assert bridge.CB_EXITTHREAD == 6
    assert bridge.CB_SYSTEMBREAKPOINT == 7
    assert bridge.CB_LOADDLL == 8
    assert bridge.CB_UNLOADDLL == 9
    assert bridge.CB_OUTPUTDEBUGSTRING == 10
    assert bridge.CB_EXCEPTION == 11
    assert bridge.CB_BREAKPOINT == 12
    assert bridge.CB_PAUSEDEBUG == 13
    assert bridge.CB_RESUMEDEBUG == 14
    assert bridge.CB_STEPPED == 15
    _ok("T2: CB_* constants match x64dbg CBTYPE enum")


def test_t2_emit_debug_event_breakpoint():
    """T2 — CB_BREAKPOINT produces a DebugEvent with kind=breakpoint."""
    bridge._session_events.clear()
    ev = bridge._emit_debug_event("sess-1", bridge.CB_BREAKPOINT, {
        "address": "0x401000",
        "threadId": 100,
        "pausedExecution": True,
        "details": {"bpType": "sw", "bpKind": "user", "bpAddress": "0x401000"},
    })
    assert ev["kind"] == "breakpoint", f"expected breakpoint, got {ev['kind']}"
    assert ev["pausedExecution"] is True
    assert ev["address"] == "0x401000"
    assert ev["threadId"] == 100
    assert ev["details"]["bpType"] == "sw"
    assert "sess-1" in bridge._session_events
    assert len(bridge._session_events["sess-1"]) == 1
    _ok("T2: CB_BREAKPOINT → DebugEvent(kind=breakpoint)")


def test_t2_emit_debug_event_all_user_visible_kinds():
    """T2 — every D3 DebugEventKind has a CB_* mapping."""
    bridge._session_events.clear()
    sid = "sess-2"
    cases = [
        (bridge.CB_BREAKPOINT, "breakpoint"),
        (bridge.CB_STEPPED, "step"),
        (bridge.CB_EXCEPTION, "exception"),
        (bridge.CB_LOADDLL, "dll_load"),
        (bridge.CB_UNLOADDLL, "dll_unload"),
        (bridge.CB_CREATETHREAD, "thread_create"),
        (bridge.CB_EXITTHREAD, "thread_exit"),
        (bridge.CB_CREATEPROCESS, "process_create"),
        (bridge.CB_EXITPROCESS, "process_exit"),
        (bridge.CB_SYSTEMBREAKPOINT, "system_breakpoint"),
        (bridge.CB_OUTPUTDEBUGSTRING, "output_debug_string"),
    ]
    for cb_type, expected_kind in cases:
        ev = bridge._emit_debug_event(sid, cb_type, {})
        assert ev is not None, f"CB type {cb_type} → no event"
        assert ev["kind"] == expected_kind, f"CB {cb_type}: got {ev['kind']}, want {expected_kind}"
    # tls_callback / manual_pause / trace_terminated / detached are synthetic
    # in T3+; they aren't emitted by raw CB_*.
    assert len(bridge._session_events[sid]) == len(cases)
    _ok("T2: all CB_* kinds map to correct DebugEventKind")


def test_t2_emit_debug_event_state_callbacks_emit_nothing():
    """T2 — internal state-machine CB types do not produce DebugEvents."""
    bridge._session_events.clear()
    for cb_type in (
        bridge.CB_INITDEBUG, bridge.CB_STOPDEBUG,
        bridge.CB_PAUSEDEBUG, bridge.CB_RESUMEDEBUG,
    ):
        ev = bridge._emit_debug_event("sess-3", cb_type, {})
        assert ev is None, f"CB {cb_type} should not produce a DebugEvent"
    assert "sess-3" not in bridge._session_events or bridge._session_events.get("sess-3", []) == []
    _ok("T2: CB_INITDEBUG/STOPDEBUG/PAUSEDEBUG/RESUMEDEBUG produce no events")


def test_t2_emit_debug_event_default_fields():
    """T2 — DebugEvent has all required D3 fields with sensible defaults."""
    bridge._session_events.clear()
    ev = bridge._emit_debug_event("sess-4", bridge.CB_LOADDLL, {})
    assert ev["kind"] == "dll_load"
    assert isinstance(ev["timestamp"], int)
    assert ev["timestamp"] > 0
    assert ev["address"] is None
    assert ev["threadId"] is None
    assert ev["pausedExecution"] is False
    assert isinstance(ev["details"], dict)
    _ok("T2: DebugEvent has all required fields with sensible defaults")


def test_t2_per_session_event_isolation():
    """T2 — events are appended only to the named session."""
    bridge._session_events.clear()
    bridge._emit_debug_event("alpha", bridge.CB_BREAKPOINT, {})
    bridge._emit_debug_event("beta", bridge.CB_LOADDLL, {})
    bridge._emit_debug_event("alpha", bridge.CB_STEPPED, {})
    assert len(bridge._session_events["alpha"]) == 2
    assert len(bridge._session_events["beta"]) == 1
    assert bridge._session_events["alpha"][0]["kind"] == "breakpoint"
    assert bridge._session_events["alpha"][1]["kind"] == "step"
    assert bridge._session_events["beta"][0]["kind"] == "dll_load"
    _ok("T2: per-session event log is isolated")


def test_t3_state_machine_initial_state():
    """T3 — a fresh session starts at state="loading", reasons null."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    st = bridge._get_session_state("sess-A")
    assert st["state"] == "loading"
    assert st["pauseReason"] is None
    assert st["terminationReason"] is None
    assert st["lastEvent"] is None
    assert st["recentEvents"] == []
    _ok("T3: session initial state is loading + null reasons")


def test_t3_state_machine_initdebug_to_system_breakpoint():
    """T3 — InitDebug then SystemBreakpoint transitions loading→paused."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    bridge._handle_callback("sess-B", bridge.CB_INITDEBUG, {})
    st = bridge._get_session_state("sess-B")
    assert st["state"] == "loading"
    bridge._handle_callback("sess-B", bridge.CB_SYSTEMBREAKPOINT, {
        "address": "0x77000000", "threadId": 100,
    })
    st = bridge._get_session_state("sess-B")
    assert st["state"] == "paused", f"got {st['state']}"
    assert st["pauseReason"] == "system_breakpoint"
    assert st["terminationReason"] is None
    assert st["lastEvent"]["kind"] == "system_breakpoint"
    _ok("T3: InitDebug + SystemBreakpoint → state=paused, pauseReason=system_breakpoint")


def test_t3_state_machine_pause_resume_cycle():
    """T3 — RESUMEDEBUG → running, BREAKPOINT → paused, repeat."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-C"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    st = bridge._get_session_state(sid)
    assert st["state"] == "running"
    assert st["pauseReason"] is None, "pauseReason must clear on resume"

    bridge._handle_callback(sid, bridge.CB_BREAKPOINT, {
        "address": "0x401000", "threadId": 100, "pausedExecution": True,
    })
    st = bridge._get_session_state(sid)
    assert st["state"] == "paused"
    assert st["pauseReason"] == "breakpoint"
    _ok("T3: pause/resume cycle drives state correctly")


def test_t3_state_machine_terminates_on_exitprocess():
    """T3 — CB_EXITPROCESS → state=terminated, terminationReason=process_exit."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-D"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_EXITPROCESS, {
        "details": {"exitCode": 0},
    })
    st = bridge._get_session_state(sid)
    assert st["state"] == "terminated"
    assert st["terminationReason"] == "process_exit"
    assert st["pauseReason"] is None
    _ok("T3: CB_EXITPROCESS → terminated/process_exit")


def test_t3_dll_load_break_pause_reason():
    """T3 — pausing DLL load uses pauseReason='dll_load_break'."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-E"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_LOADDLL, {
        "pausedExecution": True,
        "details": {"moduleName": "ntdll.dll"},
    })
    st = bridge._get_session_state(sid)
    assert st["state"] == "paused"
    assert st["pauseReason"] == "dll_load_break", f"got {st['pauseReason']}"
    _ok("T3: pausing dll_load → pauseReason='dll_load_break'")


def test_t3_non_pausing_event_keeps_state():
    """T3 — non-pausing dll_load updates lastEvent but not state or pauseReason."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-F"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    # observe DLL load without pausing
    bridge._handle_callback(sid, bridge.CB_LOADDLL, {
        "pausedExecution": False,
        "details": {"moduleName": "kernel32.dll"},
    })
    st = bridge._get_session_state(sid)
    assert st["state"] == "running", f"state should stay running, got {st['state']}"
    assert st["pauseReason"] is None
    assert st["lastEvent"]["kind"] == "dll_load"
    _ok("T3: non-pausing dll_load keeps state=running, updates lastEvent")


def test_t3_recent_events_ring_buffer_caps_at_50():
    """T3 — recentEvents holds at most 50 entries, oldest dropped (D4)."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-G"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    # 60 dll_load events (non-pausing)
    for i in range(60):
        bridge._handle_callback(sid, bridge.CB_LOADDLL, {
            "details": {"moduleName": f"mod{i}.dll"},
        })
    st = bridge._get_session_state(sid)
    assert len(st["recentEvents"]) == 50, f"expected 50, got {len(st['recentEvents'])}"
    # oldest dropped: first remaining event should be mod10
    assert st["recentEvents"][0]["details"]["moduleName"] == "mod10.dll"
    assert st["recentEvents"][-1]["details"]["moduleName"] == "mod59.dll"
    _ok("T3: recentEvents ring buffer caps at 50, oldest dropped")


def test_t3_state_get_handler_returns_snapshot():
    """T3 — handle_state_get returns full snapshot per D2."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-H"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {
        "address": "0x77000000", "threadId": 100,
    })
    resp = bridge.handle_state_get({"sessionId": sid})
    assert resp["state"] == "paused"
    assert resp["pauseReason"] == "system_breakpoint"
    assert resp["terminationReason"] is None
    assert resp["lastEvent"]["kind"] == "system_breakpoint"
    assert "recentEvents" in resp
    assert isinstance(resp["recentEvents"], list)
    _ok("T3: handle_state_get returns D2 snapshot")


def test_t4_exception_bp_coalesces_into_single_breakpoint_event():
    """T4 rule 7 — CB_EXCEPTION followed by CB_BREAKPOINT(bpType=exception)
    at the same address emits exactly ONE breakpoint event (the exception
    event is suppressed / replaced)."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-x1"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    # x64dbg fires CB_EXCEPTION then CB_BREAKPOINT for an exception BP
    bridge._handle_callback(sid, bridge.CB_EXCEPTION, {
        "address": "0x402000", "threadId": 100,
        "details": {"exceptionCode": "0xC0000005", "exceptionName": "ACCESS_VIOLATION"},
    })
    bridge._handle_callback(sid, bridge.CB_BREAKPOINT, {
        "address": "0x402000", "threadId": 100,
        "details": {"bpType": "exception", "bpKind": "user",
                    "exceptionCode": "0xC0000005",
                    "exceptionName": "ACCESS_VIOLATION"},
    })
    st = bridge._get_session_state(sid)
    # Coalesced: exactly one event for this trapping point
    bp_or_exc = [e for e in st["recentEvents"]
                 if e["kind"] in ("breakpoint", "exception")
                 and e["address"] == "0x402000"]
    assert len(bp_or_exc) == 1, f"expected 1 coalesced event, got {len(bp_or_exc)}"
    assert bp_or_exc[0]["kind"] == "breakpoint"
    assert bp_or_exc[0]["details"]["bpType"] == "exception"
    # exception context preserved
    assert bp_or_exc[0]["details"]["exceptionName"] == "ACCESS_VIOLATION"
    _ok("T4 rule 7: exception BP coalesces exception+breakpoint events")


def test_t4_dll_bp_coalesces_into_single_breakpoint_event():
    """T4 rule 8 — CB_LOADDLL followed by CB_BREAKPOINT(bpType=dll) for the
    same module emits exactly ONE breakpoint event."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-x2"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_LOADDLL, {
        "details": {"moduleName": "user32.dll", "moduleBase": "0x70000000"},
    })
    bridge._handle_callback(sid, bridge.CB_BREAKPOINT, {
        "address": "0x70001000",
        "details": {"bpType": "dll", "bpKind": "user",
                    "moduleName": "user32.dll"},
    })
    st = bridge._get_session_state(sid)
    matched = [e for e in st["recentEvents"]
               if (e["kind"] == "breakpoint" and e["details"].get("bpType") == "dll")
               or (e["kind"] == "dll_load" and e["details"].get("moduleName") == "user32.dll")]
    assert len(matched) == 1, f"expected 1 coalesced event, got {len(matched)}"
    assert matched[0]["kind"] == "breakpoint"
    assert matched[0]["details"]["bpType"] == "dll"
    _ok("T4 rule 8: DLL BP coalesces dll_load+breakpoint events")


def test_t4_unmatched_dll_load_still_emits_event():
    """T4 — DLL loads without a matching bpdll fire normal dll_load events."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-x3"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_LOADDLL, {
        "details": {"moduleName": "kernel32.dll"},
    })
    st = bridge._get_session_state(sid)
    dll_events = [e for e in st["recentEvents"] if e["kind"] == "dll_load"]
    assert len(dll_events) == 1
    _ok("T4: unmatched DLL load still emits dll_load event")


def test_t4_hardcoded_int3_remains_as_exception():
    """T4 rule 1 — CB_EXCEPTION(EXCEPTION_BREAKPOINT) with no matching BP
    coalesce target stays as an `exception` event."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-x4"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_EXCEPTION, {
        "address": "0x401234",
        "details": {"exceptionCode": "0x80000003",
                    "exceptionName": "EXCEPTION_BREAKPOINT"},
    })
    # No CB_BREAKPOINT follows — it's a hardcoded int 3.
    st = bridge._get_session_state(sid)
    exc_events = [e for e in st["recentEvents"] if e["kind"] == "exception"]
    assert len(exc_events) == 1
    assert exc_events[0]["details"]["exceptionName"] == "EXCEPTION_BREAKPOINT"
    assert st["state"] == "paused"
    assert st["pauseReason"] == "exception"
    _ok("T4 rule 1: hardcoded int 3 stays as exception, not breakpoint")


def test_t4_bpkind_temporary_for_temp_breakpoint():
    """T4 rule 4 — CB_BREAKPOINT with bpName starting `$temp_` reports bpKind=temporary."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-x5"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_BREAKPOINT, {
        "address": "0x401000",
        "details": {"bpType": "sw", "bpName": "$temp_run_to_address"},
    })
    st = bridge._get_session_state(sid)
    bp = st["lastEvent"]
    assert bp["kind"] == "breakpoint"
    assert bp["details"]["bpKind"] == "temporary"
    _ok("T4 rule 4: $temp_* BP name → bpKind=temporary")


def test_t4_bpkind_user_when_payload_specifies():
    """T4 — explicit bpKind=user in payload is preserved."""
    bridge._session_states.clear()
    bridge._session_events.clear()
    sid = "sess-x6"
    bridge._handle_callback(sid, bridge.CB_INITDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_SYSTEMBREAKPOINT, {})
    bridge._handle_callback(sid, bridge.CB_RESUMEDEBUG, {})
    bridge._handle_callback(sid, bridge.CB_BREAKPOINT, {
        "address": "0x401000",
        "details": {"bpType": "sw", "bpKind": "user", "bpName": "myBP"},
    })
    st = bridge._get_session_state(sid)
    assert st["lastEvent"]["details"]["bpKind"] == "user"
    _ok("T4: explicit bpKind=user preserved")


def test_dispatch_lock_mutual_exclusion():
    import time
    lock = bridge._dispatch_lock
    results = []

    def worker(n):
        with lock:
            results.append(f"start-{n}")
            time.sleep(0.01)
            results.append(f"end-{n}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    for i in range(0, len(results), 2):
        n = results[i].split("-")[1]
        assert results[i + 1] == f"end-{n}", f"lock interleaved: {results}"
    _ok("_dispatch_lock provides mutual exclusion")


# ── runner (also pytest-compatible) ─────────────────────────────────────────

_tests = [
    test_module_loads,
    test_protection_str,
    test_address_normalization,
    test_dispatch_log_cap,
    test_findall_unquoted,
    test_get_imports_address_empty_string,
    test_callstack_truncates_before_loop,
    test_debug_load_failure_check,
    test_debug_detach_uses_detach_command,
    test_debug_detach_accepts_pid_zero_half_state,
    test_debug_attach_uses_hex_pid_expression,
    test_remove_breakpoint_command_selection,
    test_set_breakpoint_command_selection,
    test_infer_stop_reason_detects_memory_breakpoint_by_snapshot_change,
    test_tls_uses_section_lookup,
    test_t2_callback_constants_match_x64dbg_enum,
    test_t2_emit_debug_event_breakpoint,
    test_t2_emit_debug_event_all_user_visible_kinds,
    test_t2_emit_debug_event_state_callbacks_emit_nothing,
    test_t2_emit_debug_event_default_fields,
    test_t2_per_session_event_isolation,
    test_t3_state_machine_initial_state,
    test_t3_state_machine_initdebug_to_system_breakpoint,
    test_t3_state_machine_pause_resume_cycle,
    test_t3_state_machine_terminates_on_exitprocess,
    test_t3_dll_load_break_pause_reason,
    test_t3_non_pausing_event_keeps_state,
    test_t3_recent_events_ring_buffer_caps_at_50,
    test_t3_state_get_handler_returns_snapshot,
    test_t4_exception_bp_coalesces_into_single_breakpoint_event,
    test_t4_dll_bp_coalesces_into_single_breakpoint_event,
    test_t4_unmatched_dll_load_still_emits_event,
    test_t4_hardcoded_int3_remains_as_exception,
    test_t4_bpkind_temporary_for_temp_breakpoint,
    test_t4_bpkind_user_when_payload_specifies,
    test_dispatch_lock_mutual_exclusion,
]

if __name__ == "__main__":
    print(f"\nx64dbg_mcp_bridge offline tests\n{'-' * 40}")
    for fn in _tests:
        try:
            fn()
        except Exception as exc:
            _fail(fn.__name__, str(exc))
    print(f"\n{'-' * 40}")
    print(f"Results: {_passed} passed, {_failed} failed")
    sys.exit(0 if _failed == 0 else 1)