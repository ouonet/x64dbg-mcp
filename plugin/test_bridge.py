"""
Offline unit tests for x64dbg_mcp_bridge.py.

Run:  python plugin/test_bridge.py
      pytest plugin/test_bridge.py   (if pytest is installed)

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

# Ensure plugin/ is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    assert "mcp_dispatch_trace" in src
    assert re.search(r"1[_,]?000[_,]?000", src)
    _ok("dispatch log 1 MB file-based cap present")


def test_findall_unquoted():
    import re
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    assert re.search(r'findall 0, "', src) is None
    assert re.search(r"findall 0, \{hex_pattern\}", src)
    _ok("findall uses unquoted hex pattern")


def test_get_imports_address_empty_string():
    import re
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_get_imports")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert '"address": None' not in body
    assert re.search(r'"address"\s*:\s*""', body)
    _ok("handle_get_imports uses empty string for address")


def test_callstack_truncates_before_loop():
    import re
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_get_callstack")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert re.search(r"\[:max_frames\]", body)
    assert body.find("[:max_frames]") < body.find("for ")
    _ok("handle_get_callstack truncates before loop")


def test_debug_load_failure_check():
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "x64dbg_mcp_bridge.py")
    src = open(src_path, encoding="utf-8").read()
    func_start = src.find("def handle_debug_load")
    func_end = src.find("\ndef ", func_start + 1)
    body = src[func_start:func_end]
    assert "DbgIsDebugging" in body
    assert "raise RuntimeError" in body
    _ok("handle_debug_load raises on InitDebug failure")


def test_tls_uses_section_lookup():
    src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "x64dbg_mcp_bridge.py")
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
    test_tls_uses_section_lookup,
    test_dispatch_lock_mutual_exclusion,
]

if __name__ == "__main__":
    print(f"\nx64dbg_mcp_bridge offline tests\n{'─' * 40}")
    for fn in _tests:
        try:
            fn()
        except Exception as exc:
            _fail(fn.__name__, str(exc))
    print(f"\n{'─' * 40}")
    print(f"Results: {_passed} passed, {_failed} failed")
    sys.exit(0 if _failed == 0 else 1)
