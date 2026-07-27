[CmdletBinding()]
param(
  [string]$LocalHostname = 'agentic-os-console.localhost',
  [string]$Distro = 'Ubuntu'
)

$ErrorActionPreference = 'Stop'

if ($LocalHostname -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$') {
  throw "Invalid local hostname: $LocalHostname"
}
if ($Distro -notmatch '^[a-zA-Z0-9._-]+$') {
  throw "Invalid WSL distro name: $Distro"
}

$startupDirectory = [Environment]::GetFolderPath('Startup')
$launcherPath = Join-Path $startupDirectory 'Agentic OS Console.vbs'
# WSL ignores systemd-only activity when deciding whether to idle-terminate.
# Keep one hidden, explicitly user-launched process attached to the distro.
$launcher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d $Distro --exec /bin/sleep infinity", 0, False
"@
Set-Content -LiteralPath $launcherPath -Encoding ascii -Value $launcher

function Get-KeepaliveProcess {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'wsl.exe' -and
      $_.CommandLine -like "*-d $Distro*" -and
      $_.CommandLine -like '*--exec /bin/sleep infinity*'
    })
}

$keepalive = Get-KeepaliveProcess
if ($keepalive.Count -eq 0) {
  & wscript.exe $launcherPath
  Start-Sleep -Seconds 1
  $keepalive = Get-KeepaliveProcess
}
if ($keepalive.Count -eq 0) {
  throw 'Startup launcher left no persistent WSL keepalive process.'
}

$responseJson = & curl.exe --fail --silent --show-error --max-time 15 "http://$LocalHostname/api/status"
if ($LASTEXITCODE -ne 0) {
  throw "curl.exe failed with exit code $LASTEXITCODE"
}
$response = $responseJson | ConvertFrom-Json
if ($response.status -ne 'ready' -or $response.localHostname -ne $LocalHostname) {
  throw "Unexpected console status response from http://$LocalHostname"
}

Write-Output "Startup launcher ready: $launcherPath"
Write-Output "Console ready: http://$LocalHostname"
