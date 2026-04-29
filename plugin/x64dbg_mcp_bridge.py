"""
x64dbg MCP Bridge Plugin
=========================
Runs inside x64dbg via the Python 3 loader plugin (x64dbg_mcp_loader).
Uses ctypes to call x64bridge.dll directly — **no x64dbgpy dependency**.
Requires Python 3.10+.

Protocol: newline-delimited JSON over TCP.
  Request  → { "id": "<uuid>", "method": "<namespace.action>", "params": { … } }
  Response ← { "id": "<uuid>", "success": true/false, "data": …, "error": "…" }

Install
-------
1. Build and install x64dbg_mcp_loader.dp32 / .dp64 into x64dbg plugins/.
2. Place this file and x64dbg_bridge_sdk.py in the same directory or
   in x64dbg's plugins/ directory.
3. The loader auto-starts the bridge on plugin init.
"""

from __future__ import annotations

import contextlib
import hmac
import json
import math
import os
import socket
import sys
import threading
import traceback
from typing import Any, Callable, Dict, Optional

# ---------------------------------------------------------------------------
# Import the ctypes-based bridge SDK (Python 3, no x64dbgpy)
# ---------------------------------------------------------------------------
# Ensure the plugin directory is on sys.path so we can find the SDK module
_plugin_dir = os.path.dirname(os.path.abspath(__file__))
if _plugin_dir not in sys.path:
    sys.path.insert(0, _plugin_dir)

try:
    import x64dbg_bridge_sdk as sdk
    from ctypes import byref, c_bool, POINTER
except Exception:
    sdk = None  # type: ignore[assignment]

def _detect_x64dbg() -> bool:
    """Check if x64bridge.dll / x32bridge.dll is loaded in this process.
    Safe to call from any thread — only uses GetModuleHandleW, no DLL functions."""
    try:
        import ctypes as _ct
        _dll = "x64bridge.dll" if sys.maxsize > 2**32 else "x32bridge.dll"
        return bool(_ct.windll.kernel32.GetModuleHandleW(_dll))
    except Exception:
        return False

INSIDE_X64DBG = _detect_x64dbg()
# Lock protecting the lazy re-probe of INSIDE_X64DBG from concurrent threads
_x64dbg_probe_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BRIDGE_HOST = os.environ.get("BRIDGE_HOST", "127.0.0.1")
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "27042"))
BUFFER_SIZE = 65536
BRIDGE_AUTH_TOKEN_FILE = "x64dbg_mcp_bridge.token"


def _normalize_bridge_token(token: str) -> str:
    return token.lstrip("\ufeff").strip()


def _load_bridge_auth_token() -> str:
    token = _normalize_bridge_token(os.environ.get("BRIDGE_AUTH_TOKEN", ""))
    if token:
        return token

    token_path = os.path.join(_plugin_dir, BRIDGE_AUTH_TOKEN_FILE)
    if not os.path.exists(token_path):
        return ""

    try:
        with open(token_path, "r", encoding="utf-8") as fh:
            return _normalize_bridge_token(fh.read())
    except OSError:
        return ""


BRIDGE_AUTH_TOKEN = _load_bridge_auth_token()

# Track the last loaded executable path so handlers can resolve PE files from disk
_loaded_exe_path: Optional[str] = None
_BRIDGE_LOG_FILE = os.path.join(_plugin_dir, "mcp_bridge_runtime.log")

# ---------------------------------------------------------------------------
# Logging helper (writes to x64dbg log pane when available)
# ---------------------------------------------------------------------------

