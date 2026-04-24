"""
x64dbg Bridge SDK — Python 3 ctypes bindings
=============================================
Direct ctypes wrapper around x64bridge.dll / x32bridge.dll.
No dependency on x64dbgpy. Requires Python 3.10+.

This module is loaded inside x64dbg's process space by the C loader plugin.
The bridge DLLs are already loaded, so we just grab function pointers.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import sys
from ctypes import (
    POINTER, Structure, byref, c_bool, c_char, c_char_p, c_int,
    c_size_t, c_ubyte, c_uint, c_uint64, c_ulong, c_void_p, cast,
    create_string_buffer, windll,
)
from typing import Optional

# ── Pointer-size detection ────────────────────────────────────────────────

IS_64BIT = sys.maxsize > 2**32
PTR_SIZE = 8 if IS_64BIT else 4

duint = c_uint64 if IS_64BIT else c_uint  # x64dbg's duint type

# ── Locate and load bridge DLL ────────────────────────────────────────────

def _find_bridge_dll() -> ctypes.CDLL:
    """Find x64bridge.dll or x32bridge.dll already loaded in process."""
    dll_name = "x64bridge.dll" if IS_64BIT else "x32bridge.dll"

    # Method 1: Already loaded in-process (plugin context).
    # Must declare restype=c_void_p to avoid 32-bit truncation on 64-bit Python.
    try:
        _GetModuleHandle = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_wchar_p)(
            ("GetModuleHandleW", ctypes.windll.kernel32)
        )
        handle = _GetModuleHandle(dll_name)
        if handle:
            return ctypes.CDLL(dll_name, handle=handle)
    except OSError:
        pass

    # Method 2: Search relative to x64dbg executable
    x64dbg_dir = os.environ.get("X64DBG_PATH", "")
    if x64dbg_dir:
        candidate = os.path.join(x64dbg_dir, "release", dll_name)
        if os.path.isfile(candidate):
            return ctypes.CDLL(candidate)

    # Method 3: Try loading directly (PATH)
    return ctypes.CDLL(dll_name)


_bridge: Optional[ctypes.CDLL] = None


def _b() -> ctypes.CDLL:
    """Lazy-init bridge DLL handle."""
    global _bridge
    if _bridge is None:
        _bridge = _find_bridge_dll()
    return _bridge


# ── Constants ─────────────────────────────────────────────────────────────

MAX_LABEL_SIZE = 256
MAX_COMMENT_SIZE = 512
MAX_MODULE_SIZE = 256
MAX_STRING_SIZE = 512
MAX_MNEMONIC_SIZE = 64
MAX_PATH_SIZE = 260
MAX_BREAKPOINT_SIZE = 256
MAX_SECTION_SIZE = 10

# Breakpoint types
bp_normal = 0
bp_hardware = 1
bp_memory = 2
bp_dll = 3
bp_exception = 4

# ── Structures ────────────────────────────────────────────────────────────

class BASIC_INSTRUCTION_INFO(Structure):
    _fields_ = [
        ("type", c_uint),
        ("value", duint),
        ("size", c_int),
        ("branch", c_bool),
        ("call", c_bool),
        ("string", c_bool),
        ("memory", duint),
    ]


class BRIDGEBP(Structure):
    _fields_ = [
        ("type", c_int),
        ("addr", duint),
        ("enabled", c_bool),
        ("singleshoot", c_bool),
        ("active", c_bool),
        ("name", c_char * MAX_BREAKPOINT_SIZE),
        ("mod", c_char * MAX_MODULE_SIZE),
        ("hitCount", c_uint),
    ]


class BRIDGEBPLIST(Structure):
    _fields_ = [
        ("count", c_int),
        ("bp", POINTER(BRIDGEBP)),
    ]


class THREADINFO(Structure):
    _fields_ = [
        ("ThreadNumber", c_int),
        ("ThreadId", duint),
        ("ThreadStartAddress", duint),
        ("ThreadLocalBase", duint),
        ("threadName", c_char * MAX_STRING_SIZE),
    ]


class THREADLIST(Structure):
    _fields_ = [
        ("count", c_int),
        ("list", POINTER(THREADINFO)),
        ("CurrentThread", c_int),
    ]


class MEMPAGE(Structure):
    """Matches x64dbg's MEMPAGE struct from bridgemain.h.
    Contains a Windows MEMORY_BASIC_INFORMATION plus module name.
    """
    _fields_ = [
        ("BaseAddress", duint),
        ("AllocationBase", duint),
        ("AllocationProtect", duint),
        ("RegionSize", duint),
        ("State", duint),
        ("Protect", duint),
        ("Type", duint),
        ("info", c_char * MAX_MODULE_SIZE),
    ]


class MEMMAP(Structure):
    """Matches x64dbg's MEMMAP struct from bridgemain.h."""
    _fields_ = [
        ("count", c_int),
        ("page", POINTER(MEMPAGE)),
    ]


