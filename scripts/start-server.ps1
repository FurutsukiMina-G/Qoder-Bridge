$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scheduled = Get-ScheduledTask -TaskName 'QoderBridge-8646' -ErrorAction SilentlyContinue
if ($scheduled) {
    if ($scheduled.Actions[0].WorkingDirectory -ne $root -or $scheduled.Actions[0].Arguments -notlike '*dist/src/main.js serve*') { throw 'The registered task is not this QoderBridge installation.' }
    if ($scheduled.State -ne 'Running') { Start-ScheduledTask -TaskName 'QoderBridge-8646' }
    Write-Output 'QoderBridge scheduled task is running; wait for /health after SDK warm-up.'
    exit 0
}
$pidFile = Join-Path $root '.runtime\server-8646.pid'
if (Test-Path -LiteralPath $pidFile) {
    $storedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$storedPid" -ErrorAction SilentlyContinue
    if ($existing -and $existing.ExecutablePath -eq (Get-Command node.exe).Source -and $existing.CommandLine -like '*dist/src/main.js serve --port 8646*') {
        Write-Output "QoderBridge already running (PID $storedPid)."
        exit 0
    }
}
$nodeExe = (Get-Command node.exe).Source
$stdout = Join-Path $root 'reports\bridge-server.out.log'
$stderr = Join-Path $root 'reports\bridge-server.err.log'
New-Item -ItemType Directory -Path (Join-Path $root '.runtime'), (Join-Path $root 'reports') -Force | Out-Null
$process = Start-Process -FilePath $nodeExe -ArgumentList @('dist/src/main.js', 'serve', '--port', '8646', '--session-settings', 'config/thin-cn.json', '--timeout', '300000') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id
Write-Output "Started QoderBridge (PID $($process.Id)); waiting for Qoder SDK warm-up."