def _write_bridge_log_line(text: str) -> None:
    try:
        with open(_BRIDGE_LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")
    except OSError:
        pass

def log_info(msg: str) -> None:
    text = f"[MCP Bridge] {msg}"
    # Avoid DbgCmdExecDirect-based logging from Python worker threads.
    # On x32dbg this can destabilize the bridge before requests are handled.
    print(text, file=sys.stderr, flush=True)
    _write_bridge_log_line(text)


def log_error(msg: str) -> None:
    text = f"[MCP Bridge ERROR] {msg}"
    print(text, file=sys.stderr, flush=True)
    _write_bridge_log_line(text)

# ---------------------------------------------------------------------------
# Handler registry
# ---------------------------------------------------------------------------

_handlers: Dict[str, Callable[..., Any]] = {}

# Serialize all handler dispatches — x64dbg commands are not thread-safe.
# Multiple MCP clients connecting simultaneously would otherwise interleave
# commands and corrupt register/state reads between step/continue calls.
_dispatch_lock = threading.Lock()

# Handlers that only read stable state and do not issue x64dbg commands.
# They are dispatched without _dispatch_lock so status queries stay
# responsive while a long-running operation (trace, continue) holds the lock.
_LOCKLESS_HANDLERS: frozenset[str] = frozenset({
    "debug.listBreakpoints",  # read-only BridgeList query
    "analysis.getModules",    # module list query only
})


def handler(method: str):
    """Decorator to register a bridge request handler."""
    def decorator(fn: Callable[..., Any]):
        _handlers[method] = fn
        return fn
    return decorator

# ---------------------------------------------------------------------------
# x64dbg wrapper helpers (now delegating to ctypes SDK)
# ---------------------------------------------------------------------------

def _require_x64dbg():
    global INSIDE_X64DBG
    if not INSIDE_X64DBG:
        with _x64dbg_probe_lock:
            # Double-checked: re-test inside the lock to avoid redundant probes
            if not INSIDE_X64DBG:
                INSIDE_X64DBG = _detect_x64dbg()
    if not INSIDE_X64DBG:
        raise RuntimeError("This handler requires a running x64dbg instance")


def _cmd(command: str) -> bool:
    """Execute an x64dbg command synchronously."""
    _require_x64dbg()
    return sdk.cmd(command)


def _eval_expr(expr: str) -> int:
    """Evaluate an x64dbg expression and return the integer result."""
    _require_x64dbg()
    return sdk.eval_expr(expr)


def _read_mem(address: int, size: int) -> bytes:
    _require_x64dbg()
    return sdk.read_memory(address, size)


def _write_mem(address: int, data: bytes) -> int:
    _require_x64dbg()
    return sdk.write_memory(address, data)


def _hex(value: int, width: int = 16) -> str:
    return f"0x{value:0{width}X}"


def _hexdump(data: bytes, base_address: int, bytes_per_line: int = 16) -> str:
    lines: list[str] = []
    for offset in range(0, len(data), bytes_per_line):
        chunk = data[offset : offset + bytes_per_line]
        hex_part = " ".join(f"{b:02X}" for b in chunk)
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        addr = _hex(base_address + offset)
        lines.append(f"{addr}  {hex_part:<{bytes_per_line * 3}}  {ascii_part}")
    return "\n".join(lines)

# ---------------------------------------------------------------------------
# Shannon entropy helper
# ---------------------------------------------------------------------------

def _entropy(data: bytes) -> float:
    if not data:
        return 0.0
    freq: Dict[int, int] = {}
    for b in data:
        freq[b] = freq.get(b, 0) + 1
    length = len(data)
    ent = 0.0
    for count in freq.values():
        p = count / length
        if p > 0:
            ent -= p * math.log2(p)
    return round(ent, 4)


_FALLBACK_FUNCTION_CACHE: dict[tuple[int, int, int], list[dict[str, Any]]] = {}


def _find_module_info(mod: Optional[str] = None, addr: Optional[int] = None) -> Optional[dict]:
    modules = sdk.get_module_list()
    if addr is not None:
        for module in modules:
            base = int(module["base"])
            size = int(module["size"])
            if base <= addr < (base + size):
                return module
        return None

    if mod:
        mod_lower = mod.lower()
        for module in modules:
            name = module.get("name", "")
            path = module.get("path", "")
            base_name = os.path.basename(path or name).lower()
            module_name = name.lower()
            if module_name == mod_lower or base_name == mod_lower or module_name.split(".")[0] == mod_lower.split(".")[0]:
                return module
        return None

    for module in modules:
        path = module.get("path", "")
        if path.lower().endswith(".exe"):
            return module

    return modules[0] if modules else None


def _direct_target_from_operands(operands: str) -> Optional[int]:
    text = operands.strip()
    if not text:
        return None

    lowered = text.lower()
    if "[" in text or "ptr" in lowered or "," in text:
        return None

    if lowered in {
        "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "rip",
        "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
        "eax", "ebx", "ecx", "edx", "esi", "edi", "ebp", "esp", "eip",
    }:
        return None

    if lowered.startswith("0x"):
        with contextlib.suppress(ValueError):
            return int(lowered, 16)

    if lowered.endswith("h"):
        hex_part = lowered[:-1]
        if hex_part and all(ch in "0123456789abcdef" for ch in hex_part):
            with contextlib.suppress(ValueError):
                return int(hex_part, 16)

    with contextlib.suppress(Exception):
        return _eval_expr(text)
    return None


def _analyze_linear_function(start: int, module: dict, max_instructions: int = 4096) -> Optional[dict]:
    base = int(module["base"])
    module_end = base + int(module["size"])
    if not (base <= start < module_end):
        return None

    cur = start
    inst_count = 0
    callees: list[int] = []
    edges: list[dict[str, Any]] = []
    tail_target: Optional[int] = None

    while base <= cur < module_end and inst_count < max_instructions:
        info = sdk.DbgDisasmAt(cur)
        mnemonic = (info.get("mnemonic") or "").lower()
        operands = info.get("operands") or ""
        size = int(info.get("size") or 0) or 1
        if not mnemonic:
            break
        if mnemonic == "int3" and inst_count > 0:
            break

        inst_addr = cur
        inst_count += 1
        cur += size

        if mnemonic.startswith("call") or mnemonic.startswith("j"):
            target = _direct_target_from_operands(operands)
            if target is not None:
                edge_type = "call" if mnemonic.startswith("call") else "jump"
                edges.append({"from": inst_addr, "to": target, "type": edge_type})
                if edge_type == "call":
                    callees.append(target)
                elif mnemonic == "jmp":
                    tail_target = target

        if mnemonic.startswith("ret") or mnemonic in {"iret", "sysret", "syscall"}:
            break
        if mnemonic == "jmp":
            break

    if inst_count == 0 or cur <= start:
        return None

    return {
        "start": start,
        "end": cur,
        "name": sdk.get_label_at(start) or _hex(start),
        "module": module.get("name", ""),
        "instructionCount": inst_count,
        "callees": callees,
        "edges": edges,
        "tailTarget": tail_target,
    }


def _get_fallback_functions(module: dict, max_functions: int = 1024) -> list[dict[str, Any]]:
    key = (int(module["base"]), int(module["size"]), int(module.get("entry", 0) or 0))
    cached = _FALLBACK_FUNCTION_CACHE.get(key)
    if cached is not None:
        return cached

    base = int(module["base"])
    module_end = base + int(module["size"])
    entry = int(module.get("entry", 0) or 0)
    queue: list[int] = []
    queued: set[int] = set()
    seen: set[int] = set()
    functions: list[dict[str, Any]] = []

    if base <= entry < module_end:
        queue.append(entry)
        queued.add(entry)

    while queue and len(functions) < max_functions:
        start = queue.pop(0)
        if start in seen:
            continue
        seen.add(start)

        func = _analyze_linear_function(start, module)
        if func is None:
            continue

        functions.append(func)

        for target in func["callees"]:
            if base <= target < module_end and target not in seen and target not in queued:
                queue.append(target)
                queued.add(target)

        tail_target = func.get("tailTarget")
        if isinstance(tail_target, int) and base <= tail_target < module_end and tail_target not in seen and tail_target not in queued:
            queue.append(tail_target)
            queued.add(tail_target)

    _FALLBACK_FUNCTION_CACHE[key] = functions
    return functions


def _find_fallback_function(addr: int) -> Optional[dict[str, Any]]:
    module = _find_module_info(addr=addr)
    if module is None:
        return None

    for func in _get_fallback_functions(module):
        if int(func["start"]) <= addr < int(func["end"]):
            return func

    return _analyze_linear_function(addr, module)


def _find_fallback_callers(addr: int, max_results: int = 50) -> list[int]:
    module = _find_module_info(addr=addr)
    if module is None:
        return []

    callers: list[int] = []
    for func in _get_fallback_functions(module):
        for edge in func["edges"]:
            if int(edge["to"]) == addr:
                callers.append(int(edge["from"]))
                if len(callers) >= max_results:
                    return callers
    return callers

# ═══════════════════════════════════════════════════════════════════════════
# HANDLERS — debug.*
# ═══════════════════════════════════════════════════════════════════════════

@handler("debug.load")
def handle_debug_load(params: dict) -> dict:
    import time as _time
    _require_x64dbg()
    exe = params["executablePath"]
    global _loaded_exe_path
    prev_loaded = _loaded_exe_path  # capture BEFORE mutating
    args = params.get("commandLineArgs", "")
    break_on_entry = params.get("breakOnEntry", True)
    auto_analyze = params.get("autoAnalyze", True)
    _FALLBACK_FUNCTION_CACHE.clear()

    # If a session is already alive: same path with a real pid → idempotent
    # return; different path / stuck "half-debugging" state → StopDebug and
    # reload cleanly.
    if sdk.DbgIsDebugging():
        same_path = bool(
            prev_loaded
            and os.path.normcase(os.path.abspath(prev_loaded))
            == os.path.normcase(os.path.abspath(exe))
        )
        live_pid = 0
        try:
            live_pid = int(_eval_expr("$pid") or 0)
        except Exception:
            live_pid = 0
        if same_path and live_pid > 0:
            log_info(f"debug.load: {exe} already loaded (pid={live_pid}) — returning existing state")
            entry = _eval_expr("entry")
            if not entry:
                try:
                    entry = _eval_expr("cip")
                except Exception:
                    entry = 0
            ptr_size = sdk.get_ptr_size()
            return {
                "pid": live_pid,
                "architecture": "x64" if ptr_size == 8 else "x86",
                "entryPoint": _hex(entry),
                "modules": [],
            }
        log_info(
            f"debug.load: existing session detected (loaded={prev_loaded!r}, pid={live_pid}); "
            f"issuing StopDebug before loading {exe}"
        )
        sdk.DbgCmdExec("StopDebug")
        for _ in range(150):  # up to 15 s
            if not sdk.DbgIsDebugging():
                break
            _time.sleep(0.1)
        if sdk.DbgIsDebugging():
            if live_pid > 0:
                # genuine real session that refuses to stop — surface error
                raise RuntimeError(
                    "x64dbg refused to stop the previous debug session within 15s. "
                    "Close the debugger window manually and retry."
                )
            # phantom "half-debugging" state with no real pid — proceed anyway,
            # InitDebug will take over.
            log_info("debug.load: phantom half-debugging state detected, proceeding with InitDebug")
        _loaded_exe_path = None

    if not os.path.isfile(exe):
        raise RuntimeError(f"Target executable not found inside debugger process: {exe}")

    cmd_line = f'"{exe}"'
    if args:
        cmd_line += f" {args}"

    log_info(f"debug.load: InitDebug {cmd_line}")

    # Use async DbgCmdExec for commands that start/control the debug session
    # to avoid blocking x64dbg's main thread from the Python bridge thread.
    if not sdk.DbgCmdExec(f"InitDebug {cmd_line}"):
        raise RuntimeError(f"DbgCmdExec rejected InitDebug command for: {exe}")

    # Wait until x64dbg has started the debug session (up to 15 s)
    for _ in range(150):
        if sdk.DbgIsDebugging():
            break
        _time.sleep(0.1)

    if not sdk.DbgIsDebugging():
        raise RuntimeError(
            f"InitDebug did not start a debug session within 15s. "
            f"Check that the executable exists and is a valid PE: {exe}"
        )

    if break_on_entry:
        _cmd("bpx entry")
        sdk.DbgCmdExec("erun")
        # Wait for debuggee to pause (hit entry BP or exit) — up to 30 s
        for _ in range(300):
            if not sdk.DbgIsRunning():
                break
            _time.sleep(0.1)
    else:
        sdk.DbgCmdExec("erun")
        # Confirm execution has actually started (up to 1 s)
        for _ in range(20):
            if sdk.DbgIsRunning():
                break
            _time.sleep(0.05)
        # Pause so that auto_analyze and info-gathering run on a stopped process.
        # We resume below after collecting stable state.
        sdk.DbgCmdExec("pause")
        for _ in range(100):  # up to 5 s
            if not sdk.DbgIsRunning():
                break
            _time.sleep(0.05)

    if auto_analyze:
        _cmd("analyse")

    # Gather basic info (safe to call only when debuggee is paused)
    pid = _eval_expr("$pid")
    entry = _eval_expr("entry")
    if not entry:
        # x64dbg expression "entry" sometimes resolves to 0 even when paused at OEP;
        # fall back to the current instruction pointer when we just hit the entry bp.
        try:
            entry = _eval_expr("cip")
        except Exception:
            entry = 0

    # Detect architecture via pointer size
    ptr_size = sdk.get_ptr_size()
    architecture = "x64" if ptr_size == 8 else "x86"

    # Module enumeration is deferred to analysis.getModules.
    # Some x86 targets destabilize x32dbg when queried immediately after load.
    modules = []

    _loaded_exe_path = exe

    result = {
        "pid": pid,
        "architecture": architecture,
        "entryPoint": _hex(entry),
        "modules": modules,
    }

    # When not breaking on entry, resume now that stable state has been collected
    if not break_on_entry:
        sdk.DbgCmdExec("run")

    return result


def _wait_for_stop(timeout: float = 120.0) -> None:
    """Wait until the debuggee is no longer running (paused or exited)."""
    import time as _t
    deadline = _t.time() + timeout
    _t.sleep(0.05)  # brief yield so erun can actually start
    while _t.time() < deadline:
        try:
            if not sdk.DbgIsRunning():
                return
        except Exception:
            return  # if we can't query, assume stopped
        _t.sleep(0.05)


def _infer_stop_reason(cip: int) -> str:
    """Infer why the debuggee stopped after a continue/run operation.

    Uses available bridge APIs to distinguish between common stop causes:
      - "exited"     — DbgIsDebugging() is False (process terminated)
      - "breakpoint" — a software/hardware BP exists at the current IP
      - "paused"     — all other cases (exception, user pause, step, etc.)
    """
    try:
        if not sdk.DbgIsDebugging():
            return "exited"
        bp_list = sdk.get_breakpoint_list()
        for bp in bp_list:
            if bp.get("address") == cip and bp.get("enabled", False):
                return "breakpoint"
    except Exception:
        pass
    return "paused"


@handler("debug.continue")
def handle_debug_continue(params: dict) -> dict:
    _require_x64dbg()
    _cmd("erun")
    _wait_for_stop()
    rip = _eval_expr("cip")
    reason = _infer_stop_reason(rip)
    return {
        "reason": reason,
        "address": _hex(rip),
    }


@handler("debug.stepInto")
def handle_debug_step_into(params: dict) -> dict:
    _require_x64dbg()
    count = params.get("count", 1)
    for _ in range(count):
        _cmd("esti")
        _wait_for_stop()
    return _current_location()


@handler("debug.collectBreakpointArgs")
def handle_collect_bp_args(params: dict) -> dict:
    """Continue execution in a loop, collecting a memory expression at each BP hit.

    Params:
      expr       - x64dbg expression to evaluate at each hit (e.g. "utf16@[esp+4]")
                   OR "ptr_utf16@[esp+4]" to dereference once then read UTF-16
      maxHits    - stop after this many hits (default 200)
      timeoutSec - give up if a single continue takes longer than this (default 10)

    The "ptr_utf16" mode: reads a 4-byte pointer at [esp+4] then reads UTF-16 from
    that pointer — suitable for wchar_t* arguments passed on the x86 stack.
    """
    _require_x64dbg()
    import time as _t
    import struct as _s

    # Detect architecture to choose the correct default calling convention
    ptr_size = sdk.get_ptr_size()
    is_x64   = ptr_size == 8
    # x64 Windows fastcall: first arg is a wchar_t* in rcx
    # x86 stdcall/cdecl:    first arg is a wchar_t* pointer at [esp+4]
    default_expr = "rcx" if is_x64 else "ptr_utf16@[esp+4]"
    expr      = params.get("expr", default_expr)
    max_hits  = int(params.get("maxHits",   200))
    timeout   = float(params.get("timeoutSec", 10.0))

    collected: list[str] = []
    errors:    list[str] = []

    def _read_ptr_at(addr: int) -> int:
        # Pointer width matches the *debuggee* bitness (not the debugger process)
        if is_x64:
            raw = sdk.read_memory(addr, 8)
            return _s.unpack_from("<Q", raw)[0]
        else:
            raw = sdk.read_memory(addr, 4)
            return _s.unpack_from("<I", raw)[0]

    def _read_wstr(ptr: int, max_chars: int = 260) -> str:
        raw = sdk.read_memory(ptr, max_chars * 2)
        chars = []
        for i in range(0, len(raw) - 1, 2):
            cp = _s.unpack_from("<H", raw, i)[0]
            if cp == 0:
                break
            chars.append(chr(cp))
        return "".join(chars)

    def _read_expr_val() -> str:
        try:
            if expr == "rcx":
                # x64 Windows fastcall: first arg is a wchar_t* in rcx
                ptr_val = _eval_expr("rcx")
                return _read_wstr(ptr_val)
            elif expr == "ptr_utf16@[esp+4]":
                # x86 stdcall/cdecl: first arg is a wchar_t* pointer at [esp+4]
                esp = _eval_expr("esp")
                ptr_val = _read_ptr_at(esp + 4)
                return _read_wstr(ptr_val)
            elif expr.startswith("utf16@"):
                # direct: evaluate the address part and read UTF-16 from there
                addr_expr = expr[len("utf16@"):]
                addr = _eval_expr(addr_expr)
                return _read_wstr(addr)
            else:
                return str(_eval_expr(expr))
        except Exception as e:
            return f"<error: {e}>"

    for hit_n in range(max_hits):
        # Continue until the next BP (or exception)
        _cmd("erun")
        deadline = _t.time() + timeout
        stopped = False
        while _t.time() < deadline:
            try:
                if not sdk.DbgIsRunning():
                    stopped = True
                    break
            except Exception:
                stopped = True
                break
            _t.sleep(0.02)

        if not stopped:
            errors.append(f"hit {hit_n}: timeout after {timeout}s")
            break

        # Check if still at the original breakpoint address
        try:
            cip = _eval_expr("cip")
        except Exception:
            cip = 0

        val = _read_expr_val()
        collected.append(val)

        # If the debuggee exited or CIP is 0, stop
        if cip == 0:
            break

    return {
        "totalHits": len(collected),
        "args": collected,
        "errors": errors,
    }


@handler("debug.stepOver")
def handle_debug_step_over(params: dict) -> dict:
    _require_x64dbg()
    count = params.get("count", 1)
    for _ in range(count):
        _cmd("esto")
        _wait_for_stop()
    return _current_location()


@handler("debug.stepOut")
def handle_debug_step_out(params: dict) -> dict:
    _require_x64dbg()
    _cmd("ertu")
    _wait_for_stop()
    return _current_location()


@handler("debug.runToAddress")
def handle_debug_run_to(params: dict) -> dict:
    _require_x64dbg()
    addr = params["address"]
    def _norm(a: str) -> int:
        try:
            return int(str(a), 16)
        except (ValueError, TypeError):
            return -1

    target = _norm(str(addr))
    rip = 0
    reason = "paused"
    reached = False

    _cmd(f"bpx {addr}, ss")
    try:
        for _ in range(32):
            _cmd("erun")
            _wait_for_stop()
            rip = _eval_expr("cip")
            reason = _infer_stop_reason(rip)
            if rip == target:
                reached = True
                break
            if reason == "exited":
                break
        return {"reached": reached, "stopAddress": _hex(rip), "reason": reason}
    finally:
        with contextlib.suppress(Exception):
            _cmd(f"bc {addr}")


@handler("debug.setBreakpoint")
def handle_set_breakpoint(params: dict) -> dict:
    _require_x64dbg()
    addr = params["address"]
    bp_type = params.get("type", "software")
    condition = params.get("condition")
    log_text = params.get("logText")
    name = params.get("name", "")

    type_cmds = {
        "software": f"bp {addr}",
        "hardware_execute": f"bph {addr}, x",
        "hardware_read": f"bph {addr}, r",
        "hardware_write": f"bph {addr}, w",
        "hardware_access": f"bph {addr}, rw",
        "memory_read": f"bpm {addr}, 0, r",
        "memory_write": f"bpm {addr}, 0, w",
        "memory_access": f"bpm {addr}, 0, a",
    }

    cmd_str = type_cmds.get(bp_type)
    if not cmd_str:
        raise ValueError(f"Unknown breakpoint type: {bp_type}")

    _cmd(cmd_str)

    if name:
        _cmd(f"SetBreakpointName {addr}, \"{name}\"")
    if condition:
        _cmd(f"SetBreakpointCondition {addr}, \"{condition}\"")
    if log_text:
        # Escape embedded quotes in log_text to avoid command-parse issues
        safe_log = log_text.replace('"', '\\"')
        _cmd(f"SetBreakpointLog {addr}, \"{safe_log}\"")
        _cmd(f"SetBreakpointLogCondition {addr}, \"1\"")  # always log

    # Return the address as supplied; skip _eval_expr to avoid ctypes ffi issues
    return {"address": addr, "resolved": True}


@handler("debug.removeBreakpoint")
def handle_remove_breakpoint(params: dict) -> dict:
    _require_x64dbg()
    addr = params["address"]
    _cmd(f"bc {addr}")
    return {"status": "removed"}


@handler("debug.listBreakpoints")
def handle_list_breakpoints(params: dict) -> dict:
    _require_x64dbg()
    bp_list = sdk.get_breakpoint_list()
    breakpoints = []
    for bp in bp_list:
        breakpoints.append({
            "address": _hex(bp["address"]),
            "type": bp["type"],
            "enabled": bp["enabled"],
            "hitCount": bp["hitCount"],
            "name": bp["name"],
        })
    return {"breakpoints": breakpoints}


@handler("debug.executeCommand")
def handle_execute_command(params: dict) -> dict:
    _require_x64dbg()
    cmd = params["command"]
    ok = _cmd(cmd)
    return {"output": "OK" if ok else "command failed"}


@handler("session.terminate")
def handle_session_terminate(params: dict) -> dict:
    _require_x64dbg()
    _cmd("stop")
    return {"status": "terminated"}


@handler("debug.stop")
def handle_debug_stop(params: dict) -> dict:
    """Stop the current debug session (terminate debuggee) but keep x64dbg alive."""
    _require_x64dbg()
    import time as _time
    if not sdk.DbgIsDebugging():
        return {"stopped": True, "note": "not debugging"}
    sdk.DbgCmdExec("stop")
    # Poll until x64dbg exits debug mode (max 3s)
    deadline = _time.time() + 3.0
    while _time.time() < deadline:
        if not sdk.DbgIsDebugging():
            break
        _time.sleep(0.05)
    return {"stopped": not sdk.DbgIsDebugging()}


# ═══════════════════════════════════════════════════════════════════════════
# HANDLERS — memory.*
# ═══════════════════════════════════════════════════════════════════════════

@handler("memory.read")
def handle_memory_read(params: dict) -> dict:
    _require_x64dbg()
    addr = _eval_expr(str(params["address"]))
    size = min(params.get("size", 256), 0x10000)
    data = _read_mem(addr, size)
    return {
        "address": _hex(addr),
        "size": len(data),
        "hex": data.hex(),
        "ascii": "".join(chr(b) if 32 <= b < 127 else "." for b in data),
        "hexDump": _hexdump(data, addr),
    }


@handler("memory.write")
def handle_memory_write(params: dict) -> dict:
    _require_x64dbg()
    addr = _eval_expr(str(params["address"]))
    hex_str = params["hexBytes"].replace(" ", "").replace("0x", "")
    data = bytes.fromhex(hex_str)
    written = _write_mem(addr, data)
    return {"address": _hex(addr), "bytesWritten": written}


def _select_module_range(mod: Optional[str] = None) -> tuple[int, int]:
    modules = sdk.get_module_list()
    if not modules:
        raise RuntimeError("No modules available")

    if mod:
        mod_lower = mod.lower()
        for module in modules:
            name = module.get("name", "")
            path = module.get("path", "")
            base_name = os.path.basename(path or name).lower()
            module_name = name.lower()
            if module_name == mod_lower or base_name == mod_lower or module_name.split(".")[0] == mod_lower.split(".")[0]:
                return int(module["base"]), int(module["size"])
        raise RuntimeError(f"Module not found: {mod}")

    for module in modules:
        path = module.get("path", "")
        if path.lower().endswith(".exe"):
            return int(module["base"]), int(module["size"])

    first = modules[0]
    return int(first["base"]), int(first["size"])


def _resolve_memory_range(start_expr: Optional[str], end_expr: Optional[str], mod: Optional[str] = None) -> tuple[int, int]:
    default_start, default_size = _select_module_range(mod)
    start = _eval_expr(str(start_expr)) if start_expr else default_start
    end = _eval_expr(str(end_expr)) if end_expr else (default_start + default_size)
    if end < start:
        raise RuntimeError(f"Invalid memory range: {_hex(start)}..{_hex(end)}")
    return start, end


def _read_range(address: int, size: int, chunk_size: int = 0x10000) -> bytes:
    parts: list[bytes] = []
    offset = 0
    while offset < size:
        cur_size = min(chunk_size, size - offset)
        parts.append(_read_mem(address + offset, cur_size))
        offset += cur_size
    return b"".join(parts)


def _compile_pattern(pattern: str, search_type: str) -> list[Optional[int]]:
    if search_type == "ascii":
        return [b for b in pattern.encode("ascii")]
    if search_type == "unicode":
        return [b for b in pattern.encode("utf-16-le")]

    tokens = pattern.strip().split()
    if len(tokens) == 1 and len(tokens[0]) % 2 == 0 and "?" not in tokens[0]:
        tokens = [tokens[0][i:i+2] for i in range(0, len(tokens[0]), 2)]

    compiled: list[Optional[int]] = []
    for token in tokens:
        if token in {"?", "??"}:
            compiled.append(None)
        else:
            compiled.append(int(token, 16))
    if not compiled:
        raise RuntimeError("Empty search pattern")
    return compiled


def _find_pattern_offsets(data: bytes, pattern: list[Optional[int]], max_results: int) -> tuple[int, list[int]]:
    hits: list[int] = []
    total = 0
    plen = len(pattern)
    limit = len(data) - plen + 1
    if plen == 0 or limit < 1:
        return 0, []

    for offset in range(limit):
        matched = True
        for idx, expected in enumerate(pattern):
            if expected is not None and data[offset + idx] != expected:
                matched = False
                break
        if not matched:
            continue
        total += 1
        if len(hits) < max_results:
            hits.append(offset)
    return total, hits


def _scan_strings(data: bytes, base: int, min_len: int, text_filter: str, max_results: int) -> tuple[int, list[dict]]:
    strings: list[dict] = []
    total = 0

    def _push(addr: int, value: str, kind: str) -> None:
        nonlocal total
        total += 1
        if len(strings) >= max_results:
            return
        strings.append({
            "address": _hex(addr),
            "value": value[:256],
            "type": kind,
            "length": len(value),
        })

    i = 0
    while i < len(data):
        if 32 <= data[i] < 127:
            start = i
            while i < len(data) and 32 <= data[i] < 127:
                i += 1
            value = data[start:i].decode("ascii", errors="ignore")
            if len(value) >= min_len and (not text_filter or text_filter in value.lower()):
                _push(base + start, value, "ascii")
            continue
        i += 1

    i = 0
    while i + 1 < len(data):
        start = i
        chars: list[str] = []
        while i + 1 < len(data) and 32 <= data[i] < 127 and data[i + 1] == 0:
            chars.append(chr(data[i]))
            i += 2
        if chars:
            value = "".join(chars)
            if len(value) >= min_len and (not text_filter or text_filter in value.lower()):
                _push(base + start, value, "unicode")
            continue
        i += 2

    strings.sort(key=lambda item: int(item["address"], 16))
    return total, strings


@handler("memory.search")
def handle_memory_search(params: dict) -> dict:
    _require_x64dbg()
    pattern = params["pattern"]
    search_type = params.get("searchType", "hex")
    max_results = params.get("maxResults", 100)
    start, end = _resolve_memory_range(params.get("startAddress"), params.get("endAddress"))
    compiled = _compile_pattern(pattern, search_type)
    data = _read_range(start, end - start)
    ref_count, offsets = _find_pattern_offsets(data, compiled, max_results)
    matches: list[dict] = []

    for offset in offsets:
        ref_addr = start + offset
        context_data = data[offset : offset + 32]
        matches.append({
            "address": _hex(ref_addr),
            "context": context_data.hex(),
        })

    return {
        "matches": matches,
        "totalFound": ref_count,
        "truncated": ref_count > max_results,
    }


@handler("memory.map")
def handle_memory_map(params: dict) -> dict:
    _require_x64dbg()
    filter_mod = params.get("filterModule")
    filter_prot = params.get("filterProtection")

    # Use DbgMemMap directly via SDK (more reliable than memmapdump command)
    try:
        mem_map = sdk.MEMMAP()
        fn = sdk._b().DbgMemMap
        fn.argtypes = [POINTER(sdk.MEMMAP)]
        fn.restype = c_bool
        ok = fn(sdk.byref(mem_map))
        log_info(f"DbgMemMap ok={ok}, count={mem_map.count}")
        if ok and mem_map.count > 0:
            regions: list[dict] = []
            for i in range(min(mem_map.count, 2000)):
                p = mem_map.page[i]
                base = p.BaseAddress
                size = p.RegionSize
                mod = p.info.decode("utf-8", errors="replace").strip("\x00") if p.info else ""
                if not mod:
                    mod = sdk.get_module_at(base) if base else ""
                prot = _protection_str(p.Protect)
                rtype = _memtype_str(p.Type)
                if filter_mod and filter_mod.lower() not in mod.lower():
                    continue
                if filter_prot and filter_prot not in prot:
                    continue
                regions.append({
                    "baseAddress": _hex(base),
                    "size": _hex(size),
                    "protection": prot,
                    "type": rtype,
                    "module": mod,
                })
            if mem_map.page:
                sdk._b().BridgeFree(mem_map.page)
            return {"regions": regions, "totalRegions": len(regions)}
    except Exception as _me:
        log_error(f"DbgMemMap error: {_me}")

    # Fallback: try memmapdump command
    _cmd("memmapdump")
    ref_count = _eval_expr("$result")
    log_info(f"memmapdump fallback ref_count={ref_count}")
    regions = []
    for i in range(min(ref_count, 500)):
        base = _eval_expr(f"ref.addr({i})")
        size = _eval_expr(f"ref.size({i})")
        mod = sdk.get_module_at(base)
        regions.append({
            "baseAddress": _hex(base),
            "size": _hex(size),
            "protection": "",
            "type": "",
            "module": mod,
        })
    return {"regions": regions, "totalRegions": len(regions)}


def _protection_str(protect: int) -> str:
    """Convert Windows MEMORY_BASIC_INFORMATION Protect flags to string.

    The lower byte is an exclusive protection type (not a bitmask).
    Modifier flags (PAGE_GUARD=0x100, PAGE_NOCACHE=0x200) are OR-ed in.
    """
    if protect == 0:
        return ""
    _BASE = {
        0x01: "---",  # PAGE_NOACCESS
        0x02: "R",    # PAGE_READONLY
        0x04: "RW",   # PAGE_READWRITE
        0x08: "WC",   # PAGE_WRITECOPY
        0x10: "X",    # PAGE_EXECUTE
        0x20: "XR",   # PAGE_EXECUTE_READ
        0x40: "XRW",  # PAGE_EXECUTE_READWRITE
        0x80: "XWC",  # PAGE_EXECUTE_WRITECOPY
    }
    base = protect & 0xFF
    result = _BASE.get(base, f"0x{base:02X}")
    if protect & 0x100: result += "+G"   # PAGE_GUARD
    if protect & 0x200: result += "+N"   # PAGE_NOCACHE
    if protect & 0x400: result += "+WC"  # PAGE_WRITECOMBINE
    return result


def _memtype_str(memtype: int) -> str:
    """Convert Windows MEMORY_BASIC_INFORMATION Type flags to string."""
    if memtype == 0x00020000: return "PRIVATE"
    if memtype == 0x00040000: return "MAPPED"
    if memtype == 0x01000000: return "IMAGE"
    return f"0x{memtype:X}" if memtype else ""


# ═══════════════════════════════════════════════════════════════════════════
# HANDLERS — registers.*
# ═══════════════════════════════════════════════════════════════════════════

_GP_REGS_64 = ["rax","rbx","rcx","rdx","rsi","rdi","rbp","rsp","rip",
               "r8","r9","r10","r11","r12","r13","r14","r15"]
_GP_REGS_32 = ["eax","ebx","ecx","edx","esi","edi","ebp","esp","eip"]
_FLAGS = ["cf","pf","af","zf","sf","tf","if","df","of"]
_SEG_REGS = ["cs","ds","es","fs","gs","ss"]
_DBG_REGS = ["dr0","dr1","dr2","dr3","dr6","dr7"]


@handler("registers.get")
def handle_registers_get(params: dict) -> dict:
    _require_x64dbg()
    ptr_size = sdk.get_ptr_size()
    gp_names = _GP_REGS_64 if ptr_size == 8 else _GP_REGS_32

    general = {}
    for r in gp_names:
        general[r] = _hex(_eval_expr(r))

    flags = {}
    for f in _FLAGS:
        flags[f.upper()] = bool(_eval_expr(f))

    result: dict = {"general": general, "flags": flags}

    if params.get("includeSegment"):
        result["segment"] = {r: _hex(_eval_expr(r), 4) for r in _SEG_REGS}
    if params.get("includeDebug"):
        result["debug"] = {r: _hex(_eval_expr(r)) for r in _DBG_REGS}

    return result


@handler("registers.set")
def handle_registers_set(params: dict) -> dict:
    _require_x64dbg()
    reg = params["register"]
    val = params["value"]
    _cmd(f"mov {reg}, {val}")
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════════════════════
# HANDLERS — stack.*, threads.*
# ═══════════════════════════════════════════════════════════════════════════

@handler("stack.getCallStack")
def handle_get_callstack(params: dict) -> dict:
    _require_x64dbg()
    max_frames = params.get("maxFrames", 50)
    stack = sdk.get_callstack()[:max_frames]  # truncate before symbol lookups
    thread_info = sdk.get_thread_list()
    frames = []
    for i, frame in enumerate(stack):
        return_addr = frame["to"]
        frames.append({
            "index": i,
            "address": _hex(return_addr),
            "returnAddress": _hex(return_addr),
            "module": sdk.get_module_at(return_addr),
            "function": sdk.get_label_at(return_addr),
        })
    return {"threadId": thread_info.get("currentThreadId", 0), "frames": frames}


@handler("threads.list")
def handle_threads_list(params: dict) -> dict:
    _require_x64dbg()
    tl = sdk.get_thread_list()
    result = []
    for t in tl["threads"]:
        result.append({
            "id": t["id"],
            "handle": "",
            "entry": _hex(t["entry"]),
            "teb": _hex(t["teb"]),
            "state": "",
            "priority": "",
            "name": t["name"],
        })
    return {"activeThreadId": tl.get("currentThreadId", 0), "threads": result}


@handler("threads.switch")
def handle_threads_switch(params: dict) -> dict:
    _require_x64dbg()
    tid = params["threadId"]
    prev = _eval_expr("$tid")
    _cmd(f"switchthread {tid}")
    rip = _eval_expr("cip")
    return {"previousThread": prev, "currentThread": tid, "address": _hex(rip)}


# ═══════════════════════════════════════════════════════════════════════════
# HANDLERS — analysis.*
# ═══════════════════════════════════════════════════════════════════════════

@handler("analysis.disassemble")
def handle_disassemble(params: dict) -> dict:
    _require_x64dbg()
    addr = _eval_expr(str(params["address"]))
    count = params.get("count", 30)

    instructions = []
    cur = addr
    for _ in range(count):
        info = sdk.DbgDisasmAt(cur)
        inst_bytes = _read_mem(cur, info["size"])
        mnemonic = info["mnemonic"]
        operands = info["operands"]
        is_call = mnemonic.startswith("call")
        is_jump = mnemonic.startswith("j") or mnemonic == "jmp"
        is_ret = mnemonic.startswith("ret")
        comment = sdk.get_comment_at(cur)
        instructions.append({
            "address": _hex(cur),
            "bytes": inst_bytes.hex().upper(),
            "mnemonic": mnemonic,
            "operands": operands,
            "comment": comment,
            "isCall": is_call,
            "isJump": is_jump,
            "isRet": is_ret,
            "isNop": mnemonic == "nop",
        })
        cur += info["size"]

    func_label = sdk.get_label_at(addr)
    return {
        "startAddress": _hex(addr),
        "functionName": func_label or None,
        "instructions": instructions,
    }


@handler("analysis.analyzeFunction")
def handle_analyze_function(params: dict) -> dict:
    _require_x64dbg()
    addr = _eval_expr(str(params["address"]))
    start, end = sdk.get_function_at(addr)
    callees: list[str] = []
    inst_count = 0
    callers: list[str] = []

    if start == 0 and end == 0:
        fallback = _find_fallback_function(addr)
        if fallback is None:
            raise RuntimeError(f"No function found at {_hex(addr)}")
        start = int(fallback["start"])
        end = int(fallback["end"])
        inst_count = int(fallback["instructionCount"])
        callees = [_hex(int(target)) for target in dict.fromkeys(fallback["callees"])]
        callers = [_hex(caller) for caller in _find_fallback_callers(start)]
        name = str(fallback["name"])
    else:
        name = sdk.get_label_at(start) or _hex(start)
        cur = start
        while cur < end:
            info = sdk.DbgDisasmAt(cur)
            inst_count += 1
            if info["mnemonic"].startswith("call"):
                target = _direct_target_from_operands(info["operands"])
                if target is not None:
                    callees.append(_hex(target))
            cur += info["size"]

        _cmd(f"analxrefs {_hex(start)}")
        ref_count = _eval_expr("$result")
        for i in range(min(ref_count, 50)):
            callers.append(_hex(_eval_expr(f"ref.addr({i})")))
        fallback_callers = [_hex(caller) for caller in _find_fallback_callers(start)]
        if fallback_callers:
            start_module = sdk.get_module_at(start)
            same_module_callers = [
                caller for caller in callers if sdk.get_module_at(int(caller, 16)) == start_module
            ]
            if not same_module_callers:
                callers = fallback_callers
            else:
                for caller in fallback_callers:
                    if caller not in callers:
                        callers.append(caller)

    return {
        "address": _hex(start),
        "endAddress": _hex(end),
        "name": name,
        "size": end - start,
        "instructionCount": inst_count,
        "callCount": len(callees),
        "isLeaf": len(callees) == 0,
        "callers": callers,
        "callees": list(set(callees)),
    }


@handler("analysis.getXrefs")
def handle_get_xrefs(params: dict) -> dict:
    _require_x64dbg()
    addr = _eval_expr(str(params["address"]))
    direction = params.get("direction", "to")

    xrefs_to: list[dict] = []
    xrefs_from: list[dict] = []

    if direction in ("to", "both"):
        _cmd(f"analxrefs {_hex(addr)}")
        cnt = _eval_expr("$result")
        for i in range(min(cnt, 200)):
            ref = _eval_expr(f"ref.addr({i})")
            xrefs_to.append({"from": _hex(ref), "to": _hex(addr), "type": "unknown"})
        fallback_to = [
            {"from": _hex(caller), "to": _hex(addr), "type": "call"}
            for caller in _find_fallback_callers(addr, max_results=200)
        ]
        if fallback_to:
            target_module = sdk.get_module_at(addr)
            same_module_to = [
                item for item in xrefs_to if sdk.get_module_at(int(item["from"], 16)) == target_module
            ]
            if not same_module_to:
                xrefs_to = fallback_to
            else:
                for item in fallback_to:
                    if item not in xrefs_to:
                        xrefs_to.append(item)

    if direction in ("from", "both"):
        _cmd(f"analxrefs {_hex(addr)}, 1")
        cnt = _eval_expr("$result")
        for i in range(min(cnt, 200)):
            ref = _eval_expr(f"ref.addr({i})")
            xrefs_from.append({"from": _hex(addr), "to": _hex(ref), "type": "unknown"})
        if not xrefs_from:
            func = _find_fallback_function(addr)
            if func is not None:
                for edge in func["edges"]:
                    xrefs_from.append({
                        "from": _hex(int(edge["from"])),
                        "to": _hex(int(edge["to"])),
                        "type": str(edge["type"]),
                    })

    return {"address": _hex(addr), "xrefsTo": xrefs_to, "xrefsFrom": xrefs_from}


@handler("analysis.listFunctions")
def handle_list_functions(params: dict) -> dict:
    _require_x64dbg()
    # Use x64dbg command to enumerate functions via analysis
    name_filter = (params.get("nameFilter") or "").lower()
    module_filter = params.get("module") or ""
    mod_filter = module_filter.lower()
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)

    _cmd("functionlist")
    ref_count = _eval_expr("$result")

    filtered = []
    for i in range(min(ref_count, 5000)):
        fstart = _eval_expr(f"ref.addr({i})")
        fend = _eval_expr(f"ref.end({i})")
        fname = sdk.get_label_at(fstart)
        fmod = sdk.get_module_at(fstart)
        if name_filter and name_filter not in fname.lower():
            continue
        if mod_filter and mod_filter not in fmod.lower():
            continue
        filtered.append({
            "address": _hex(fstart),
            "name": fname or _hex(fstart),
            "size": fend - fstart if fend > fstart else 0,
            "module": fmod,
        })

    if not filtered:
        modules: list[dict] = []
        if module_filter:
            module = _find_module_info(mod=module_filter)
            if module is not None:
                modules.append(module)
        else:
            module = _find_module_info()
            if module is not None:
                modules.append(module)

        for module in modules:
            for func in _get_fallback_functions(module):
                fname = str(func["name"])
                fmod = str(func["module"])
                if name_filter and name_filter not in fname.lower():
                    continue
                if mod_filter and mod_filter not in fmod.lower():
                    continue
                filtered.append({
                    "address": _hex(int(func["start"])),
                    "name": fname,
                    "size": int(func["end"]) - int(func["start"]),
                    "module": fmod,
                })

    return {"total": len(filtered), "functions": filtered[offset : offset + limit]}


