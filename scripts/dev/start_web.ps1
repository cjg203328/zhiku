$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$hasNonAsciiPath = $repoRoot -match '[^\u0000-\u007F]'
$distIndex = Join-Path $repoRoot 'apps\web\dist\index.html'
$apiCommand = "Set-Location '$repoRoot'; python -m uvicorn zhiku_api.main:app --app-dir services/api/src --host 127.0.0.1 --port 38765"

if ($hasNonAsciiPath) {
  if (Test-Path $distIndex) {
    $webCommand = "Set-Location '$repoRoot'; python .\scripts\dev\serve_web_preview.py --host 127.0.0.1 --port 4173 --api-base http://127.0.0.1:38765"
  } else {
    $webCommand = "Set-Location '$repoRoot'; npm.cmd run build:web; if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }; python .\scripts\dev\serve_web_preview.py --host 127.0.0.1 --port 4173 --api-base http://127.0.0.1:38765"
  }
} else {
  $webCommand = "Set-Location '$repoRoot'; npm.cmd run dev:web"
}

Write-Host '==> Starting local web preview'
Write-Host '==> API and Web will open in separate windows'
if ($hasNonAsciiPath) {
  Write-Host '==> Non-ASCII path detected, switching Web to stable preview mode'
  Write-Host '==> Stable preview uses the built-in proxy server instead of vite preview'
  if (Test-Path $distIndex) {
    Write-Host '==> Existing web build found, reusing it directly'
  } else {
    Write-Host '==> Web build not found, building once before preview starts'
  }
}

Start-Process powershell.exe -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  $apiCommand
)

Start-Process powershell.exe -ArgumentList @(
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  $webCommand
)

Write-Host '==> Open http://127.0.0.1:4173'
