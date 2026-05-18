$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$tokenFile = Join-Path $root "data\collector-token.txt"
$logDir = Join-Path $root "logs"
$latest = Join-Path $logDir "backfill-latest.json"
$log = Join-Path $logDir "backfill.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-BackfillLog {
  param([string]$Message)
  Add-Content -Path $log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

if (-not (Test-Path $tokenFile)) {
  Write-BackfillLog "missing collector token file: $tokenFile"
  exit 1
}

$token = (Get-Content -Raw -Path $tokenFile).Trim()
if (-not $token) {
  Write-BackfillLog "collector token file is empty"
  exit 1
}

$uri = "http://127.0.0.1:3080/api/backfill?days=180&limit=500&token=$token"

Write-BackfillLog "starting backfill"

& "$env:SystemRoot\System32\curl.exe" --silent --show-error --fail --max-time 540 --output "$latest" "$uri"
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
  Write-BackfillLog "completed backfill; response: $latest"
} else {
  Write-BackfillLog "backfill failed with exit code $exitCode"
}

exit $exitCode