@handler("analysis.getModules")
def handle_get_modules(params: dict) -> dict:
    _require_x64dbg()
    try:
        modules = _get_module_list()
        log_info(f"get_modules returned {len(modules)} modules")
    except Exception as _me:
        log_error(f"get_modules error: {_me}")
        log_error(f"get_modules traceback: {traceback.format_exc()}")
        modules = []
    return {"modules": modules}


@handler("analysis.getImports")
def handle_get_imports(params: dict) -> dict:
    """Parse import table from PE file on disk (avoids ctypes ffi_prep_cif issues on 32-bit)."""
    _require_x64dbg()
    import struct as _struct

    mod = params.get("module")
    dll_filter  = (params.get("dllFilter")      or "").lower()
    func_filter = (params.get("functionFilter") or "").lower()

    file_path = _resolve_pe_file_path(mod)
    with open(file_path, "rb") as _fh:
        file_data = _fh.read()

    if len(file_data) < 64 or file_data[:2] != b"MZ":
        raise RuntimeError(f"Invalid DOS header: {file_path}")

    pe_offset = _struct.unpack_from("<I", file_data, 0x3C)[0]
    if file_data[pe_offset:pe_offset + 4] != b"PE\x00\x00":
        raise RuntimeError("Invalid PE signature")

    num_sections = _struct.unpack_from("<H", file_data, pe_offset + 6)[0]
    opt_hdr_size = _struct.unpack_from("<H", file_data, pe_offset + 20)[0]
    opt_start    = pe_offset + 24
    opt_magic    = _struct.unpack_from("<H", file_data, opt_start)[0]
    is_pe32plus  = opt_magic == 0x20B
    ptr_size     = 8 if is_pe32plus else 4

    # Build section table for RVA→file-offset conversion
    sec_table_start = opt_start + opt_hdr_size
    raw_sections: list[tuple[int, int, int, int]] = []  # (va, vs, roff, rs)
    for i in range(num_sections):
        off = sec_table_start + i * 40
        if off + 40 > len(file_data):
            break
        va   = _struct.unpack_from("<I", file_data, off + 12)[0]
        vs   = _struct.unpack_from("<I", file_data, off + 8)[0]
        roff = _struct.unpack_from("<I", file_data, off + 20)[0]
        rs   = _struct.unpack_from("<I", file_data, off + 16)[0]
        raw_sections.append((va, vs, roff, rs))

    def rva2off(rva: int) -> Optional[int]:
        for va, vs, roff, rs in raw_sections:
            if va <= rva < va + max(vs, rs):
                return roff + (rva - va)
        return None

    # Import Directory (DataDirectory[1])
    # PE32:  opt_start+96 = DataDirectory[0]; +104 = DataDirectory[1]
    # PE32+: opt_start+112 = DataDirectory[0]; +120 = DataDirectory[1]
    dd1_off = (opt_start + 120) if is_pe32plus else (opt_start + 104)
    imp_rva  = _struct.unpack_from("<I", file_data, dd1_off)[0]
    imp_size = _struct.unpack_from("<I", file_data, dd1_off + 4)[0]

    mod_basename = os.path.basename(file_path)
    if not imp_rva or not imp_size:
        return {"module": mod or mod_basename, "totalImports": 0, "imports": []}

    desc_off = rva2off(imp_rva)
    if desc_off is None:
        return {"module": mod or mod_basename, "totalImports": 0, "imports": [],
                "error": "import directory RVA not mapped to any section"}

    imports: list[dict] = []
    idx = 0
    while True:
        off = desc_off + idx * 20  # IMAGE_IMPORT_DESCRIPTOR = 20 bytes
        if off + 20 > len(file_data):
            break
        orig_thunk_rva = _struct.unpack_from("<I", file_data, off)[0]
        name_rva       = _struct.unpack_from("<I", file_data, off + 12)[0]
        first_thunk_rva= _struct.unpack_from("<I", file_data, off + 16)[0]
        if not orig_thunk_rva and not name_rva and not first_thunk_rva:
            break  # null terminator

        # DLL name
        dll_name = ""
        name_off = rva2off(name_rva)
        if name_off is not None:
            null = file_data.find(b"\x00", name_off)
            dll_name = file_data[name_off:null].decode("ascii", errors="replace") if null >= 0 else ""

        if dll_filter and dll_filter not in dll_name.lower():
            idx += 1
            continue

        # Name table (prefer OriginalFirstThunk, fall back to FirstThunk)
        thunk_rva = orig_thunk_rva if orig_thunk_rva else first_thunk_rva
        thunk_off = rva2off(thunk_rva)
        if thunk_off is not None:
            t = 0
            while True:
                toff = thunk_off + t * ptr_size
                if toff + ptr_size > len(file_data):
                    break
                if is_pe32plus:
                    thunk_val = _struct.unpack_from("<Q", file_data, toff)[0]
                    ordinal_flag = (thunk_val >> 63) & 1
                    ord_mask = 0xFFFF
                    ibn_mask = 0x7FFFFFFFFFFFFFFF
                else:
                    thunk_val = _struct.unpack_from("<I", file_data, toff)[0]
                    ordinal_flag = (thunk_val >> 31) & 1
                    ord_mask = 0xFFFF
                    ibn_mask = 0x7FFFFFFF
                if not thunk_val:
                    break
                if ordinal_flag:
                    func_name  = f"#{thunk_val & ord_mask}"
                    ordinal_n  = thunk_val & ord_mask
                else:
                    ibn_off = rva2off(thunk_val & ibn_mask)
                    if ibn_off is not None and ibn_off + 2 < len(file_data):
                        ordinal_n = _struct.unpack_from("<H", file_data, ibn_off)[0]
                        ns = ibn_off + 2
                        ne = file_data.find(b"\x00", ns)
                        func_name = file_data[ns:ne].decode("ascii", errors="replace") if ne >= 0 else ""
                    else:
                        func_name, ordinal_n = "", None
                if not func_filter or func_filter in func_name.lower():
                    imports.append({
                        "module":   dll_name,
                        "function": func_name,
                        "ordinal":  ordinal_n,
                        "address":  "",
                    })
                t += 1
        idx += 1

    return {"module": mod or mod_basename, "totalImports": len(imports), "imports": imports}


