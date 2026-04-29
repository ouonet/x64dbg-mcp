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
import struct
import sys
from ctypes import (
    POINTER, Structure, byref, c_bool, c_char, c_char_p, c_int,
    c_size_t, c_ubyte, c_uint, c_uint64, c_ulong, c_void_p, cast,
    create_string_buffer, windll,
)
from typing import Optional

try:
    from iced_x86 import Decoder as IcedDecoder, Formatter as IcedFormatter, FormatterSyntax
except Exception:
    IcedDecoder = None  # type: ignore[assignment]
    IcedFormatter = None  # type: ignore[assignment]
    FormatterSyntax = None  # type: ignore[assignment]

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
MAX_MODULE_NAME32 = 255
MAX_THREAD_NAME_SIZE = 256
MAX_CONDITIONAL_EXPR_SIZE = 256
MAX_CONDITIONAL_TEXT_SIZE = 256

TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
INVALID_HANDLE_VALUE = c_void_p(-1).value

# Breakpoint types (BPXTYPE enum)
bp_none = 0
bp_normal = 1
bp_hardware = 2
bp_memory = 4
bp_dll = 8
bp_exception = 16

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


class DISASM_ARG(Structure):
    _fields_ = [
        ("type", c_int),
        ("segment", c_int),
        ("mnemonic", c_char * MAX_MNEMONIC_SIZE),
        ("constant", duint),
        ("value", duint),
        ("memvalue", duint),
    ]


class DISASM_INSTR(Structure):
    _fields_ = [
        ("instruction", c_char * MAX_MNEMONIC_SIZE),
        ("type", c_int),
        ("argcount", c_int),
        ("instr_size", c_int),
        ("arg", DISASM_ARG * 3),
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
        ("slot", ctypes.c_ushort),
        ("typeEx", c_ubyte),
        ("hwSize", c_ubyte),
        ("hitCount", c_uint),
        ("fastResume", c_bool),
        ("silent", c_bool),
        ("breakCondition", c_char * MAX_CONDITIONAL_EXPR_SIZE),
        ("logText", c_char * MAX_CONDITIONAL_TEXT_SIZE),
        ("logCondition", c_char * MAX_CONDITIONAL_EXPR_SIZE),
        ("commandText", c_char * MAX_CONDITIONAL_TEXT_SIZE),
        ("commandCondition", c_char * MAX_CONDITIONAL_EXPR_SIZE),
    ]


class BPMAP(Structure):
    _fields_ = [
        ("count", c_int),
        ("bp", POINTER(BRIDGEBP)),
    ]


class THREADINFO(Structure):
    _fields_ = [
        ("ThreadNumber", c_int),
        ("Handle", wt.HANDLE),
        ("ThreadId", wt.DWORD),
        ("ThreadStartAddress", duint),
        ("ThreadLocalBase", duint),
        ("threadName", c_char * MAX_THREAD_NAME_SIZE),
    ]


class THREADALLINFO(Structure):
    _fields_ = [
        ("BasicInfo", THREADINFO),
        ("ThreadCip", duint),
        ("SuspendCount", wt.DWORD),
        ("Priority", c_int),
        ("WaitReason", c_int),
        ("LastError", wt.DWORD),
        ("UserTime", wt.FILETIME),
        ("KernelTime", wt.FILETIME),
        ("CreationTime", wt.FILETIME),
        ("Cycles", ctypes.c_uint64),
    ]


