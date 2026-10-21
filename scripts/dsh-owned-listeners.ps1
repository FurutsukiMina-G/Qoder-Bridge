$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$allProcesses = @(Get-CimInstance Win32_Process)
$explicitEntry = if ($env:DSH_HOST_ENTRY) { $env:DSH_HOST_ENTRY.Replace('/', '\') } else { '' }
$hosts = @($allProcesses | Where-Object {
    $_.Name -in @('DeepSeek Harness.exe', 'node.exe') -and (
        $_.CommandLine -match '[/\\]@deepseek-ai[/\\]dsh-desktop-host[/\\]lib[/\\]index\.js' -or
        ($explicitEntry -and ([string]$_.CommandLine).Replace('/', '\') -like ('*' + [WildcardPattern]::Escape($explicitEntry) + '*'))
    )
})
$hostIds = @($hosts | ForEach-Object { [int]$_.ProcessId })
$neededIds = @($hostIds) + @($hosts | ForEach-Object { [int]$_.ParentProcessId })
$processes = @($allProcesses | Where-Object { [int]$_.ProcessId -in $neededIds } | ForEach-Object {
    [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; exe=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine }
})
$listeners = @()
if ($hostIds.Count -gt 0) {
    $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { [int]$_.OwningProcess -in $hostIds } | ForEach-Object {
        [pscustomobject]@{ pid=[int]$_.OwningProcess; address=[string]$_.LocalAddress; port=[int]$_.LocalPort }
    })
    # Do not combine a stale process snapshot with a port whose PID has since been reused.
    $stableIds = @($hosts | ForEach-Object {
        $candidate = $_
        $live = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$candidate.ProcessId)
        if ($live -and $live.CreationDate -eq $candidate.CreationDate) { [int]$candidate.ProcessId }
    })
    $listeners = @($listeners | Where-Object { $_.pid -in $stableIds })
}
@{ processes=$processes; listeners=$listeners } | ConvertTo-Json -Depth 4 -Compress