@handler("analysis.getExports")
def handle_get_exports(params: dict) -> dict:
    """Parse export table from PE file on disk (avoids ctypes ffi_prep_cif issues on 32-bit)."""
    _require_x64dbg()
    import struct as _struct

    mod = params["module"]
    name_filter = (params.get("nameFilter") or "").lower()

    file_path = _resolve_pe_file_path(mod)
    with open(file_path, "rb") as _fh:
        file_data = _fh.read()

    if len(file_data) < 64 or file_data[:2] != b"MZ":
        raise RuntimeError(f"Invalid DOS header: {file_path}")

    pe_offset = _struct.unpack_from("<I", file_data, 0x3C)[0]
    if file_data[pe_offset:pe_offset + 4] != b"PE\x00\x00":
        raise RuntimeError("Invalid PE signature")

    num_sections = _struct.unpack_from("<H", file_data, pe_offset + 6)[0]
    opt_hdr_size = _struct.unpack_from("<H", file_data, pe_offset + 20)[0]
    opt_start    = pe_offset + 24
    opt_magic    = _struct.unpack_from("<H", file_data, opt_start)[0]
    is_pe32plus  = opt_magic == 0x20B

    sec_table_start = opt_start + opt_hdr_size
    raw_sections: list[tuple[int, int, int, int]] = []
    for i in range(num_sections):
        off = sec_table_start + i * 40
        if off + 40 > len(file_data):
            break
        va   = _struct.unpack_from("<I", file_data, off + 12)[0]
        vs   = _struct.unpack_from("<I", file_data, off + 8)[0]
        roff = _struct.unpack_from("<I", file_data, off + 20)[0]
        rs   = _struct.unpack_from("<I", file_data, off + 16)[0]
        raw_sections.append((va, vs, roff, rs))

    def rva2off(rva: int) -> Optional[int]:
        for va, vs, roff, rs in raw_sections:
            if va <= rva < va + max(vs, rs):
                return roff + (rva - va)
        return None

    # Export Directory (DataDirectory[0])
    # PE32:  opt_start+96; PE32+: opt_start+112
    dd0_off = (opt_start + 112) if is_pe32plus else (opt_start + 96)
    exp_rva  = _struct.unpack_from("<I", file_data, dd0_off)[0]
    exp_size = _struct.unpack_from("<I", file_data, dd0_off + 4)[0]

    mod_basename = os.path.basename(file_path)
    if not exp_rva or not exp_size:
        return {"module": mod, "totalExports": 0, "exports": []}

    exp_off = rva2off(exp_rva)
    if exp_off is None:
        return {"module": mod, "totalExports": 0, "exports": [],
                "error": "export directory RVA not mapped"}

    # IMAGE_EXPORT_DIRECTORY (40 bytes)
    ordinal_base   = _struct.unpack_from("<I", file_data, exp_off + 16)[0]
    num_funcs      = _struct.unpack_from("<I", file_data, exp_off + 20)[0]
    num_names      = _struct.unpack_from("<I", file_data, exp_off + 24)[0]
    funcs_rva      = _struct.unpack_from("<I", file_data, exp_off + 28)[0]
    names_rva      = _struct.unpack_from("<I", file_data, exp_off + 32)[0]
    ordinals_rva   = _struct.unpack_from("<I", file_data, exp_off + 36)[0]

    funcs_off    = rva2off(funcs_rva)
    names_off    = rva2off(names_rva)
    ordinals_off = rva2off(ordinals_rva)

    # Build ordinal→name map from the named exports
    ord2name: dict[int, str] = {}
    if names_off is not None and ordinals_off is not None:
        for i in range(num_names):
            name_rva_val = _struct.unpack_from("<I", file_data, names_off + i * 4)[0]
            ord_idx      = _struct.unpack_from("<H", file_data, ordinals_off + i * 2)[0]
            name_off_i   = rva2off(name_rva_val)
            if name_off_i is not None:
                null = file_data.find(b"\x00", name_off_i)
                name = file_data[name_off_i:null].decode("ascii", errors="replace") if null >= 0 else ""
                ord2name[ord_idx] = name

    exports: list[dict] = []
    if funcs_off is not None:
        for i in range(num_funcs):
            func_rva = _struct.unpack_from("<I", file_data, funcs_off + i * 4)[0]
            if not func_rva:
                continue
            ordinal = ordinal_base + i
            name = ord2name.get(i, "")
            # Check if this is a forwarder (RVA within export directory)
            forwarder = ""
            if exp_rva <= func_rva < exp_rva + exp_size:
                fwd_off = rva2off(func_rva)
                if fwd_off is not None:
                    null = file_data.find(b"\x00", fwd_off)
                    forwarder = file_data[fwd_off:null].decode("ascii", errors="replace") if null >= 0 else ""

            if name_filter and name_filter not in name.lower():
                continue
            entry: dict = {
                "name":    name,
                "ordinal": ordinal,
                "rva":     _hex(func_rva),
            }
            if forwarder:
                entry["forwarder"] = forwarder
            exports.append(entry)

    return {"module": mod, "totalExports": len(exports), "exports": exports}