class MODINFO(Structure):
    _fields_ = [
        ("base", duint),
        ("size", duint),
        ("entry", duint),
        ("sectionCount", c_int),
        ("name", c_char * MAX_MODULE_SIZE),
        ("path", c_char * MAX_PATH_SIZE),
    ]


class MODLIST(Structure):
    _fields_ = [
        ("count", c_int),
        ("mod", POINTER(MODINFO)),
    ]


class STACK_ENTRY(Structure):
    _fields_ = [
        ("addr", duint),
        ("to", duint),
        ("from_", duint),
        ("comment", c_char * MAX_COMMENT_SIZE),
    ]


class CALLSTACK(Structure):
    _fields_ = [
        ("total", c_int),
        ("entries", POINTER(STACK_ENTRY)),
    ]


# ── Low-level wrappers ───────────────────────────────────────────────────

def DbgCmdExec(command: str) -> bool:
    """Queue an x64dbg command asynchronously. Safe to call from any thread."""
    fn = _b().DbgCmdExec
    fn.argtypes = [c_char_p]
    fn.restype = c_int  # Win32 BOOL = int, not c_bool (1-byte)
    return bool(fn(command.encode("utf-8")))


def DbgCmdExecDirect(command: str) -> bool:
    """Execute an x64dbg command synchronously. Returns success."""
    fn = _b().DbgCmdExecDirect
    fn.argtypes = [c_char_p]
    fn.restype = c_int  # Win32 BOOL = int
    return bool(fn(command.encode("utf-8")))


def DbgValFromString(expression: str) -> int:
    """Evaluate an x64dbg expression and return the numeric result."""
    fn = _b().DbgValFromString
    fn.argtypes = [c_char_p]
    fn.restype = duint
    return fn(expression.encode("utf-8"))


def DbgMemRead(va: int, dest: ctypes.Array, size: int) -> bool:
    fn = _b().DbgMemRead
    fn.argtypes = [duint, c_char_p, duint]  # c_char_p avoids c_void_p ffi_prep_cif failure
    fn.restype = c_int
    return bool(fn(duint(va), dest, duint(size)))


def DbgMemWrite(va: int, src: bytes, size: int) -> bool:
    buf = create_string_buffer(src, size)
    fn = _b().DbgMemWrite
    fn.argtypes = [duint, c_char_p, duint]  # c_char_p avoids c_void_p ffi_prep_cif failure
    fn.restype = c_int
    return bool(fn(duint(va), buf, duint(size)))


# ── Process-handle-based memory access (avoids ffi_prep_cif on 32-bit) ──────

_cached_process_handle: Optional[int] = None


def _get_process_handle() -> int:
    """Return the debuggee's process handle via DbgGetProcessHandle (cached)."""
    global _cached_process_handle
    if _cached_process_handle:
        return _cached_process_handle
    fn = _b().DbgGetProcessHandle
    # Don't set argtypes=[] — empty argtypes causes ffi_prep_cif failure on 32-bit
    fn.restype = c_void_p
    _cached_process_handle = fn()
    return _cached_process_handle


def read_memory_k32(address: int, size: int) -> bytes:
    """Read debuggee memory via kernel32.ReadProcessMemory (no ffi_prep_cif issues)."""
    h = _get_process_handle()
    if not h:
        raise RuntimeError("No process handle — is a process being debugged?")
    buf = ctypes.create_string_buffer(size)
    n   = c_size_t(0)
    ok  = windll.kernel32.ReadProcessMemory(
        c_void_p(h),
        c_void_p(address),
        buf,
        c_size_t(size),
        byref(n),
    )
    if not ok:
        err = windll.kernel32.GetLastError()
        raise RuntimeError(f"ReadProcessMemory failed at {address:#x}: error {err}")
    return bytes(buf.raw[: n.value])


def write_memory_k32(address: int, data: bytes) -> int:
    """Write debuggee memory via kernel32.WriteProcessMemory."""
    h = _get_process_handle()
    if not h:
        raise RuntimeError("No process handle — is a process being debugged?")
    buf = ctypes.create_string_buffer(data, len(data))
    n   = c_size_t(0)
    ok  = windll.kernel32.WriteProcessMemory(
        c_void_p(h),
        c_void_p(address),
        buf,
        c_size_t(len(data)),
        byref(n),
    )
    if not ok:
        err = windll.kernel32.GetLastError()
        raise RuntimeError(f"WriteProcessMemory failed at {address:#x}: error {err}")
    return n.value


def DbgIsDebugging() -> bool:
    fn = _b().DbgIsDebugging
    # Don't set argtypes=[] — empty argtypes causes ffi_prep_cif failure on 32-bit
    fn.restype = c_int  # Win32 BOOL = int
    return bool(fn())


