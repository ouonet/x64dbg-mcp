/**
 * x64dbg MCP Loader Plugin
 * ========================
 * Minimal x64dbg plugin that embeds Python 3.10+ and runs the MCP bridge.
 * Replaces x64dbgpy with a modern Python 3 approach (ctypes).
 *
 * Build:
 *   - For 32-bit: produces x64dbg_mcp_loader.dp32
 *   - For 64-bit: produces x64dbg_mcp_loader.dp64
 *
 * Requirements:
 *   - Python 3.10+ installed (with python3.dll and python310.dll etc.)
 *   - x64dbg Plugin SDK headers (pluginsdk/)
 *   - CMake 3.15+ or Visual Studio
 */

#include <windows.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --------------------------------------------------------------------------
 * x64dbg Plugin SDK minimal definitions
 * If you have the full SDK, replace this section with:
 *   #include "pluginsdk/bridgemain.h"
 *   #include "pluginsdk/_plugins.h"
 * -------------------------------------------------------------------------- */

#ifndef PLUG_SDKVERSION
#define PLUG_SDKVERSION 1

typedef int duint;

/* Plugin info filled during pluginit */
typedef struct {
    int pluginHandle;
    int sdkVersion;
    int pluginVersion;
    char pluginName[256];
} PLUG_INITSTRUCT;

typedef struct {
    HWND hwndDlg;
    int hMenu;
    int hMenuDisasm;
    int hMenuDump;
    int hMenuStack;
    int hMenuGraph;
    int hMenuMemmap;
    int hMenuSymmod;
} PLUG_SETUPSTRUCT;

/* _plugin_logprintf resolved at runtime to avoid link dependency on x64dbg */
typedef void (__cdecl *plugin_logprintf_t)(const char* format, ...);
static plugin_logprintf_t p_plugin_logprintf = NULL;

#endif /* PLUG_SDKVERSION */

/* --------------------------------------------------------------------------
 * Python 3 Embedding (Stable ABI via python3.dll)
 * We use LoadLibrary + GetProcAddress to avoid compile-time Python dependency.
 * -------------------------------------------------------------------------- */

/* Python C API function pointers */
typedef void  (*Py_InitializeEx_t)(int);
typedef int   (*Py_IsInitialized_t)(void);
typedef void  (*Py_Finalize_t)(void);
typedef int   (*PyRun_SimpleString_t)(const char*);
typedef int   (*PyRun_SimpleFile_t)(FILE*, const char*);
typedef void  (*PySys_SetArgvEx_t)(int, wchar_t**, int);
typedef void* (*PyGILState_Ensure_t)(void);
typedef void  (*PyGILState_Release_t)(void*);
typedef void* (*PyEval_SaveThread_t)(void);
typedef void  (*PyEval_RestoreThread_t)(void*);

static Py_InitializeEx_t    pPy_InitializeEx    = NULL;
static Py_IsInitialized_t   pPy_IsInitialized   = NULL;
static Py_Finalize_t        pPy_Finalize        = NULL;
static PyRun_SimpleString_t pPyRun_SimpleString = NULL;
static PyRun_SimpleFile_t   pPyRun_SimpleFile   = NULL;
static PySys_SetArgvEx_t    pPySys_SetArgvEx    = NULL;
static PyGILState_Ensure_t  pPyGILState_Ensure  = NULL;
static PyGILState_Release_t pPyGILState_Release = NULL;
static PyEval_SaveThread_t  pPyEval_SaveThread  = NULL;
static PyEval_RestoreThread_t pPyEval_RestoreThread = NULL;
static void* gilSaveState = NULL;  /* saved thread state after releasing GIL */

static HMODULE hPython = NULL;
static BOOL    pythonReady = FALSE;
static char    pluginDir[MAX_PATH] = {0};
static int     plugHandle = 0;

/* -------------------------------------------------------------------------- */

static void resolveLogFunc(void) {
    if (p_plugin_logprintf) return;
    /* Try x64dbg.dll first (64-bit), then x32dbg.dll (32-bit) */
    HMODULE hDbg = GetModuleHandleA("x64dbg.dll");
    if (!hDbg) hDbg = GetModuleHandleA("x32dbg.dll");
    if (hDbg) {
        p_plugin_logprintf = (plugin_logprintf_t)GetProcAddress(hDbg, "_plugin_logprintf");
    }
}

static void logMsg(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    resolveLogFunc();
    if (p_plugin_logprintf) {
        p_plugin_logprintf("[MCP Loader] %s\n", buf);
    } else {
        OutputDebugStringA("[MCP Loader] ");
        OutputDebugStringA(buf);
        OutputDebugStringA("\n");
    }
}