@handler("analysis.findStrings")
def handle_find_strings(params: dict) -> dict:
    _require_x64dbg()
    mod = params.get("module")
    text_filter = (params.get("filter") or "").lower()
    min_len = params.get("minLength", 4)
    max_results = params.get("maxResults", 200)
    start, end = _resolve_memory_range(None, None, mod)
    data = _read_range(start, end - start)
    ref_count, strings = _scan_strings(data, start, min_len, text_filter, max_results)

    return {
        "totalFound": ref_count,
        "strings": strings,
        "truncated": ref_count > max_results,
    }


def _resolve_pe_file_path(mod: Optional[str]) -> str:
    """Resolve the disk path for a module (or main exe when mod is None).

    Uses three strategies to avoid DbgMemRead / ffi_prep_cif issues on 32-bit:
    1. GetModuleFileNameExW via psapi (most accurate, uses debuggee process)
    2. Module list from DbgGetModuleList / DbgMemMap fallback
    3. _loaded_exe_path global (stored at debug.load time) + sibling-dir search
    """
    file_path: Optional[str] = None

    # Strategy 1: GetModuleFileNameExW via psapi
    try:
        import ctypes as _ct
        _fn_hproc = _b().DbgGetProcessHandle
        _fn_hproc.argtypes = []
        _fn_hproc.restype = _ct.c_void_p
        _h_proc = _fn_hproc()
        if _h_proc:
            _psapi = _ct.WinDLL("psapi")
            _buf = _ct.create_unicode_buffer(32768)
            _base = _eval_expr(f"{mod}:0" if mod else "mod.main()")
            _r = _psapi.GetModuleFileNameExW(
                _ct.c_void_p(_h_proc),
                _ct.c_void_p(_base),
                _buf,
                _ct.c_uint(32768),
            )
            if _r:
                file_path = _buf.value
    except Exception:
        pass

    # Strategy 2: module list (DbgGetModuleList primary, DbgMemMap fallback)
    if not file_path:
        try:
            modules = _get_module_list()
            if mod:
                mod_lower = mod.lower()
                for m in modules:
                    name = m.get("name", "").lower()
                    path = m.get("path", "")
                    if path and (name == mod_lower or name.split(".")[0] == mod_lower.split(".")[0]):
                        file_path = path
                        break
            else:
                for m in modules:
                    path = m.get("path", "")
                    if path and path.lower().endswith(".exe"):
                        file_path = path
                        break
        except Exception:
            pass

    # Strategy 3: _loaded_exe_path global + sibling-dir search for named DLLs
    if not file_path:
        global _loaded_exe_path
        if not mod and _loaded_exe_path:
            file_path = _loaded_exe_path
        elif mod:
            search_roots: list[str] = []
            if _loaded_exe_path:
                search_roots.append(os.path.dirname(_loaded_exe_path))
            search_roots += [os.getcwd(), "C:\\Windows\\System32", "C:\\Windows\\SysWOW64"]
            for d in search_roots:
                candidate = os.path.join(d, mod)
                if os.path.isfile(candidate):
                    file_path = candidate
                    break

    if not file_path or not os.path.isfile(file_path):
        raise RuntimeError(f"Could not resolve disk path for module: {mod or '(main)'}")
    return file_path


