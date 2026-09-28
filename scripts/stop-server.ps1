$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scheduled = Get-ScheduledTask -TaskName 'QoderBridge-8646' -ErrorAction SilentlyContinue
if ($scheduled) {
    if ($scheduled.Actions[0].WorkingDirectory -ne $root -or $scheduled.Actions[0].Arguments -notlike '*dist/src/main.js serve*') { throw 'The registered task is not this QoderBridge installation.' }
    if ($scheduled.State -eq 'Running') { Stop-ScheduledTask -TaskName 'QoderBridge-8646' }
    Write-Output 'Stopped the QoderBridge scheduled task.'
    exit 0
}
$pidFile = Join-Path $root '.runtime\server-8646.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No QoderBridge PID file.'; exit 0 }
$storedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$storedPid" -ErrorAction SilentlyContinue
if ($process) {
    if ($process.ExecutablePath -ne (Get-Command node.exe).Source -or $process.CommandLine -notlike '*dist/src/main.js serve --port 8646*') { throw "PID $storedPid is not the expected QoderBridge process; refusing to stop it." }
    Stop-Process -Id $storedPid
}
Remove-Item -LiteralPath $pidFile
Write-Output "Stopped QoderBridge PID $storedPid."
