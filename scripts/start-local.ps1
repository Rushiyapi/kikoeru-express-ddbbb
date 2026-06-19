param(
  [int]$Port = 8888,
  [switch]$Foreground,
  [switch]$SkipInstall,
  [switch]$Reinstall,
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

$RuntimeDir = Join-Path $Root '.runtime'
$LogsDir = Join-Path $Root 'logs'
$NodeVersion = '14.21.3'
$NodeName = "node-v$NodeVersion-win-x64"
$NodeZip = Join-Path $RuntimeDir "$NodeName.zip"
$NodeDir = Join-Path $RuntimeDir $NodeName
$NodeExe = Join-Path $NodeDir 'node.exe'
$NpmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
$FrontendVersion = 'v0.6.2'
$FrontendArchiveName = "spa-$FrontendVersion.tar.gz"
$FrontendArchive = Join-Path $RuntimeDir $FrontendArchiveName
$PidFile = Join-Path $RuntimeDir 'kikoeru.pid'
$LockHashFile = Join-Path $RuntimeDir 'package-lock.sha256'

function Write-Step($Message) {
  Write-Host "[kikoeru] $Message"
}

function Open-KikoeruUi($Url) {
  if ($NoBrowser) {
    return
  }

  Write-Step "Open UI $Url"
  Start-Process $Url | Out-Null
}

function Get-LanUrls($ListenPort) {
  try {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.IPAddress -ne '0.0.0.0'
      } |
      Select-Object -ExpandProperty IPAddress -Unique)
  } catch {
    return @()
  }

  return @($addresses | ForEach-Object { 'http://{0}:{1}/' -f $_, $ListenPort })
}

function Write-LanAccessInfo($ListenPort) {
  $urls = @(Get-LanUrls $ListenPort)
  if ($urls.Count -eq 0) {
    Write-Step "LAN URL was not detected. Check your Wi-Fi IPv4 address and use http://<server-ip>:$ListenPort/"
    return
  }

  foreach ($url in $urls) {
    Write-Step "LAN URL for phone/tablet: $url"
  }
}