/* Debug file logger -- writes directly to a file for diagnostics */
static void debugFileLog(const char* msg) {
    char logPath[MAX_PATH];
    HMODULE hSelf = GetModuleHandleA("x64dbg_mcp_loader.dp32");
    if (!hSelf) hSelf = GetModuleHandleA("x64dbg_mcp_loader.dp64");
    if (hSelf) {
        GetModuleFileNameA(hSelf, logPath, MAX_PATH);
        char* s = strrchr(logPath, '\\');
        if (s) *s = '\0';
    } else {
        GetModuleFileNameA(NULL, logPath, MAX_PATH);
        char* s = strrchr(logPath, '\\');
        if (s) *s = '\0';
    }
    strncat(logPath, "\\mcp_loader_debug.log", MAX_PATH - strlen(logPath) - 1);
    FILE* f = fopen(logPath, "a");
    if (f) { fprintf(f, "%s\n", msg); fclose(f); }
}

/* --------------------------------------------------------------------------
 * Load Python DLL from a given directory.
 * Adds the directory to the DLL search path, then tries the versioned DLL
 * (e.g. python314.dll) first, then the stable-ABI stub (python3.dll).
 * -------------------------------------------------------------------------- */
static BOOL loadPythonFromDir(const char* dir) {
    char dllPath[MAX_PATH];
    char msg[MAX_PATH + 64];

    /* Extend DLL search path so transitive dependencies resolve */
    wchar_t wDir[MAX_PATH];
    MultiByteToWideChar(CP_ACP, 0, dir, -1, wDir, MAX_PATH);
    AddDllDirectory(wDir);

    /* Scan for highest versioned pythonXY.dll */
    WIN32_FIND_DATAA fd;
    char searchPat[MAX_PATH];
    char bestDll[MAX_PATH] = {0};
    int  bestVer = 0;
    snprintf(searchPat, MAX_PATH, "%s\\python3*.dll", dir);
    HANDLE hFind = FindFirstFileA(searchPat, &fd);
    if (hFind != INVALID_HANDLE_VALUE) {
        do {
            const char* name = fd.cFileName;
            if (_stricmp(name, "python3.dll") == 0) continue;
            int ver = 0;
            if (_strnicmp(name, "python3", 7) == 0) ver = atoi(name + 7);
            if (ver > bestVer) {
                bestVer = ver;
                snprintf(bestDll, MAX_PATH, "%s\\%s", dir, name);
            }
        } while (FindNextFileA(hFind, &fd));
        FindClose(hFind);
    }

    if (bestDll[0] != '\0') {
        hPython = LoadLibraryA(bestDll);
        if (hPython) {
            snprintf(msg, sizeof(msg), "loadPythonFromDir: loaded %s", bestDll);
            debugFileLog(msg);
            return TRUE;
        }
    }

    /* Fallback: stable-ABI stub */
    snprintf(dllPath, MAX_PATH, "%s\\python3.dll", dir);
    hPython = LoadLibraryA(dllPath);
    if (hPython) {
        snprintf(msg, sizeof(msg), "loadPythonFromDir: loaded python3.dll from %s", dir);
        debugFileLog(msg);
        return TRUE;
    }

    snprintf(msg, sizeof(msg), "loadPythonFromDir: nothing loaded from %s", dir);
    debugFileLog(msg);
    return FALSE;
}

/* Try to load Python DLL.
 *
 * Priority order:
 *   1. PYTHON_HOME_X64 / PYTHON_HOME_X86  (arch-specific, explicit path)
 *   2. PYTHON_HOME                         (generic fallback)
 *   3. Scan plugin dir                     (legacy / embedded layout)
 *   4. PATH / system default               (python3.dll already on PATH)
 *   5. Hard-coded common install paths
 */
