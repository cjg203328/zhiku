param(
  [switch]$Reload
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

$arguments = @(
  '-m', 'uvicorn',
  'zhiku_api.main:app',
  '--app-dir', 'services/api/src',
  '--host', '127.0.0.1',
  '--port', '38765'
)

if ($Reload) {
  $arguments += '--reload'
}

python @arguments
