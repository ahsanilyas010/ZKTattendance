<#
  Installs the agent on the on-site Windows PC so it starts at boot and restarts if it stops.
  No third-party service wrapper is needed: it uses Windows Task Scheduler.

  1. Install Python 3.10+ from python.org (tick "Add python.exe to PATH").
  2. Copy this whole agent folder to the PC, copy agent.toml.example to agent.toml and fill it in.
  3. Right-click PowerShell > Run as administrator, then:
         cd path\to\agent
         powershell -ExecutionPolicy Bypass -File .\install\windows\install-service.ps1
#>
$ErrorActionPreference = 'Stop'
$src  = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$dest = 'C:\zkagent'

if (-not (Test-Path (Join-Path $src 'agent.toml'))) { throw 'agent.toml not found. Copy agent.toml.example to agent.toml and fill in cloud_url and api_key.' }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python was not found. Install Python 3.10 or newer and tick "Add python.exe to PATH".' }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
python -m venv "$dest\venv"
& "$dest\venv\Scripts\pip.exe" install --quiet "$src"
Copy-Item (Join-Path $src 'agent.toml') "$dest\agent.toml" -Force
# Only administrators and the system account may read the key.
icacls "$dest\agent.toml" /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null

Write-Host 'Checking the cloud connection and your terminal(s)...'
& "$dest\venv\Scripts\python.exe" -m zkagent check -c "$dest\agent.toml"
if ($LASTEXITCODE -ne 0) { throw 'The check found a problem (see above). Fix it and run this script again.' }

$action   = New-ScheduledTaskAction -Execute "$dest\venv\Scripts\pythonw.exe" -Argument "-m zkagent run -c `"$dest\agent.toml`"" -WorkingDirectory $dest
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Unregister-ScheduledTask -TaskName 'ZKAttendanceAgent' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'ZKAttendanceAgent' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
Start-ScheduledTask -TaskName 'ZKAttendanceAgent'
Write-Host "Done. The agent is running and will start automatically with Windows. Log: $dest\data\agent.log"
