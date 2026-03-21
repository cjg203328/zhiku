$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

param(
  [string]$PythonCommand = 'python'
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$apiRoot = Join-Path $repoRoot 'services\api'

Write-Host '==> Installing local ASR runtime (faster-whisper)' -ForegroundColor Cyan
Set-Location $apiRoot

& $PythonCommand -m pip install -e '.[asr-local]'

Write-Host "`n==> Checking local ASR runtime" -ForegroundColor Cyan
Set-Location $repoRoot
& $PythonCommand 'scripts\qa\check_local_asr.py'

Write-Host "`nNext step:" -ForegroundColor Green
Write-Host '1. Open Settings -> 音频转写 -> 本地转写'
Write-Host '2. Set model to tiny / base / small according to your speed-vs-quality target'
Write-Host '3. Re-run B站预检 or directly import the BV link'