class THREADLIST(Structure):
    _fields_ = [
        ("count", c_int),
        ("list", POINTER(THREADALLINFO)),
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


class MODULEENTRY32W(Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("th32ModuleID", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("GlblcntUsage", wt.DWORD),
        ("ProccntUsage", wt.DWORD),
        ("modBaseAddr", c_void_p),
        ("modBaseSize", wt.DWORD),
        ("hModule", wt.HMODULE),
        ("szModule", wt.WCHAR * (MAX_MODULE_NAME32 + 1)),
        ("szExePath", wt.WCHAR * wt.MAX_PATH),
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


class DBGFUNCTIONS_PARTIAL(Structure):
    _fields_ = [
        ("AssembleAtEx", c_void_p),
        ("SectionFromAddr", c_void_p),
        ("ModNameFromAddr", c_void_p),
        ("ModBaseFromAddr", c_void_p),
        ("ModBaseFromName", c_void_p),
        ("ModSizeFromAddr", c_void_p),
        ("Assemble", c_void_p),
        ("PatchGet", c_void_p),
        ("PatchInRange", c_void_p),
        ("MemPatch", c_void_p),
        ("PatchRestoreRange", c_void_p),
        ("PatchEnum", c_void_p),
        ("PatchRestore", c_void_p),
        ("PatchFile", c_void_p),
        ("ModPathFromAddr", c_void_p),
        ("ModPathFromName", c_void_p),
        ("DisasmFast", c_void_p),
        ("MemUpdateMap", c_void_p),
        ("GetCallStack", c_void_p),
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
    if IcedDecoder is not None and IcedFormatter is not None and FormatterSyntax is not None:
        data = read_memory(addr, 16)
        decoder = IcedDecoder(64 if IS_64BIT else 32, data, ip=addr)
        instr = decoder.decode()
        formatter = IcedFormatter(FormatterSyntax.INTEL)
        disasm_text = formatter.format(instr).strip()
        parts = disasm_text.split(None, 1)
        mnemonic = parts[0] if parts else ""
        operands = parts[1] if len(parts) > 1 else ""
        return {
            "addr": addr,
            "size": instr.len if instr.len > 0 else 1,
            "mnemonic": mnemonic,
            "operands": operands,
            "is_call": mnemonic.startswith("call"),
            "is_branch": mnemonic.startswith("j") or mnemonic in {"call", "ret", "iret", "syscall", "sysret"},
        }

    basic = BASIC_INSTRUCTION_INFO()
    fn_fast = _b().DbgDisasmFastAt
    fn_fast.argtypes = [duint, POINTER(BASIC_INSTRUCTION_INFO)]
    fn_fast.restype = None
    fn_fast(duint(addr), byref(basic))

    instr = DISASM_INSTR()
    fn_full = _b().DbgDisasmAt
    fn_full.argtypes = [duint, POINTER(DISASM_INSTR)]
    fn_full.restype = None
    fn_full(duint(addr), byref(instr))

    disasm_text = bytes(instr.instruction).split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()
    parts = disasm_text.split(None, 1)
    mnemonic = parts[0] if parts else ""
    operands = parts[1] if len(parts) > 1 else ""

    return {
        "addr": addr,
        "size": instr.instr_size if instr.instr_size > 0 else (basic.size if basic.size > 0 else 1),
        "mnemonic": mnemonic,
        "operands": operands,
        "is_call": bool(basic.call),
        "is_branch": bool(basic.branch),
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


def _get_process_id() -> int:
    h_process = _get_process_handle()
    if not h_process:
        raise RuntimeError("No process handle — is a process being debugged?")

    fn = windll.kernel32.GetProcessId
    fn.argtypes = [c_void_p]
    fn.restype = wt.DWORD
    pid = int(fn(c_void_p(h_process)))
    if not pid:
        err = windll.kernel32.GetLastError()
        raise RuntimeError(f"GetProcessId failed: error {err}")
    return pid


def _get_entrypoint_from_disk(file_path: str, module_base: int) -> int:
    try:
        with open(file_path, "rb") as fh:
            header = fh.read(4096)
    except OSError:
        return 0

    if len(header) < 0x40 or header[:2] != b"MZ":
        return 0

    try:
        pe_offset = struct.unpack_from("<I", header, 0x3C)[0]
        if pe_offset + 0x2C > len(header) or header[pe_offset:pe_offset + 4] != b"PE\x00\x00":
            return 0
        opt_start = pe_offset + 24
        entry_rva = struct.unpack_from("<I", header, opt_start + 16)[0]
        return module_base + entry_rva if entry_rva else 0
    except struct.error:
        return 0


def get_module_list() -> list[dict]:
    """Get list of loaded modules using Windows Toolhelp APIs.

    This avoids DbgGetModuleList/DbgMemMap ctypes calls, which can destabilize
    the 32-bit bridge on some targets during early loader states.
    """
    pid = _get_process_id()

    create_snapshot = windll.kernel32.CreateToolhelp32Snapshot
    create_snapshot.argtypes = [wt.DWORD, wt.DWORD]
    create_snapshot.restype = c_void_p

    module_first = windll.kernel32.Module32FirstW
    module_first.argtypes = [c_void_p, POINTER(MODULEENTRY32W)]
    module_first.restype = c_int

    module_next = windll.kernel32.Module32NextW
    module_next.argtypes = [c_void_p, POINTER(MODULEENTRY32W)]
    module_next.restype = c_int

    close_handle = windll.kernel32.CloseHandle
    close_handle.argtypes = [c_void_p]
    close_handle.restype = c_int

    snapshot = create_snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if snapshot == INVALID_HANDLE_VALUE:
        err = windll.kernel32.GetLastError()
        raise RuntimeError(f"CreateToolhelp32Snapshot failed: error {err}")

    result = []
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(MODULEENTRY32W)
        ok = module_first(snapshot, byref(entry))
        while ok:
            base = cast(entry.modBaseAddr, c_void_p).value or 0
            path = entry.szExePath
            result.append({
                "name": entry.szModule,
                "base": base,
                "size": int(entry.modBaseSize),
                "entry": _get_entrypoint_from_disk(path, base) if path else 0,
                "path": path,
            })
            ok = module_next(snapshot, byref(entry))
    finally:
        close_handle(snapshot)

    return result


def get_breakpoint_list() -> list[dict]:
    """Get all breakpoints."""
    fn = _b().DbgGetBpList
    fn.argtypes = [c_int, POINTER(BPMAP)]
    fn.restype = c_int  # Win32 BOOL
    result = []
    seen: set[tuple[int, int]] = set()

    for bp_type in (bp_normal, bp_hardware, bp_memory, bp_dll, bp_exception):
        bp_list = BPMAP()
        fn(bp_type, byref(bp_list))
        for i in range(bp_list.count):
            bp = bp_list.bp[i]
            key = (int(bp.addr), int(bp.type))
            if key in seen:
                continue
            seen.add(key)
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
    fn = _b().DbgFunctions
    fn.restype = POINTER(DBGFUNCTIONS_PARTIAL)
    dbgfuncs = fn()
    if not dbgfuncs or not dbgfuncs.contents.GetCallStack:
        raise RuntimeError("DbgFunctions()->GetCallStack unavailable")

    get_call_stack = ctypes.CFUNCTYPE(None, POINTER(CALLSTACK))(dbgfuncs.contents.GetCallStack)
    get_call_stack(byref(cs))

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
            "id": t.BasicInfo.ThreadId,
            "number": t.BasicInfo.ThreadNumber,
            "entry": t.BasicInfo.ThreadStartAddress,
            "teb": t.BasicInfo.ThreadLocalBase,
            "name": t.BasicInfo.threadName.decode("utf-8", errors="replace"),
        })

    current = tl.CurrentThread
    if tl.list:
        _b().BridgeFree(tl.list)

    current_thread_id = 0
    if 0 <= current < len(threads):
        current_thread_id = int(threads[current]["id"])

    return {
        "threads": threads,
        "currentThread": current,
        "currentThreadId": current_thread_id,
    }


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
