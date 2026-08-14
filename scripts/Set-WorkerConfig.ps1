<#
.SYNOPSIS
    Reads, changes, and verifies one Server 2 worker's systemd environment.

.DESCRIPTION
    Production has one configuration source per process. Primary reads
    /etc/linebot/worker.env and ShardB reads /etc/linebot/worker-shard-b.env.
    Release-local .env files are deliberately unsupported because both units
    share /opt/linebot/current/backend and start Bun with --no-env-file.

    Show uses the unprivileged linebot key and reads the selected unit's real
    process environment. Set needs a privileged key because /etc/linebot is
    root-owned. A timestamped backup is kept beside the selected env file.

.PARAMETER Worker
    Primary (linebot-worker) or ShardB (linebot-worker-shard-b).

.PARAMETER Show
    Print the selected worker's env-file values and live process values.

.PARAMETER Set
    One or more KEY=VALUE pairs. Values are not printed.

.PARAMETER PrivilegedUser
    Server 2 account that can replace the selected /etc/linebot env file.

.PARAMETER PrivilegedKey
    Private key for PrivilegedUser. Required with Set.

.PARAMETER Restart
    Restart only the selected worker and verify every requested value in its
    real process environment. This drops that worker's LINE sessions.

.EXAMPLE
    .\scripts\Set-WorkerConfig.ps1 -Worker ShardB -Show

.EXAMPLE
    .\scripts\Set-WorkerConfig.ps1 -Worker ShardB -Set SQUARE_FAST_POLL_INTERVAL_MS=50,SQUARE_FAST_POLL_ALLOW_50MS=1 -PrivilegedKey C:\keys\root.pem -Restart
