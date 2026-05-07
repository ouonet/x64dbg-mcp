$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$tempExeName = "mcppsmoke.exe"
$tempExePath = Join-Path $env:TEMP $tempExeName

Set-Location $repoRoot

$proc = $null
$hadTargetExe = Test-Path Env:TARGET_EXE
$oldTargetExe = if ($hadTargetExe) { $env:TARGET_EXE } else { $null }
$hadTargetPid = Test-Path Env:TARGET_PID
$oldTargetPid = if ($hadTargetPid) { $env:TARGET_PID } else { $null }
$hadTargetProcessName = Test-Path Env:TARGET_PROCESS_NAME
$oldTargetProcessName = if ($hadTargetProcessName) { $env:TARGET_PROCESS_NAME } else { $null }

try {
    Write-Host "Preparing uniquely named cmd.exe copy for TARGET_PROCESS_NAME smoke test..."
    Copy-Item "$env:WINDIR\System32\cmd.exe" $tempExePath -Force

    Write-Host "Starting $tempExeName /k for HTTP attach smoke test..."
    $proc = Start-Process $tempExePath -ArgumentList "/k" -PassThru

    $actualProcessName = $null
    for ($i = 0; $i -lt 40; $i++) {
        $liveProc = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if ($liveProc) {
            $actualProcessName = $liveProc.ProcessName
            break
        }
        Start-Sleep -Milliseconds 250
    }

    if (-not $actualProcessName) {
        throw "Could not resolve process name for launched temporary cmd.exe copy."
    }

    $env:TARGET_PROCESS_NAME = $actualProcessName
    Remove-Item Env:TARGET_EXE -ErrorAction SilentlyContinue
    Remove-Item Env:TARGET_PID -ErrorAction SilentlyContinue

    Write-Host "Running HTTP smoke test with TARGET_PROCESS_NAME=$actualProcessName..."
    node .\scripts\manual\test_http_transport.mjs
}
finally {
    if ($hadTargetExe) {
        $env:TARGET_EXE = $oldTargetExe
    } else {
        Remove-Item Env:TARGET_EXE -ErrorAction SilentlyContinue
    }

    if ($hadTargetPid) {
        $env:TARGET_PID = $oldTargetPid
    } else {
        Remove-Item Env:TARGET_PID -ErrorAction SilentlyContinue
    }

    if ($hadTargetProcessName) {
        $env:TARGET_PROCESS_NAME = $oldTargetProcessName
    } else {
        Remove-Item Env:TARGET_PROCESS_NAME -ErrorAction SilentlyContinue
    }

    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }

    Remove-Item $tempExePath -ErrorAction SilentlyContinue
}