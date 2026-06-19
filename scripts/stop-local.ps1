param(
  [int]$Port = 8888
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$RuntimeDir = Join-Path $Root '.runtime'
$PidFile = Join-Path $RuntimeDir 'kikoeru.pid'

function Write-Step($Message) {
  Write-Host "[kikoeru] $Message"
}

$stopped = $false

if (Test-Path $PidFile) {
  $pidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($pidText -match '^\d+$') {
    $process = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($process) {
      Write-Step "Stop PID $pidText"
      Stop-Process -Id ([int]$pidText)
      $stopped = $true
    }
  }
}

try {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
} catch {
  $listeners = @()
}

foreach ($listener in $listeners) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') {
    Write-Step "Stop Node PID $($listener.OwningProcess) on port $Port"
    Stop-Process -Id $listener.OwningProcess
    $stopped = $true
  }
}

if (Test-Path $PidFile) {
  Remove-Item -LiteralPath $PidFile -Force
}

if ($stopped) {
  Write-Step "Stopped"
} else {
  Write-Step "No running local Kikoeru service was found"
}