def DbgIsRunning() -> bool:
    fn = _b().DbgIsRunning
    # Don't set argtypes=[] — empty argtypes causes ffi_prep_cif failure on 32-bit
    fn.restype = c_int  # Win32 BOOL = int
    return bool(fn())


def DbgDisasmAt(addr: int) -> dict:
    """Disassemble one instruction at addr."""
    info = BASIC_INSTRUCTION_INFO()
    buf = create_string_buffer(MAX_STRING_SIZE)

    fn = _b().DbgDisasmFastAt
    fn.argtypes = [duint, POINTER(BASIC_INSTRUCTION_INFO), c_char_p]
    fn.restype = c_int  # Win32 BOOL
    fn(duint(addr), byref(info), buf)

    disasm_text = buf.value.decode("utf-8", errors="replace").strip()
    parts = disasm_text.split(None, 1)
    mnemonic = parts[0] if parts else ""
    operands = parts[1] if len(parts) > 1 else ""

    return {
        "addr": addr,
        "size": info.size if info.size > 0 else 1,
        "mnemonic": mnemonic,
        "operands": operands,
        "is_call": bool(info.call),
        "is_branch": bool(info.branch),
    }


# ── High-level helpers ────────────────────────────────────────────────────

def read_memory(address: int, size: int) -> bytes:
    """Read `size` bytes from debuggee virtual memory.

    Uses ReadProcessMemory (kernel32) as the primary method to avoid the
    ffi_prep_cif libffi failure that DbgMemRead causes on 32-bit Python.
    Falls back to DbgMemRead if the process handle is unavailable.
    """
    try:
        return read_memory_k32(address, size)
    except RuntimeError:
        pass
    # Fallback: DbgMemRead (may fail with ffi_prep_cif on 32-bit)
    buf = (c_ubyte * size)()
    ok = DbgMemRead(address, buf, size)
    if not ok:
        raise RuntimeError(f"Failed to read {size} bytes at {address:#x}")
    return bytes(buf)


def write_memory(address: int, data: bytes) -> int:
    """Write bytes to debuggee. Returns bytes written."""
    try:
        return write_memory_k32(address, data)
    except RuntimeError:
        pass
    ok = DbgMemWrite(address, data, len(data))
    if not ok:
        raise RuntimeError(f"Failed to write {len(data)} bytes at {address:#x}")
    return len(data)


def eval_expr(expr: str) -> int:
    return DbgValFromString(expr)


def cmd(command: str) -> bool:
    return DbgCmdExecDirect(command)


def get_ptr_size() -> int:
    return PTR_SIZE


def get_module_list() -> list[dict]:
    """Get list of loaded modules.

    Primary: try DbgGetModuleList (available in newer x64bridge builds).
    Fallback: use DbgMemMap to enumerate memory regions, then extract
    IMAGE-type regions and get module info via DbgGetModuleAt.
    """
    # --- Try native API first ---
    try:
        fn = _b().DbgGetModuleList
    except AttributeError:
        fn = None

    if fn is not None:
        try:
            mod_list = MODLIST()
            fn.argtypes = [POINTER(MODLIST)]
            fn.restype = c_int  # Win32 BOOL
            ok = fn(byref(mod_list))
            if ok and mod_list.count > 0:
                result = []
                for i in range(mod_list.count):
                    m = mod_list.mod[i]
                    result.append({
                        "name": m.name.decode("utf-8", errors="replace"),
                        "base": m.base,
                        "size": m.size,
                        "entry": m.entry,
                        "path": m.path.decode("utf-8", errors="replace"),
                    })
                if mod_list.mod:
                    _b().BridgeFree(mod_list.mod)
                return result
        except Exception:
            pass

    # --- Fallback: use DbgMemMap + MEMPAGE info ---
    # DbgMemMap fills a MEMMAP structure with MEMPAGE entries
    try:
        mem_map = MEMMAP()
        fn = _b().DbgMemMap
        fn.argtypes = [POINTER(MEMMAP)]
        fn.restype = c_int  # Win32 BOOL
        ok = fn(byref(mem_map))
        if ok and mem_map.count > 0:
            seen_bases: set[int] = set()
            result = []
            for i in range(mem_map.count):
                p = mem_map.page[i]
                base = p.BaseAddress
                size = p.RegionSize
                mod_name = p.info.decode("utf-8", errors="replace").strip("\x00")
                # Only consider image regions with a module name
                if base in seen_bases or base == 0:
                    continue
                if not mod_name:
                    # Try DbgGetModuleAt as fallback
                    mod_name = get_module_at(base)
                if mod_name:
                    seen_bases.add(base)
                    entry_addr = 0
                    try:
                        entry_addr = _eval_expr_bridge(f"{mod_name}:0")
                    except Exception:
                        pass
                    result.append({
                        "name": mod_name,
                        "base": base,
                        "size": size,
                        "entry": entry_addr,
                        "path": "",
                    })
            if mem_map.page:
                _b().BridgeFree(mem_map.page)
            return result
    except Exception:
        pass

    # --- Last resort: use x64dbg command-based approach ---
    return []


