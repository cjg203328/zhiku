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

Write-Host '==> 启动本地网页原型'
Write-Host '==> 将在新窗口分别启动 API 和 Web'
if ($hasNonAsciiPath) {
  Write-Host '==> 检测到仓库路径包含非 ASCII 字符，Web 端将切换到稳定预览模式'
  Write-Host '==> 稳定预览模式将使用项目内置代理服务，不再依赖 vite preview'
  if (Test-Path $distIndex) {
    Write-Host '==> 检测到已有前端构建产物，本次将直接复用，避免后台构建卡住'
  } else {
    Write-Host '==> 尚未找到前端构建产物，将先执行一次 build 再启动预览'
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

Write-Host '==> 访问地址：http://127.0.0.1:4173'