@handler("analysis.getPEHeader")
def handle_get_pe_header(params: dict) -> dict:
    """Parse PE header from disk to avoid DbgMemRead ctypes issues on 32-bit."""
    _require_x64dbg()
    import struct as _struct

    mod = params.get("module")
    file_path = _resolve_pe_file_path(mod)

    # Read entire file (PE headers are at the start; section data throughout)
    with open(file_path, "rb") as _fh:
        file_data = _fh.read()

    if len(file_data) < 64 or file_data[:2] != b"MZ":
        raise RuntimeError(f"Invalid DOS header in file: {file_path}")

    pe_offset = _struct.unpack_from("<I", file_data, 0x3C)[0]
    if pe_offset + 264 > len(file_data) or file_data[pe_offset:pe_offset + 4] != b"PE\x00\x00":
        raise RuntimeError("Invalid PE signature")

    machine      = _struct.unpack_from("<H", file_data, pe_offset + 4)[0]
    num_sections = _struct.unpack_from("<H", file_data, pe_offset + 6)[0]
    timestamp    = _struct.unpack_from("<I", file_data, pe_offset + 8)[0]
    opt_hdr_size = _struct.unpack_from("<H", file_data, pe_offset + 20)[0]

    opt_start = pe_offset + 24
    opt_magic = _struct.unpack_from("<H", file_data, opt_start)[0]
    is_pe32plus = opt_magic == 0x20B

    if is_pe32plus:
        entry_rva     = _struct.unpack_from("<I", file_data, opt_start + 16)[0]
        image_base_val = _struct.unpack_from("<Q", file_data, opt_start + 24)[0]
        image_size_val = _struct.unpack_from("<I", file_data, opt_start + 56)[0]
        subsystem     = _struct.unpack_from("<H", file_data, opt_start + 68)[0]
    else:
        entry_rva     = _struct.unpack_from("<I", file_data, opt_start + 16)[0]
        image_base_val = _struct.unpack_from("<I", file_data, opt_start + 28)[0]
        image_size_val = _struct.unpack_from("<I", file_data, opt_start + 56)[0]
        subsystem     = _struct.unpack_from("<H", file_data, opt_start + 68)[0]

    # Section headers
    sec_table_start = opt_start - 4 + opt_hdr_size + 4  # pe_offset+24+opt_hdr_size
    sec_table_start = pe_offset + 24 + opt_hdr_size

    sections = []
    for i in range(num_sections):
        off = sec_table_start + i * 40
        if off + 40 > len(file_data):
            break
        sec_name = file_data[off:off + 8].rstrip(b"\x00").decode("ascii", errors="replace")
        vs   = _struct.unpack_from("<I", file_data, off + 8)[0]
        va   = _struct.unpack_from("<I", file_data, off + 12)[0]
        rs   = _struct.unpack_from("<I", file_data, off + 16)[0]
        roff = _struct.unpack_from("<I", file_data, off + 20)[0]  # PointerToRawData
        chars = _struct.unpack_from("<I", file_data, off + 36)[0]

        # Read raw section bytes from disk for entropy (not from memory)
        if roff > 0 and rs > 0 and roff + rs <= len(file_data):
            sec_data = file_data[roff:roff + min(rs, 0x10000)]
        else:
            sec_data = b""

        char_flags = []
        if chars & 0x20000000: char_flags.append("execute")
        if chars & 0x40000000: char_flags.append("read")
        if chars & 0x80000000: char_flags.append("write")

        sections.append({
            "name": sec_name,
            "virtualAddress": _hex(va),
            "virtualSize": _hex(vs),
            "rawSize": _hex(rs),
            "characteristics": ",".join(char_flags) if char_flags else _hex(chars, 8),
            "entropy": _entropy(sec_data),
        })

    machine_names = {0x14C: "i386", 0x8664: "AMD64", 0xAA64: "ARM64"}
    subsys_names  = {1: "native", 2: "GUI", 3: "console", 7: "POSIX"}

    return {
        "module": mod or os.path.basename(file_path),
        "filePath": file_path,
        "machine": machine_names.get(machine, _hex(machine, 4)),
        "timestamp": timestamp,
        "entryPoint": _hex(entry_rva),
        "imageBase": _hex(image_base_val),
        "imageSize": _hex(image_size_val),
        "subsystem": subsys_names.get(subsystem, str(subsystem)),
        "sections": sections,
    }


