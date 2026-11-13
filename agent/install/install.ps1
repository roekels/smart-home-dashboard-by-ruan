# Installs edge-agent on Windows as a service under its own virtual account, NT SERVICE\edge-agent.
# Run in an elevated PowerShell:
#
#   .\install.ps1 [-Binary .\edge-agent.exe]   install or update, then start it if the machine is enrolled
#   .\install.ps1 -Remove                         stop and delete the service and the program (keeps key + settings)
#   .\install.ps1 -Remove -Purge                  also delete C:\ProgramData\edge-agent (revoke it in the dashboard)
#
# What the service may do: read stats with plain Windows calls, and shut down the
# PC. It is not SYSTEM, not an admin and not the logged-in user. Its folder is readable only by itself and
# Administrators.
[CmdletBinding()]
param(
  [string]$Binary = (Join-Path $PSScriptRoot 'edge-agent.exe'),
  [switch]$Remove,
  [switch]$Purge
)
$ErrorActionPreference = 'Stop'
$Name    = 'edge-agent'
$Account = "NT SERVICE\$Name"
$ProgDir = Join-Path $env:ProgramFiles $Name
$Exe     = Join-Path $ProgDir 'edge-agent.exe'
$Data    = Join-Path $env:ProgramData $Name

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in an elevated PowerShell (Run as administrator).' }

function Sc([string[]]$a) {
  & sc.exe @a | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe $($a -join ' ') failed with $LASTEXITCODE" }
}

# Adds or removes the account's SID on one user right with secedit (no extra modules needed).
function Set-UserRight([string]$Right, [string]$Sid, [bool]$Grant) {
  $tmp = Join-Path $env:TEMP "edge-agent-secpol-$PID"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $cfg = Join-Path $tmp 'cfg.inf'; $db = Join-Path $tmp 'secedit.sdb'
    & secedit.exe /export /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null
    $lines = Get-Content $cfg
    $line = $lines | Where-Object { $_ -match "^$Right\s*=" }
    $list = @()
    if ($line) { $list = ($line -split '=', 2)[1].Trim() -split ',' | Where-Object { $_ } | ForEach-Object { $_.Trim() } }
    $list = @($list | Where-Object { $_ -ne "*$Sid" })
    if ($Grant) { $list += "*$Sid" }
    $new = "$Right = " + ($list -join ',')
    if ($line) { $lines = $lines | ForEach-Object { if ($_ -match "^$Right\s*=") { $new } else { $_ } } }
    else { $lines = $lines | ForEach-Object { $_; if ($_ -eq '[Privilege Rights]') { $new } } }
    Set-Content -Path $cfg -Value $lines -Encoding Unicode
    & secedit.exe /configure /db $db /cfg $cfg /areas USER_RIGHTS /quiet | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "secedit failed with $LASTEXITCODE" }
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

function Get-ServiceSid {
  (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}

if ($Remove) {
  if (Get-Service $Name -ErrorAction SilentlyContinue) {
    $sid = Get-ServiceSid
    Stop-Service $Name -Force -ErrorAction SilentlyContinue
    Set-UserRight 'SeShutdownPrivilege' $sid $false
    Sc @('delete', $Name)
  }
  Remove-Item -Recurse -Force $ProgDir -ErrorAction SilentlyContinue
  if ($Purge) { Remove-Item -Recurse -Force $Data -ErrorAction SilentlyContinue; 'Removed the service, the program and its data. Revoke the agent in the dashboard.' }
  else { "Removed the service and the program. Key and settings stay in $Data." }
  return
}

if (-not (Test-Path $Binary)) { throw "binary not found: $Binary" }
$sig = Get-AuthenticodeSignature $Binary
if ($sig.Status -ne 'Valid') { Write-Warning "edge-agent.exe signature: $($sig.Status). Sign it with your own code-signing certificate (see agent/README.md)." }

# program files: Administrators write, everyone else (the service included) only reads
New-Item -ItemType Directory -Force -Path $ProgDir | Out-Null
$svc = Get-Service $Name -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service $Name -Force }
Copy-Item -Force $Binary $Exe

if (-not $svc) {
  # New-Service passes the quoted path as is (sc.exe quoting differs between PowerShell versions)
  New-Service -Name $Name -BinaryPathName "`"$Exe`" run" -DisplayName 'Home dashboard edge agent' -StartupType Automatic `
    -Description 'Pushes this PC''s stats to the home dashboard and runs its allowed commands. Outbound HTTPS only.' | Out-Null
}
# run as the service's own virtual account (no password)
$w = Get-CimInstance Win32_Service -Filter "Name='$Name'"
$r = Invoke-CimMethod -InputObject $w -MethodName Change -Arguments @{ StartName = $Account; StartPassword = '' }
if ($r.ReturnValue -ne 0) { throw "could not set the service account ($($r.ReturnValue))" }
Sc @('config', $Name, 'start=', 'delayed-auto')
Sc @('sidtype', $Name, 'unrestricted')
Sc @('privs', $Name, 'SeChangeNotifyPrivilege/SeShutdownPrivilege')
Sc @('failure', $Name, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000')

$sid = Get-ServiceSid
Set-UserRight 'SeShutdownPrivilege' $sid $true

# data folder: only the service account, SYSTEM and Administrators; no inheritance from ProgramData
New-Item -ItemType Directory -Force -Path $Data | Out-Null
& icacls.exe $Data /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*$($sid):(OI)(CI)M" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed with $LASTEXITCODE" }

if (-not (Test-Path (Join-Path $Data 'agent.json'))) {
  "Installed $Exe"
  'Next: add this computer in the dashboard (Settings > Edge agents), then in this elevated window run:'
  "  & '$Exe' enrol --server https://<your dashboard> --id ag_<name> --code <code>"
  'and run this script again to start the service.'
  return
}
Start-Service $Name
"Started $Name. Check it with: & '$Exe' status"
