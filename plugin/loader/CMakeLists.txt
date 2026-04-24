cmake_minimum_required(VERSION 3.15)
project(x64dbg_mcp_loader C)

set(CMAKE_C_STANDARD 11)

# ── Options ──────────────────────────────────────────────────────────────
option(BUILD_32BIT "Build 32-bit plugin (.dp32)" OFF)
option(X64DBG_SDK_DIR "Path to x64dbg Plugin SDK" "")

# ── Source ───────────────────────────────────────────────────────────────
add_library(x64dbg_mcp_loader SHARED x64dbg_mcp_loader.c)

# ── x64dbg SDK include (optional — loader has minimal SDK definitions) ──
if(X64DBG_SDK_DIR)
    target_include_directories(x64dbg_mcp_loader PRIVATE "${X64DBG_SDK_DIR}")
endif()

# ── Link x64dbg bridge DLL ──────────────────────────────────────────────
# The plugin needs to link against x64bridge.lib / x32bridge.lib
# These are found in the x64dbg SDK or release directory.
if(X64DBG_SDK_DIR)
    if(BUILD_32BIT)
        target_link_directories(x64dbg_mcp_loader PRIVATE "${X64DBG_SDK_DIR}/x32")
        target_link_libraries(x64dbg_mcp_loader PRIVATE x32bridge x32dbg)
    else()
        target_link_directories(x64dbg_mcp_loader PRIVATE "${X64DBG_SDK_DIR}/x64")
        target_link_libraries(x64dbg_mcp_loader PRIVATE x64bridge x64dbg)
    endif()
endif()

# ── Output name / extension ─────────────────────────────────────────────
if(BUILD_32BIT)
    set_target_properties(x64dbg_mcp_loader PROPERTIES
        SUFFIX ".dp32"
        PREFIX ""
    )
else()
    set_target_properties(x64dbg_mcp_loader PROPERTIES
        SUFFIX ".dp64"
        PREFIX ""
    )
endif()

# ── Definitions ─────────────────────────────────────────────────────────
target_compile_definitions(x64dbg_mcp_loader PRIVATE
    _CRT_SECURE_NO_WARNINGS
    WIN32_LEAN_AND_MEAN
)

# ── Install ─────────────────────────────────────────────────────────────
install(TARGETS x64dbg_mcp_loader DESTINATION plugins)
