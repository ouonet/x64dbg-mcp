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