@handler("analysis.trace")
def handle_trace(params: dict) -> dict:
    _require_x64dbg()
    max_inst = params.get("maxInstructions", 500)
    trace_into = params.get("traceInto", False)
    record_regs = params.get("recordRegisters", False)
    break_on = params.get("breakOnCall")

    trace_entries: list[dict] = []
    step_cmd = "esti" if trace_into else "esto"

    for i in range(max_inst):
        rip = _eval_expr("cip")
        info = sdk.DbgDisasmAt(rip)
        mnemonic = info["mnemonic"]
        operands = info["operands"]
        entry: dict = {
            "address": _hex(rip),
            "disassembly": f"{mnemonic} {operands}".strip(),
        }
        if record_regs:
            ptr_size = sdk.get_ptr_size()
            gp = _GP_REGS_64 if ptr_size == 8 else _GP_REGS_32
            entry["registers"] = {r: _hex(_eval_expr(r)) for r in gp}

        trace_entries.append(entry)

        # Check break condition
        if break_on and mnemonic.startswith("call"):
            if break_on.lower() in operands.lower():
                return {
                    "instructionsTraced": len(trace_entries),
                    "stopReason": f"call to {operands}",
                    "trace": trace_entries,
                }

        _cmd(step_cmd)
        _wait_for_stop()

        # Check if debuggee terminated
        if not sdk.DbgIsDebugging():
            return {
                "instructionsTraced": len(trace_entries),
                "stopReason": "process_exited",
                "trace": trace_entries,
            }

    return {
        "instructionsTraced": len(trace_entries),
        "stopReason": "max_instructions_reached",
        "trace": trace_entries,
    }


# ═══════════════════════════════════════════════════════════════════════════
# HANDLERS — security.*
# ═══════════════════════════════════════════════════════════════════════════

KNOWN_PACKER_SECTIONS = {
    ".upx": "UPX", "upx0": "UPX", "upx1": "UPX",
    ".aspack": "ASPack", ".adata": "ASPack",
    ".mpress": "MPRESS", ".mpress1": "MPRESS",
    ".fsg": "FSG",
    ".nsp": "NsPack", ".nsp0": "NsPack",
    ".petite": "Petite",
    ".themida": "Themida", ".winlice": "Themida",
    ".vmp0": "VMProtect", ".vmp1": "VMProtect",
}


@handler("security.detectPacking")
def handle_detect_packing(params: dict) -> dict:
    _require_x64dbg()
    mod = params.get("module")
    pe = handle_get_pe_header(params)
    sections = pe.get("sections", [])

    indicators: list[dict] = []
    packer_name: Optional[str] = None
    entropies: dict[str, float] = {}

    for sec in sections:
        name = sec["name"].lower().strip("\x00")
        ent = sec.get("entropy", 0)
        entropies[sec["name"]] = ent

        # High entropy
        if ent > 7.0:
            indicators.append({
                "type": "high_entropy",
                "description": f"Section '{sec['name']}' has entropy {ent} (>7.0)",
                "severity": "high",
            })

        # Known packer section names
        if name in KNOWN_PACKER_SECTIONS:
            packer_name = KNOWN_PACKER_SECTIONS[name]
            indicators.append({
                "type": "known_packer_section",
                "description": f"Section '{sec['name']}' matches packer: {packer_name}",
                "severity": "high",
            })

        # Zero raw size with non-zero virtual size
        raw = int(sec.get("rawSize", "0x0"), 16)
        virt = int(sec.get("virtualSize", "0x0"), 16)
        if raw == 0 and virt > 0:
            indicators.append({
                "type": "empty_raw_section",
                "description": f"Section '{sec['name']}' has rawSize=0 but virtualSize={_hex(virt)}",
                "severity": "medium",
            })

    # Very few imports can indicate packing
    import_data = handle_get_imports(params)
    import_count = import_data.get("totalImports", 0)
    if import_count < 10:
        indicators.append({
            "type": "low_import_count",
            "description": f"Only {import_count} imports (packed binaries often have very few)",
            "severity": "medium",
        })

    # Overall entropy
    all_ents = list(entropies.values())
    overall = sum(all_ents) / max(len(all_ents), 1)

    is_packed = len(indicators) >= 2 or packer_name is not None
    confidence = min(len(indicators) * 0.25, 1.0) if indicators else 0.0

    return {
        "module": mod or "(main)",
        "isPacked": is_packed,
        "confidence": round(confidence, 2),
        "packerName": packer_name,
        "overallEntropy": round(overall, 4),
        "indicators": indicators,
        "sectionEntropies": entropies,
        "importCount": import_count,
    }


