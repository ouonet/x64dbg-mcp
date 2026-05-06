# Run test_attach.mjs with admin privileges
# This script elevates the current PowerShell session and runs the test

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "Requesting admin privileges..."
    Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -Command `"cd '$scriptDir'; & node .\\test_attach.mjs`"" -Verb RunAs -Wait
} else {
    Write-Host "Running with admin privileges..."
    Set-Location $scriptDir
    node .\test_attach.mjs
}