static BOOL loadPython(void) {
    char dllPath[MAX_PATH];

    /* Add plugin dir to DLL search so .pyd extension modules there are found */
    if (pluginDir[0] != '\0') {
        wchar_t wPluginDir[MAX_PATH];
        MultiByteToWideChar(CP_ACP, 0, pluginDir, -1, wPluginDir, MAX_PATH);
        AddDllDirectory(wPluginDir);
    }

    /* Strategy 1: arch-specific env var (highest priority — no DLL copy needed)
     *   PYTHON_HOME_X64  e.g. C:\Python314
     *   PYTHON_HOME_X86  e.g. C:\Python312-32
     * Set via .env / system environment before launching x64dbg.            */
#ifdef _WIN64
    const char* archEnvVar = "PYTHON_HOME_X64";
#else
    const char* archEnvVar = "PYTHON_HOME_X86";
#endif
    const char* archEnvPath = getenv(archEnvVar);
    if (!hPython && archEnvPath && archEnvPath[0] != '\0') {
        char msg[MAX_PATH + 64];
        snprintf(msg, sizeof(msg), "loadPython: trying %s = %s", archEnvVar, archEnvPath);
        debugFileLog(msg);
        if (loadPythonFromDir(archEnvPath)) {
            snprintf(msg, sizeof(msg), "loadPython: SUCCESS via %s", archEnvVar);
            debugFileLog(msg);
        }
    }

    /* Strategy 2: generic PYTHON_HOME fallback */
    const char* envPath = getenv("PYTHON_HOME");
    if (!hPython && envPath && envPath[0] != '\0') {
        debugFileLog("loadPython: trying PYTHON_HOME");
        loadPythonFromDir(envPath);
    }

    /* Strategy 3: scan plugin dir for any pythonXXX.dll (highest version first) */
    if (!hPython && pluginDir[0] != '\0') {
        WIN32_FIND_DATAA fd;
        HANDLE hFind;
        char searchPat[MAX_PATH];
        /* Track best candidate: prefer higher version numbers */
        char bestDll[MAX_PATH] = {0};
        int  bestVer = 0;

        snprintf(searchPat, MAX_PATH, "%s\\python3*.dll", pluginDir);
        hFind = FindFirstFileA(searchPat, &fd);
        if (hFind != INVALID_HANDLE_VALUE) {
            do {
                const char* name = fd.cFileName;
                /* Skip python3.dll stable-ABI stub -- we need the full DLL */
                if (_stricmp(name, "python3.dll") == 0) continue;
                /* Extract version digits, e.g. python314.dll -> 314 */
                int ver = 0;
                if (_strnicmp(name, "python3", 7) == 0) {
                    ver = atoi(name + 7);
                }
                if (ver > bestVer) {
                    bestVer = ver;
                    snprintf(bestDll, MAX_PATH, "%s\\%s", pluginDir, name);
                }
            } while (FindNextFileA(hFind, &fd));
            FindClose(hFind);
        }

        if (bestDll[0] != '\0') {
            hPython = LoadLibraryA(bestDll);
            if (hPython) {
                snprintf(dllPath, MAX_PATH, "loadPython: loaded %s from plugin dir", bestDll);
                debugFileLog(dllPath);
            } else {
                err = GetLastError();
                snprintf(dllPath, MAX_PATH, "loadPython: %s failed (err=%lu)", bestDll, err);
                debugFileLog(dllPath);
            }
        }
    }

    /* Strategy 4: python3.dll from PATH / system (Python install dir on PATH) */
    if (!hPython) {
        hPython = LoadLibraryA("python3.dll");
        if (hPython) debugFileLog("loadPython: loaded python3.dll from PATH");
    }

    /* Strategy 5: hard-coded common install locations (last resort) */
    if (!hPython) {
        const char* locations[] = {
            "C:\\Python314\\python314.dll",
            "C:\\Python313\\python313.dll",
            "C:\\Python312\\python312.dll",
            "C:\\Python311\\python311.dll",
            "C:\\Python310\\python310.dll",
            NULL
        };
        for (int i = 0; locations[i]; i++) {
            hPython = LoadLibraryA(locations[i]);
            if (hPython) break;
        }
    }

    if (!hPython) {
        debugFileLog("loadPython: ALL strategies failed");
        logMsg("ERROR: Could not load python3.dll or python312.dll. "
               "Ensure Python 3.10+ is installed and on PATH or set PYTHON_HOME.");
        return FALSE;
    }

    /* Resolve function pointers */
    #define RESOLVE(name) \
        p##name = (name##_t)GetProcAddress(hPython, #name); \
        if (!p##name) { logMsg("ERROR: Failed to resolve " #name); return FALSE; }

    RESOLVE(Py_InitializeEx);
    RESOLVE(Py_IsInitialized);
    RESOLVE(Py_Finalize);
    RESOLVE(PyRun_SimpleString);
    /* PyRun_SimpleFile may not exist in stable ABI -- we use SimpleString */
    pPyRun_SimpleFile = (PyRun_SimpleFile_t)GetProcAddress(hPython, "PyRun_SimpleFileExFlags");

    /* These are optional */
    pPySys_SetArgvEx = (PySys_SetArgvEx_t)GetProcAddress(hPython, "PySys_SetArgvEx");
    pPyGILState_Ensure = (PyGILState_Ensure_t)GetProcAddress(hPython, "PyGILState_Ensure");
    pPyGILState_Release = (PyGILState_Release_t)GetProcAddress(hPython, "PyGILState_Release");
    pPyEval_SaveThread = (PyEval_SaveThread_t)GetProcAddress(hPython, "PyEval_SaveThread");
    pPyEval_RestoreThread = (PyEval_RestoreThread_t)GetProcAddress(hPython, "PyEval_RestoreThread");

    #undef RESOLVE
    return TRUE;
}

static BOOL initPython(void) {
    if (pPy_IsInitialized && pPy_IsInitialized()) {
        logMsg("Python already initialized");
        pythonReady = TRUE;
        return TRUE;
    }

    pPy_InitializeEx(0);  /* 0 = don't register signal handlers */

    if (!pPy_IsInitialized()) {
        logMsg("ERROR: Py_InitializeEx failed");
        return FALSE;
    }

    pythonReady = TRUE;
    logMsg("Python 3 interpreter initialized");
    return TRUE;
}

/* Run the bridge script via PyRun_SimpleString with exec(open(...).read()) */
static BOOL startBridge(void) {
    char script[2048];
    char bridgePath[MAX_PATH];

    /* Build path to x64dbg_mcp_bridge.py */
    snprintf(bridgePath, MAX_PATH, "%s\\x64dbg_mcp_bridge.py", pluginDir);

    debugFileLog("startBridge: entered");
    debugFileLog(bridgePath);

    /* Check file exists */
    DWORD attr = GetFileAttributesA(bridgePath);
    if (attr == INVALID_FILE_ATTRIBUTES) {
        logMsg("ERROR: Bridge script not found at: %s", bridgePath);
        debugFileLog("startBridge: bridge script NOT FOUND");
        return FALSE;
    }
    debugFileLog("startBridge: bridge script exists");

    /* Escape backslashes for Python string */
    char escapedPath[MAX_PATH * 2];
    int j = 0;
    for (int i = 0; bridgePath[i] && j < (int)sizeof(escapedPath) - 2; i++) {
        if (bridgePath[i] == '\\') {
            escapedPath[j++] = '\\';
            escapedPath[j++] = '\\';
        } else {
            escapedPath[j++] = bridgePath[i];
        }
    }
    escapedPath[j] = '\0';

    /* Build escaped plugin dir path for error log */
    char escapedDir[MAX_PATH * 2];
    int k = 0;
    for (int i = 0; pluginDir[i] && k < (int)sizeof(escapedDir) - 2; i++) {
        if (pluginDir[i] == '\\') { escapedDir[k++] = '\\'; escapedDir[k++] = '\\'; }
        else escapedDir[k++] = pluginDir[i];
    }
    escapedDir[k] = '\0';

    snprintf(script, sizeof(script),
        "import threading, sys, os\n"
        "_plugin_dir = r\"%s\"\n"
        "if _plugin_dir not in sys.path:\n"
        "    sys.path.insert(0, _plugin_dir)\n"
        "def _mcp_loader_thread():\n"
        "    try:\n"
        "        import __main__\n"
        "        __main__.__file__ = r\"%s\"\n"
        "        with open(r\"%s\", \"r\", encoding=\"utf-8\") as _f:\n"
        "            exec(compile(_f.read(), r\"%s\", \"exec\"), vars(__main__))\n"
        "    except Exception as e:\n"
        "        import traceback\n"
        "        _tb = traceback.format_exc()\n"
        "        try:\n"
        "            with open(r\"%s\\\\mcp_bridge_error.log\", \"w\", encoding=\"utf-8\") as _ef:\n"
        "                _ef.write(_tb)\n"
        "        except Exception: pass\n"
        "_t = threading.Thread(target=_mcp_loader_thread, daemon=True)\n"
        "_t.start()\n",
        escapedDir, escapedPath, escapedPath, escapedPath, escapedDir
    );

    /* Redirect Python stdout/stderr to a log file for diagnostics */
    char redirectScript[1024];
    snprintf(redirectScript, sizeof(redirectScript),
        "import sys, io\n"
        "try:\n"
        "    _pylog = open(r\"%s\\mcp_python.log\", \"w\", encoding=\"utf-8\", buffering=1)\n"
        "    sys.stdout = _pylog\n"
        "    sys.stderr = _pylog\n"
        "except Exception: pass\n",
        pluginDir
    );
    pPyRun_SimpleString(redirectScript);

    debugFileLog("startBridge: executing PyRun_SimpleString");
    int rc = pPyRun_SimpleString(script);
    if (rc != 0) {
        logMsg("ERROR: Failed to execute bridge startup script");
        debugFileLog("startBridge: PyRun_SimpleString FAILED");
        return FALSE;
    }

    debugFileLog("startBridge: SUCCESS");
    logMsg("Bridge script launched in background thread");
    return TRUE;
}

/* --------------------------------------------------------------------------
 * x64dbg Plugin Exports
 * -------------------------------------------------------------------------- */

__declspec(dllexport) BOOL pluginit(PLUG_INITSTRUCT* initStruct) {
    debugFileLog("pluginit: entered");
    plugHandle = initStruct->pluginHandle;
    initStruct->sdkVersion = PLUG_SDKVERSION;
    initStruct->pluginVersion = 1;
    strncpy(initStruct->pluginName, "MCP Bridge (Python 3)", sizeof(initStruct->pluginName) - 1);

    /* Determine plugin directory */
    HMODULE hSelf = GetModuleHandleA("x64dbg_mcp_loader.dp64");
    if (!hSelf) hSelf = GetModuleHandleA("x64dbg_mcp_loader.dp32");
    if (hSelf) {
        GetModuleFileNameA(hSelf, pluginDir, MAX_PATH);
        debugFileLog("pluginit: found self module handle");
    } else {
        /* Last resort: use the executable directory + plugins subdir */
        GetModuleFileNameA(NULL, pluginDir, MAX_PATH);
        debugFileLog("pluginit: WARNING - self module handle not found, using exe path");
    }

    /* Strip filename to get directory */
    char* lastSlash = strrchr(pluginDir, '\\');
    if (lastSlash) *lastSlash = '\0';

    debugFileLog(pluginDir);
    logMsg("Plugin directory: %s", pluginDir);

    debugFileLog("pluginit: calling loadPython");
    if (!loadPython()) { debugFileLog("pluginit: loadPython FAILED"); return FALSE; }
    debugFileLog("pluginit: calling initPython");
    if (!initPython()) { debugFileLog("pluginit: initPython FAILED"); return FALSE; }

    debugFileLog("pluginit: SUCCESS");
    return TRUE;
}

__declspec(dllexport) void plugsetup(PLUG_SETUPSTRUCT* setupStruct) {
    (void)setupStruct;
    debugFileLog("plugsetup: entered");

    logMsg("Starting MCP bridge...");
    if (startBridge()) {
        logMsg("MCP Bridge ready. Connect your MCP server to the TCP port.");
    } else {
        logMsg("ERROR: Failed to start MCP bridge");
    }

    /* Release the GIL so Python background threads (the TCP server) can run.
     * The calling thread (x64dbg's main thread) does not need the GIL anymore.
     * We save the thread state so plugstop can restore it before calling Python. */
    if (pythonReady && pPyEval_SaveThread) {
        gilSaveState = pPyEval_SaveThread();
        debugFileLog("plugsetup: GIL released via PyEval_SaveThread");
    }
}

__declspec(dllexport) BOOL plugstop(void) {
    logMsg("Stopping MCP bridge...");

    /* Re-acquire the GIL before making Python calls */
    if (pythonReady && gilSaveState && pPyEval_RestoreThread) {
        pPyEval_RestoreThread(gilSaveState);
        gilSaveState = NULL;
        debugFileLog("plugstop: GIL re-acquired");
    }

    if (pythonReady && pPyRun_SimpleString) {
        pPyRun_SimpleString(
            "try:\n"
            "    from x64dbg_mcp_bridge import stop_bridge\n"
            "    stop_bridge()\n"
            "except: pass\n"
        );
    }

    if (pythonReady && pPy_Finalize) {
        /* Note: Py_Finalize can be problematic if threads are running.
           We rely on daemon threads being killed on process exit. */
        /* pPy_Finalize(); -- intentionally skipped for stability */
    }

    if (hPython) {
        FreeLibrary(hPython);
        hPython = NULL;
    }

    logMsg("Plugin stopped");
    return TRUE;
}

/* DLL entry point */
BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)hinstDLL;
    (void)lpvReserved;
    if (fdwReason == DLL_PROCESS_ATTACH) {
        debugFileLog("DllMain: DLL_PROCESS_ATTACH");
    }
    return TRUE;
}