@handler("security.detectAntiDebug")
def handle_detect_anti_debug(params: dict) -> dict:
    _require_x64dbg()
    mod = params.get("module")
    import_data = handle_get_imports(params)
    imports = import_data.get("imports", [])

    anti_debug_apis = {
        "IsDebuggerPresent": {
            "description": "Checks PEB.BeingDebugged flag",
            "bypass": "Patch PEB.BeingDebugged or hook the API to return 0",
        },
        "CheckRemoteDebuggerPresent": {
            "description": "Queries kernel for debugger presence",
            "bypass": "Hook NtQueryInformationProcess with ProcessDebugPort",
        },
        "NtQueryInformationProcess": {
            "description": "Can query ProcessDebugPort, ProcessDebugFlags, ProcessDebugObjectHandle",
            "bypass": "Hook to return fake values for debug-related classes",
        },
        "OutputDebugStringA": {
            "description": "Anti-debug via checking GetLastError after OutputDebugString",
            "bypass": "Patch the check or use ScyllaHide",
        },
        "GetTickCount": {
            "description": "Timing check — detects debugger slowdown",
            "bypass": "Hook to return consistent values",
        },
        "QueryPerformanceCounter": {
            "description": "High-resolution timing check",
            "bypass": "Hook to return incrementing values",
        },
        "NtSetInformationThread": {
            "description": "Can hide thread from debugger (ThreadHideFromDebugger)",
            "bypass": "Hook and ignore HideFromDebugger class",
        },
    }

    techniques: list[dict] = []
    for imp in imports:
        func = imp["function"]
        if func in anti_debug_apis:
            info = anti_debug_apis[func]
            techniques.append({
                "name": func,
                "description": info["description"],
                "addresses": [imp["address"]],
                "severity": "high",
                "bypass": info["bypass"],
            })

    # Check for TLS callbacks via .tls section presence in PE header
    tls_callbacks: list[str] = []
    try:
        pe = handle_get_pe_header(params)
        for sec in pe.get("sections", []):
            if sec.get("name", "").lower().strip("\x00") == ".tls":
                tls_callbacks.append(sec["virtualAddress"])
                break
    except Exception:
        pass

    return {
        "module": mod or "(main)",
        "techniques": techniques,
        "tlsCallbacks": tls_callbacks,
        "hasAntiDebug": len(techniques) > 0,
        "totalTechniques": len(techniques),
    }


@handler("security.checkSectionAnomalies")
def handle_check_section_anomalies(params: dict) -> dict:
    _require_x64dbg()
    mod = params.get("module")
    pe = handle_get_pe_header(params)
    sections = pe.get("sections", [])

    total_anomalies = 0
    result_sections: list[dict] = []

    for sec in sections:
        anomalies: list[str] = []
        chars = sec.get("characteristics", "")
        is_exec = "x" in chars.lower() or "execute" in chars.lower()
        is_write = "w" in chars.lower() or "write" in chars.lower()
        ent = sec.get("entropy", 0)

        if is_exec and is_write:
            anomalies.append("Section is both writable and executable (W+X)")
        if ent > 7.0:
            anomalies.append(f"Very high entropy ({ent}) — likely packed or encrypted")
        elif ent > 6.5 and is_exec:
            anomalies.append(f"High entropy ({ent}) in executable section")

        raw = int(sec.get("rawSize", "0x0"), 16)
        virt = int(sec.get("virtualSize", "0x0"), 16)
        if raw == 0 and virt > 0:
            anomalies.append("Raw size is 0 but virtual size is non-zero")
        if virt > raw * 10 and raw > 0:
            anomalies.append(f"Virtual size is {virt // raw}x larger than raw size")

        name = sec["name"].strip("\x00")
        if not name.isprintable() or len(name) == 0:
            anomalies.append("Section name contains non-printable characters")

        total_anomalies += len(anomalies)
        result_sections.append({
            "name": name,
            "virtualAddress": sec["virtualAddress"],
            "virtualSize": sec["virtualSize"],
            "rawSize": sec["rawSize"],
            "entropy": ent,
            "isExecutable": is_exec,
            "isWritable": is_write,
            "anomalies": anomalies,
        })

    summary = "No anomalies detected" if total_anomalies == 0 else (
        f"Found {total_anomalies} anomalies across {len(result_sections)} sections"
    )

    return {
        "module": mod or "(main)",
        "sections": result_sections,
        "totalAnomalies": total_anomalies,
        "summary": summary,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Module list helper
# ═══════════════════════════════════════════════════════════════════════════

def _get_module_list() -> list[dict]:
    modules = sdk.get_module_list()
    result = []
    for m in modules:
        result.append({
            "name": m["name"],
            "base": _hex(m["base"]),
            "size": _hex(m["size"]),
            "path": m.get("path", ""),
            "entry": _hex(m.get("entry", 0)),
        })
    return result


def _current_location() -> dict:
    rip = _eval_expr("cip")
    info = sdk.DbgDisasmAt(rip)
    mod_name = sdk.get_module_at(rip)
    func_name = sdk.get_label_at(rip)
    ptr_size = sdk.get_ptr_size()
    gp = _GP_REGS_64 if ptr_size == 8 else _GP_REGS_32
    regs = {r: _hex(_eval_expr(r)) for r in gp}
    return {
        "address": _hex(rip),
        "disassembly": f"{info['mnemonic']} {info['operands']}".strip(),
        "module": mod_name,
        "function": func_name,
        "registers": regs,
    }


# ═══════════════════════════════════════════════════════════════════════════
# TCP server
# ═══════════════════════════════════════════════════════════════════════════

class BridgeServer:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.server_socket: Optional[socket.socket] = None
        self.running = False

    def start(self) -> None:
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind((self.host, self.port))
        self.server_socket.listen(2)
        self.running = True
        log_info(f"Bridge listening on {self.host}:{self.port}")

        thread = threading.Thread(target=self._accept_loop, daemon=True)
        thread.start()

    def stop(self) -> None:
        self.running = False
        if self.server_socket:
            self.server_socket.close()
        log_info("Bridge server stopped")

    def _accept_loop(self) -> None:
        while self.running:
            try:
                client, addr = self.server_socket.accept()  # type: ignore[union-attr]
                log_info(f"Client connected from {addr}")
                thread = threading.Thread(
                    target=self._handle_client, args=(client,), daemon=True
                )
                thread.start()
            except OSError:
                break

    def _handle_client(self, client: socket.socket) -> None:
        buffer = ""
        try:
            while self.running:
                data = client.recv(BUFFER_SIZE)
                if not data:
                    break
                buffer += data.decode("utf-8")

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    response = self._dispatch(line)
                    client.sendall((json.dumps(response) + "\n").encode("utf-8"))
        except Exception as e:
            import traceback as _tb2
            _err_msg = _tb2.format_exc()
            log_error(f"Client handler error: {e}")
            try:
                with open(os.path.join(_plugin_dir, "mcp_handler_error.log"), "a") as _ef2:
                    _ef2.write(_err_msg + "\n")
            except Exception:
                pass
        finally:
            client.close()
            log_info("Client disconnected")

    def _dispatch(self, raw: str) -> dict:
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as e:
            return {"id": "", "success": False, "error": f"Invalid JSON: {e}"}

        req_id = req.get("id", "")
        method = req.get("method", "")
        params = req.get("params", {})
        auth_token = _normalize_bridge_token(str(req.get("authToken", "")))

        if (
            not BRIDGE_AUTH_TOKEN
            or not hmac.compare_digest(
                auth_token.encode("utf-8"),
                BRIDGE_AUTH_TOKEN.encode("utf-8"),
            )
        ):
            return {"id": req_id, "success": False, "error": "Unauthorized bridge request"}

        handler_fn = _handlers.get(method)
        if not handler_fn:
            return {"id": req_id, "success": False, "error": f"Unknown method: {method}"}

        # Trace log for crash diagnosis (capped at 1 MB to prevent unbounded growth)
        import time as _ttime
        _trace_file = os.path.join(_plugin_dir, "mcp_dispatch_trace.log")
        def _tr(msg: str):
            try:
                if os.path.exists(_trace_file) and os.path.getsize(_trace_file) > 1_000_000:
                    return
                with open(_trace_file, "a", encoding="utf-8") as _tf:
                    _tf.write(f"{_ttime.strftime('%H:%M:%S')} {msg}\n")
                    _tf.flush()
            except Exception:
                pass
        _tr(f"dispatch: {method}")

        lock_ctx = contextlib.nullcontext() if method in _LOCKLESS_HANDLERS else _dispatch_lock
        with lock_ctx:
            try:
                result = handler_fn(params)
                _tr(f"dispatch OK: {method}")
                return {"id": req_id, "success": True, "data": result}
            except Exception as e:
                _tr(f"dispatch EXCEPTION: {method}: {e}")
                log_error(f"Handler {method} failed: {traceback.format_exc()}")
                return {"id": req_id, "success": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════════════════

_bridge_server: Optional[BridgeServer] = None


def start_bridge() -> None:
    global _bridge_server
    if _bridge_server and _bridge_server.running:
        log_info("Bridge already running")
        return
    _bridge_server = BridgeServer(BRIDGE_HOST, BRIDGE_PORT)
    _bridge_server.start()


def stop_bridge() -> None:
    global _bridge_server
    if _bridge_server:
        _bridge_server.stop()
        _bridge_server = None


# Always start the bridge TCP server — INSIDE_X64DBG is checked lazily
# per-handler by _require_x64dbg(). The initial probe at module load time
# may fail due to a race condition (x32bridge.dll not yet fully ready when
# the plugin thread runs); handlers will re-probe on first call.
start_bridge()

if __name__ == "__main__":
    # Standalone mode: keep the process alive so daemon threads can serve
    try:
        import time
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_bridge()