def get_breakpoint_list() -> list[dict]:
    """Get all breakpoints."""
    bp_list = BRIDGEBPLIST()
    fn = _b().DbgGetBpList
    fn.argtypes = [c_int, POINTER(BRIDGEBPLIST)]
    fn.restype = c_int  # Win32 BOOL
    fn(bp_normal, byref(bp_list))

    result = []
    for i in range(bp_list.count):
        bp = bp_list.bp[i]
        result.append({
            "address": bp.addr,
            "type": bp.type,
            "enabled": bp.enabled,
            "hitCount": bp.hitCount,
            "name": bp.name.decode("utf-8", errors="replace"),
            "module": bp.mod.decode("utf-8", errors="replace"),
        })

    if bp_list.bp:
        _b().BridgeFree(bp_list.bp)

    return result


def get_callstack() -> list[dict]:
    """Get current thread callstack."""
    cs = CALLSTACK()
    fn = _b().DbgGetCallStack
    fn.argtypes = [POINTER(CALLSTACK)]
    fn.restype = c_int  # Win32 BOOL
    fn(byref(cs))

    result = []
    for i in range(cs.total):
        e = cs.entries[i]
        result.append({
            "address": e.addr,
            "to": e.to,
            "from": e.from_,
            "comment": e.comment.decode("utf-8", errors="replace"),
        })

    if cs.entries:
        _b().BridgeFree(cs.entries)

    return result


def get_thread_list() -> dict:
    """Get thread list with current thread index."""
    tl = THREADLIST()
    fn = _b().DbgGetThreadList
    fn.argtypes = [POINTER(THREADLIST)]
    fn.restype = c_int  # Win32 BOOL
    fn(byref(tl))

    threads = []
    for i in range(tl.count):
        t = tl.list[i]
        threads.append({
            "id": t.ThreadId,
            "number": t.ThreadNumber,
            "entry": t.ThreadStartAddress,
            "teb": t.ThreadLocalBase,
            "name": t.threadName.decode("utf-8", errors="replace"),
        })

    current = tl.CurrentThread
    if tl.list:
        _b().BridgeFree(tl.list)

    return {"threads": threads, "currentThread": current}


def get_label_at(addr: int) -> str:
    """Get label/symbol name at address."""
    buf = create_string_buffer(MAX_LABEL_SIZE)
    fn = _b().DbgGetLabelAt
    fn.argtypes = [duint, c_int, c_char_p]
    fn.restype = c_int  # Win32 BOOL
    if fn(duint(addr), 0, buf):
        return buf.value.decode("utf-8", errors="replace")
    return ""


def get_comment_at(addr: int) -> str:
    """Get comment at address."""
    buf = create_string_buffer(MAX_COMMENT_SIZE)
    fn = _b().DbgGetCommentAt
    fn.argtypes = [duint, c_char_p]
    fn.restype = c_int  # Win32 BOOL
    if fn(duint(addr), buf):
        return buf.value.decode("utf-8", errors="replace")
    return ""


def _eval_expr_bridge(expr: str) -> int:
    """Evaluate an expression using DbgEval."""
    fn = _b().DbgEval
    fn.argtypes = [c_char_p]
    fn.restype = duint
    return fn(expr.encode("utf-8"))


def get_module_at(addr: int) -> str:
    """Get module name containing address."""
    buf = create_string_buffer(MAX_MODULE_SIZE)
    fn = _b().DbgGetModuleAt
    fn.argtypes = [duint, c_char_p]
    fn.restype = c_int  # Win32 BOOL
    if fn(duint(addr), buf):
        return buf.value.decode("utf-8", errors="replace")
    return ""


def get_function_at(addr: int) -> tuple[int, int]:
    """Get function boundaries. Returns (start, end) or (0, 0)."""
    start = duint(0)
    end = duint(0)
    fn = _b().DbgFunctionGet
    fn.argtypes = [duint, POINTER(duint), POINTER(duint)]
    fn.restype = c_int  # Win32 BOOL
    if fn(duint(addr), byref(start), byref(end)):
        return (start.value, end.value)
    return (0, 0)


def log_print(text: str) -> None:
    """Print to x64dbg log pane."""
    DbgCmdExecDirect(f'log "{text}"')


def read_string(addr: int, max_len: int = 256) -> str:
    """Read a null-terminated string from memory."""
    try:
        data = read_memory(addr, max_len)
        null_pos = data.find(0)
        if null_pos >= 0:
            data = data[:null_pos]
        return data.decode("utf-8", errors="replace")
    except RuntimeError:
        return ""