function Ensure-Directory($Path) {
  if (!(Test-Path $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Get-ListeningProcess($ListenPort) {
  try {
    return @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Download-File($Uri, $OutFile) {
  Write-Step "Download $Uri"
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -TimeoutSec 180
}

function Ensure-NodeRuntime {
  Ensure-Directory $RuntimeDir

  $SemverDir = Join-Path $NodeDir 'node_modules\npm\node_modules\semver'
  if ((Test-Path $NodeExe) -and (Test-Path $NpmCli) -and (Test-Path $SemverDir)) {
    Write-Step "Using project Node $NodeVersion"
    return
  }

  if (!(Test-Path $NodeZip)) {
    Download-File "https://nodejs.org/dist/v$NodeVersion/$NodeName.zip" $NodeZip
  }

  if (Test-Path $NodeDir) {
    Remove-Item -LiteralPath $NodeDir -Recurse -Force
  }

  Write-Step "Extract Node $NodeVersion"
  Expand-Archive -LiteralPath $NodeZip -DestinationPath $RuntimeDir -Force

  if (!(Test-Path $NodeExe) -or !(Test-Path $NpmCli)) {
    throw "Node runtime setup failed: $NodeDir"
  }
}

function Ensure-Dependencies {
  if ($SkipInstall) {
    Write-Step "Skip dependency check"
    return
  }

  $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root 'package-lock.json')).Hash
  $savedHash = if (Test-Path $LockHashFile) { Get-Content -LiteralPath $LockHashFile -Raw } else { '' }
  $sqliteBinding = Join-Path $Root 'node_modules\sqlite3\lib\binding\napi-v3-win32-x64\node_sqlite3.node'
  $requiredModules = @(
    'node_modules\dotenv',
    'node_modules\express',
    'node_modules\socket.io',
    'node_modules\knex',
    'node_modules\sqlite3'
  )
  $requiredModulesReady = $true
  foreach ($modulePath in $requiredModules) {
    if (!(Test-Path (Join-Path $Root $modulePath))) {
      $requiredModulesReady = $false
      break
    }
  }
  $nodeModulesReady = (Test-Path (Join-Path $Root 'node_modules')) -and (Test-Path $sqliteBinding) -and $requiredModulesReady

  if ($nodeModulesReady -and !$Reinstall) {
    Write-Step "Dependencies are ready"
    if (($savedHash.Trim() -ne '') -and ($savedHash.Trim() -ne $currentHash)) {
      Write-Step "package-lock.json changed. Run scripts\start-local.ps1 -Reinstall if dependencies need reinstalling."
    }
    return
  }

  if (!$nodeModulesReady) {
    Write-Step "node_modules is incomplete; dependencies need installing"
  } elseif ($Reinstall) {
    Write-Step "Reinstall requested"
  }

  Write-Step "Install dependencies with npm ci"
  & $NodeExe $NpmCli ci --scripts-prepend-node-path=true
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed"
  }
  Set-Content -LiteralPath $LockHashFile -Value $currentHash -Encoding ASCII
}

function Ensure-Frontend {
  $DistDir = Join-Path $Root 'dist'
  $IndexHtml = Join-Path $DistDir 'index.html'
  if (Test-Path $IndexHtml) {
    Write-Step "Frontend dist is ready"
    return
  }

  Ensure-Directory $RuntimeDir
  Ensure-Directory $DistDir

  if (!(Test-Path $FrontendArchive)) {
    Download-File "https://github.com/umonaca/kikoeru-quasar/releases/download/$FrontendVersion/$FrontendArchiveName" $FrontendArchive
  }

  $ExtractDir = Join-Path $RuntimeDir 'frontend-extract'
  if (Test-Path $ExtractDir) {
    Remove-Item -LiteralPath $ExtractDir -Recurse -Force
  }
  Ensure-Directory $ExtractDir

  Write-Step "Extract frontend $FrontendArchiveName"
  tar -xzf $FrontendArchive -C $ExtractDir

  $SpaDir = Join-Path $ExtractDir 'spa'
  if (Test-Path (Join-Path $SpaDir 'index.html')) {
    Copy-Item -LiteralPath (Join-Path $SpaDir '*') -Destination $DistDir -Recurse -Force
  } elseif (Test-Path (Join-Path $ExtractDir 'index.html')) {
    Copy-Item -LiteralPath (Join-Path $ExtractDir '*') -Destination $DistDir -Recurse -Force
  } else {
    throw "Frontend index.html was not found after extraction"
  }

  Remove-Item -LiteralPath $ExtractDir -Recurse -Force
  if (!(Test-Path $IndexHtml)) {
    throw "dist/index.html is still missing"
  }
}

function Start-Kikoeru {
  $baseUrl = 'http://localhost:{0}' -f $Port
  $listeners = @(Get-ListeningProcess $Port)
  if ($listeners.Count -gt 0) {
    $pids = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Write-Step "Port $Port is already listening. PID: $pids"
    Write-LanAccessInfo $Port
    Open-KikoeruUi $baseUrl
    return
  }

  Ensure-Directory $LogsDir
  $stdout = Join-Path $LogsDir 'kikoeru-start.log'
  $stderr = Join-Path $LogsDir 'kikoeru-start.err.log'

  if ($Foreground) {
    Write-Step "Start in foreground: $baseUrl"
    Write-LanAccessInfo $Port
    & $NodeExe 'app.js'
    return
  }

  Write-Step "Start service in background"
  $process = Start-Process -FilePath $NodeExe `
    -ArgumentList @('app.js') `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ASCII
  Start-Sleep -Seconds 2

  if ($process.HasExited) {
    Write-Host "stdout:"
    if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -Tail 80 }
    Write-Host "stderr:"
    if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Tail 80 }
    throw "Service exited immediately after startup"
  }

  $healthUrl = '{0}/api/health' -f $baseUrl
  $health = Invoke-WebRequest -UseBasicParsing $healthUrl -TimeoutSec 10
  if ($health.StatusCode -ne 200 -or $health.Content.Trim() -ne 'OK') {
    throw "Health check failed: HTTP $($health.StatusCode)"
  }

  Write-Step "Started successfully. PID: $($process.Id)"
  Write-LanAccessInfo $Port
  Open-KikoeruUi $baseUrl
}

Ensure-NodeRuntime
Ensure-Dependencies
Ensure-Frontend
Start-Kikoeru