#>
[CmdletBinding(DefaultParameterSetName = 'Show')]
param(
    [Parameter(ParameterSetName = 'Show')]
    [switch]$Show,

    [Parameter(ParameterSetName = 'Set', Mandatory)]
    [string[]]$Set,

    [ValidateSet('Primary', 'ShardB')]
    [string]$Worker = 'Primary',

    [Parameter(ParameterSetName = 'Set')]
    [string]$PrivilegedUser = 'root',

    [Parameter(ParameterSetName = 'Set')]
    [string]$PrivilegedKey,

    [Parameter(ParameterSetName = 'Set')]
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$Gateway     = 'admin@3.112.61.130'
$TargetIp    = '10.77.0.2'
$ServiceUser = 'linebot'
$TrackedKeys = 'WORKER_ID|WORKER_OWNER_SCOPE|WORKER_OWNER_EXCLUDE|WORKER_OWNER_ROUTES|CONTROL_PLANE_URL|CONTROL_PLANE_TOKEN|LINE_H2_LANES|LINE_H2_SEND_RESERVED_LANES|SQUARE_FAST_POLL_MAX_ROOMS|SQUARE_FAST_POLL_WORKERS|SQUARE_FAST_POLL_INTERVAL_MS|SQUARE_FAST_POLL_ALLOW_50MS'
$TopologyKeys = '^(WORKER_ID|WORKER_OWNER_SCOPE|WORKER_OWNER_EXCLUDE|WORKER_OWNER_ROUTES|CONTROL_PLANE_URL|CONTROL_PLANE_TOKEN|PORT|DISPATCH_ADDR)$'

if ($Worker -eq 'ShardB') {
    $Unit = 'linebot-worker-shard-b'
    $SystemEnvFile = '/etc/linebot/worker-shard-b.env'
} else {
    $Unit = 'linebot-worker'
    $SystemEnvFile = '/etc/linebot/worker.env'
}

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$SourceKey = Join-Path $RepoRoot 'maxpc.pem'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok  ($m) { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Write-Dim ($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Fail      ($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

function Get-StagedKey([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) { Fail "key not found: $Path" }
    $dir = [System.IO.Path]::GetTempPath()
    if ($dir -match '\s') {
        $dir = Join-Path $env:SystemDrive '.linebot-tmp'
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
    $staged = Join-Path $dir $Name
    if (Test-Path -LiteralPath $staged) {
        & icacls.exe $staged /grant "$($env:USERNAME):(F)" | Out-Null
    }
    Copy-Item -LiteralPath $Path -Destination $staged -Force
    & icacls.exe $staged /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
    return ($staged -replace '\\', '/')
}

function Invoke-OnWorker {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$KeyPath,
        [string]$User = $ServiceUser
    )
    $jump = "ssh -i $KeyPath -W ${TargetIp}:22 $Gateway"
    $payload = ($Command -replace "`r`n", "`n")
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload))
    $out = & ssh.exe -i $KeyPath `
        -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes `
        -o ProxyCommand=$jump "$User@$TargetIp" "echo $encoded | base64 -d | bash" 2>&1
    return [pscustomobject]@{ Output = ($out -join "`n"); ExitCode = $LASTEXITCODE }
}

function Get-WorkerState([string]$KeyPath) {
    $cmd = @"
set -e
pid=`$(systemctl show -p MainPID --value $Unit 2>/dev/null || echo 0)
echo "PID=`${pid:-0}"
echo '--PROCENV--'
if [ "`${pid:-0}" -gt 0 ] && [ -r "/proc/`$pid/environ" ]; then
  tr '\0' '\n' < "/proc/`$pid/environ" | grep -E '^($TrackedKeys)=' | sort | sed -E 's/^(CONTROL_PLANE_TOKEN)=.*/\1=***/' || true
fi
echo '--SYSTEM_ENV--'
[ -r $SystemEnvFile ] && grep -E '^($TrackedKeys)=' $SystemEnvFile | sort | sed -E 's/^(CONTROL_PLANE_TOKEN)=.*/\1=***/' || true
echo '--IGNORED_RELEASE_ENV--'
[ -e /opt/linebot/current/backend/.env ] && echo present || echo absent
"@
    $r = Invoke-OnWorker -Command $cmd -KeyPath $KeyPath
    if ($r.ExitCode -ne 0) { Fail "cannot inspect ${Unit}:`n$($r.Output)" }

    $lines = $r.Output -split "`n" | ForEach-Object { $_.TrimEnd("`r") }
    $section = ''
    $state = [ordered]@{ Pid = 0; ProcEnv = @(); SystemEnv = @(); IgnoredReleaseEnv = 'absent' }
    foreach ($line in $lines) {
        switch -Regex ($line) {
            '^PID=(\d+)$'                { $state.Pid = [long]$Matches[1]; continue }
            '^--PROCENV--$'              { $section = 'ProcEnv'; continue }
            '^--SYSTEM_ENV--$'           { $section = 'SystemEnv'; continue }
            '^--IGNORED_RELEASE_ENV--$'  { $section = 'IgnoredReleaseEnv'; continue }
            default {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                if ($section -eq 'IgnoredReleaseEnv') { $state.IgnoredReleaseEnv = $line }
                elseif ($section) { $state[$section] += $line }
            }
        }
    }
    return $state
}

function Show-State($state) {
    Write-Step "$Worker configuration ($Unit)"
    Write-Dim "source of truth: $SystemEnvFile"
    if ($state.Pid -gt 0) {
        Write-Ok "live PID: $($state.Pid)"
    } else {
        Write-Warn 'service is not running'
    }
    if ($state.ProcEnv.Count) {
        Write-Ok 'live process values:'
        $state.ProcEnv | ForEach-Object { Write-Ok "  $_" }
    } else {
        Write-Dim 'live process values: (none of the tracked keys)'
    }
    if ($state.SystemEnv.Count) {
        Write-Ok 'env-file values:'
        $state.SystemEnv | ForEach-Object { Write-Ok "  $_" }
    } else {
        Write-Dim 'env-file values: (none of the tracked keys)'
    }
    if ($state.IgnoredReleaseEnv -eq 'present') {
        Write-Warn '/opt/linebot/current/backend/.env exists but is ignored by --no-env-file; remove it during a controlled cleanup.'
    }
    Write-Dim 'safe fast-poll default: 100ms; 50ms requires INTERVAL_MS=50 and ALLOW_50MS=1'
}

$serviceKey = Get-StagedKey -Path $SourceKey -Name 'linebot-worker-key.pem'

if ($PSCmdlet.ParameterSetName -eq 'Show') {
    Show-State (Get-WorkerState $serviceKey)
    exit 0
}

if (-not $PrivilegedKey) {
    Fail "Set writes $SystemEnvFile and needs -PrivilegedKey"
}

$encodedPairs = @()
$changedKeys = @()
foreach ($pair in $Set) {
    if ($pair -match "[`r`n]") {
        Fail "not a single-line KEY=VALUE pair: '$pair'"
    }
    if ($pair -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=') {
        Fail "not a KEY=VALUE pair: '$pair'"
    }
    $key = $Matches[1]
    if ($key -match $TopologyKeys) {
        Fail "$key is a coupled topology setting; use setup-shard-b.sh so both services change atomically"
    }
    $changedKeys += $key
    $encodedPairs += [pscustomobject]@{
        Key = $key
        Value = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($pair))
        PlainValue = ($pair -split '=', 2)[1]
    }
}
if (($changedKeys | Select-Object -Unique).Count -ne $changedKeys.Count) {
    Fail 'the same key was supplied more than once'
}

$before = Get-WorkerState $serviceKey
Show-State $before
Write-Host ''

function Get-ConfiguredValue([string]$Key, [string]$Default) {
    $line = $before.SystemEnv | Where-Object { $_ -match "^$([Regex]::Escape($Key))=" } | Select-Object -Last 1
    if ($null -eq $line) { return $Default }
    return ($line -split '=', 2)[1]
}

# Avoid a configuration that looks like 50ms in /proc but is clamped to 100ms
# at runtime. The pair is one opt-in operation on shard B and is never allowed
# on the multi-bot primary.
$desiredInterval = Get-ConfiguredValue 'SQUARE_FAST_POLL_INTERVAL_MS' '100'
$desiredFastGate = Get-ConfiguredValue 'SQUARE_FAST_POLL_ALLOW_50MS' '0'
foreach ($item in $encodedPairs) {
    if ($item.Key -eq 'SQUARE_FAST_POLL_INTERVAL_MS') { $desiredInterval = $item.PlainValue }
    if ($item.Key -eq 'SQUARE_FAST_POLL_ALLOW_50MS') { $desiredFastGate = $item.PlainValue }
}
if ($Worker -eq 'Primary' -and $desiredFastGate -eq '1') {
    Fail 'SQUARE_FAST_POLL_ALLOW_50MS=1 is reserved for an isolated shard; keep the primary at 100ms with no gate'
}
if ($Worker -eq 'ShardB' -and $desiredFastGate -eq '1' -and $desiredInterval -ne '50') {
    Fail 'ShardB ALLOW_50MS=1 requires SQUARE_FAST_POLL_INTERVAL_MS=50 in the same final config'
}
if ($Worker -eq 'ShardB' -and $desiredInterval -eq '50' -and $desiredFastGate -ne '1') {
    Fail 'ShardB INTERVAL_MS=50 requires SQUARE_FAST_POLL_ALLOW_50MS=1 in the same final config'
}

Write-Step "writing $($changedKeys -join ', ') to $SystemEnvFile (values hidden)"

$editLines = @(
    'set -euo pipefail'
    "target='$SystemEnvFile'"
    '[ -f "$target" ]'
    'tmp=$(mktemp "${target}.tmp.XXXXXX")'
    'trap ''rm -f -- "$tmp"'' EXIT'
    'cp -- "$target" "$tmp"'
    'cp -a -- "$target" "${target}.bak.$(date +%Y%m%d-%H%M%S)"'
)
foreach ($item in $encodedPairs) {
    $editLines += "sed -i -E '/^[[:space:]]*$($item.Key)=/d' `"`$tmp`""
    $editLines += "printf '%s' '$($item.Value)' | base64 -d >> `"`$tmp`""
    $editLines += "printf '\n' >> `"`$tmp`""
}
$editLines += @(
    'install -o root -g linebot -m 640 "$tmp" "$target"'
    'rm -f -- "$tmp"'
    'trap - EXIT'
    "echo 'UPDATED:$($changedKeys -join ',')'"
)
$privKey = Get-StagedKey -Path $PrivilegedKey -Name 'linebot-privileged-key.pem'
$r = Invoke-OnWorker -Command ($editLines -join "`n") -KeyPath $privKey -User $PrivilegedUser
if ($r.ExitCode -ne 0) { Fail "the edit failed:`n$($r.Output)" }
Write-Ok 'written atomically; a timestamped backup was kept beside the env file'

if (-not $Restart) {
    Write-Warn 'not restarted, so the selected worker is still running its old config'
    Write-Warn "rerun with -Worker $Worker and -Restart when ready"
    exit 0
}

Write-Host ''
Write-Step "restarting $Unit"
Write-Warn 'this drops only the selected worker sessions'
$r = Invoke-OnWorker -Command "sudo -n /usr/bin/systemctl restart $Unit" -KeyPath $serviceKey
if ($r.ExitCode -ne 0) { Fail "restart failed:`n$($r.Output)" }
Start-Sleep -Seconds 6

$verifyLines = @(
    'set -euo pipefail'
    "pid=`$(systemctl show -p MainPID --value $Unit)"
    '[ "$pid" -gt 0 ]'
)
foreach ($item in $encodedPairs) {
    $verifyLines += "expected=`$(printf '%s' '$($item.Value)' | base64 -d)"
    $verifyLines += "if tr '\0' '\n' < `"/proc/`$pid/environ`" | grep -Fqx -- `"`$expected`"; then echo 'VERIFIED:$($item.Key)'; else echo 'MISSING:$($item.Key)'; fi"
}
$r = Invoke-OnWorker -Command ($verifyLines -join "`n") -KeyPath $serviceKey
if ($r.ExitCode -ne 0 -or $r.Output -match 'MISSING:') {
    Fail "one or more values are not live (values remain hidden):`n$($r.Output)"
}

Show-State (Get-WorkerState $serviceKey)
Write-Host ''
Write-Ok "all requested values are live in $Unit"
$measurementWorker = if ($Worker -eq 'ShardB') { 'shard-b' } else { 'primary' }
Write-Dim "measure this worker with: bash scripts/ab-latency.sh --worker $measurementWorker config"
