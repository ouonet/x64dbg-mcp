<#
.SYNOPSIS
    Build the x64dbg-mcp C loader plugin and deploy all plugin files to x64dbg.

.DESCRIPTION
    1. Compiles plugin/loader with CMake (x64 + x32 by default).
    2. Copies .dp64 / .dp32 loader and Python bridge files to
       <x64dbg>/release/x64/plugins/ and /x32/plugins/.

.PARAMETER X64dbgPath
    Path to x64dbg installation directory.  Defaults to X64DBG_PATH env var,
    then ./x64dbg, then C:\x64dbg.

.PARAMETER NoBuild
    Skip CMake compilation; only copy already-built artifacts.

.PARAMETER No32
    Skip the 32-bit build and install (x64 only).

.EXAMPLE
    .\scripts\install-plugin.ps1
    .\scripts\install-plugin.ps1 -X64dbgPath "C:\Tools\x64dbg"
    .\scripts\install-plugin.ps1 -No32
#>
param(
    [string]$X64dbgPath = "",
    [switch]$NoBuild    = $false,
    [switch]$No32       = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── colour helpers ────────────────────────────────────────────────────────────
function Write-Ok   ([string]$msg) { Write-Host "  [OK]  $msg" -ForegroundColor Green  }
function Write-Fail ([string]$msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red    }
function Write-Info ([string]$msg) { Write-Host "  $msg"        -ForegroundColor Cyan   }
function Write-Warn ([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

# ── resolve x64dbg path ───────────────────────────────────────────────────────
if (-not $X64dbgPath) {
    $X64dbgPath = $env:X64DBG_PATH
}
if (-not $X64dbgPath -or -not (Test-Path $X64dbgPath)) {
    $candidates = @(
        (Join-Path $PSScriptRoot "..\x64dbg"),
        "C:\x64dbg",
        "C:\Program Files\x64dbg",
        "C:\Tools\x64dbg"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $X64dbgPath = $c; break }
    }
}
if (-not $X64dbgPath -or -not (Test-Path $X64dbgPath)) {
    Write-Fail "x64dbg not found. Set X64DBG_PATH or pass -X64dbgPath <dir>."
    exit 1
}
$X64dbgPath = (Resolve-Path $X64dbgPath).Path
Write-Ok "x64dbg path: $X64dbgPath"

$loaderDir  = Join-Path $PSScriptRoot "..\plugin\loader"
$loaderDir  = (Resolve-Path $loaderDir).Path
$pluginDir  = Join-Path $PSScriptRoot "..\plugin"
$pluginDir  = (Resolve-Path $pluginDir).Path

$pluginsX64 = Join-Path $X64dbgPath "release\x64\plugins"
$pluginsX32 = Join-Path $X64dbgPath "release\x32\plugins"

# ── build ─────────────────────────────────────────────────────────────────────
if (-not $NoBuild) {
    Write-Host "`nBuilding C loader plugin...`n" -ForegroundColor White

    # Check CMake
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
        Write-Fail "CMake not found. Install from https://cmake.org or use -NoBuild to skip compilation."
        exit 1
    }

    # 64-bit
    Write-Info "Configuring x64 build..."
    cmake -B "$loaderDir\build64" -A x64 -S $loaderDir -DCMAKE_BUILD_TYPE=Release | Out-Null
    Write-Info "Building x64..."
    cmake --build "$loaderDir\build64" --config Release
    $dp64 = "$loaderDir\build64\Release\x64dbg_mcp_loader.dp64"
    if (Test-Path $dp64) { Write-Ok "Built: $dp64" }
    else { Write-Fail "Build failed — .dp64 not found at $dp64"; exit 1 }

    # 32-bit (default; skip with -No32)
    if (-not $No32) {
        Write-Info "Configuring x32 build..."
        cmake -B "$loaderDir\build32" -A Win32 -S $loaderDir -DBUILD_32BIT=ON -DCMAKE_BUILD_TYPE=Release | Out-Null
        Write-Info "Building x32..."
        cmake --build "$loaderDir\build32" --config Release
        $dp32 = "$loaderDir\build32\Release\x64dbg_mcp_loader.dp32"
        if (Test-Path $dp32) { Write-Ok "Built: $dp32" }
        else { Write-Warn ".dp32 not found — 32-bit install will be skipped" }
    }
} else {
    Write-Warn "Skipping build (-NoBuild)"
}

# ── install x64 ───────────────────────────────────────────────────────────────
Write-Host "`nInstalling x64 plugin files...`n" -ForegroundColor White

if (-not (Test-Path $pluginsX64)) {
    New-Item -ItemType Directory -Path $pluginsX64 -Force | Out-Null
    Write-Info "Created plugins directory: $pluginsX64"
}

$dp64 = "$loaderDir\build64\Release\x64dbg_mcp_loader.dp64"
if (Test-Path $dp64) {
    Copy-Item $dp64 $pluginsX64 -Force
    Write-Ok "Installed: $(Join-Path $pluginsX64 'x64dbg_mcp_loader.dp64')"
} else {
    Write-Warn "x64dbg_mcp_loader.dp64 not found — skipping (run without -NoBuild to compile)"
}

foreach ($py in @("x64dbg_mcp_bridge.py", "x64dbg_bridge_sdk.py")) {
    $src = Join-Path $pluginDir $py
    if (Test-Path $src) {
        Copy-Item $src $pluginsX64 -Force
        Write-Ok "Installed: $(Join-Path $pluginsX64 $py)"
    } else {
        Write-Fail "Source file not found: $src"
        exit 1
    }
}

# ── install x32 ──────────────────────────────────────────────────────────────
if (-not $No32) {
    Write-Host "`nInstalling x32 plugin files...`n" -ForegroundColor White

    if (-not (Test-Path $pluginsX32)) {
        New-Item -ItemType Directory -Path $pluginsX32 -Force | Out-Null
        Write-Info "Created plugins directory: $pluginsX32"
    }

    $dp32 = "$loaderDir\build32\Release\x64dbg_mcp_loader.dp32"
    if (Test-Path $dp32) {
        Copy-Item $dp32 $pluginsX32 -Force
        Write-Ok "Installed: $(Join-Path $pluginsX32 'x64dbg_mcp_loader.dp32')"
    }

    foreach ($py in @("x64dbg_mcp_bridge.py", "x64dbg_bridge_sdk.py")) {
        $src = Join-Path $pluginDir $py
        Copy-Item $src $pluginsX32 -Force
        Write-Ok "Installed: $(Join-Path $pluginsX32 $py)"
    }
}

# ── done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Plugin installation complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Start (or restart) x64dbg — the loader will auto-start the bridge."
Write-Host "  2. Run: npm run doctor    (verify everything is working)"
Write-Host "  3. Run: npm start         (start the MCP server)"
Write-Host ""
