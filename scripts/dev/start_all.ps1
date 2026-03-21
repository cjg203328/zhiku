$apiScript = Join-Path $PSScriptRoot 'start_api.ps1'
$desktopPath = Join-Path (Split-Path $PSScriptRoot -Parent) '..\apps\desktop'

Write-Host "启动知库本地开发环境..."
Write-Host "1) 先启动 API sidecar"
Start-Process powershell -ArgumentList @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $apiScript)

Write-Host "2) 再启动桌面端前端/Tauri"
Write-Host "请在新终端进入 $desktopPath 后执行："
Write-Host "npm install"
Write-Host "npm run tauri:dev"
