param(
  [ValidateSet('auto', 'edge', 'chrome')]
  [string]$Browser = 'auto'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$extensionDir = Join-Path $repoRoot 'extensions\zhiku-bilibili-bridge'
$docsReleaseDir = Join-Path $repoRoot 'docs\release'

function Resolve-BrowserTarget {
  param([string]$Preferred)

  $candidates = @()
  switch ($Preferred) {
    'edge' {
      $candidates += @{
        Name = 'Microsoft Edge'
        Command = 'msedge.exe'
        Paths = @(
          'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
          'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
        )
        Url = 'edge://extensions/'
      }
    }
    'chrome' {
      $candidates += @{
        Name = 'Google Chrome'
        Command = 'chrome.exe'
        Paths = @(
          'C:\Program Files\Google\Chrome\Application\chrome.exe',
          'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
        )
        Url = 'chrome://extensions/'
      }
    }
    default {
      $candidates += @{
        Name = 'Microsoft Edge'
        Command = 'msedge.exe'
        Paths = @(
          'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
          'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
        )
        Url = 'edge://extensions/'
      }
      $candidates += @{
        Name = 'Google Chrome'
        Command = 'chrome.exe'
        Paths = @(
          'C:\Program Files\Google\Chrome\Application\chrome.exe',
          'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
        )
        Url = 'chrome://extensions/'
      }
    }
  }

  foreach ($candidate in $candidates) {
    $resolved = Get-Command $candidate.Command -ErrorAction SilentlyContinue
    if ($resolved) {
      return @{
        Name = $candidate.Name
        Launch = $resolved.Source
        Url = $candidate.Url
      }
    }

    foreach ($browserPath in $candidate.Paths) {
      if (Test-Path $browserPath) {
        return @{
          Name = $candidate.Name
          Launch = $browserPath
          Url = $candidate.Url
        }
      }
    }
  }

  return $null
}

if (-not (Test-Path $extensionDir)) {
  throw "Missing helper directory: $extensionDir"
}

$browserTarget = Resolve-BrowserTarget -Preferred $Browser

Write-Host ''
Write-Host '==> Zhiku Bilibili helper quick-open'
Write-Host "==> Extension folder: $extensionDir"
if (Test-Path $docsReleaseDir) {
  Write-Host "==> Release docs folder: $docsReleaseDir"
}

Start-Process explorer.exe $extensionDir

if (Test-Path $docsReleaseDir) {
  Start-Process explorer.exe $docsReleaseDir
}

if ($browserTarget -ne $null) {
  Write-Host "==> Opened extension page in $($browserTarget.Name)"
  Start-Process $browserTarget.Launch $browserTarget.Url
} else {
  Write-Host '==> Edge/Chrome not found. Open your browser extension page manually.'
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host '1. Turn on Developer mode in your browser extension page'
Write-Host '2. Click Load unpacked'
Write-Host '3. Select the zhiku-bilibili-bridge folder that just opened'
Write-Host ''
Write-Host 'Then open bilibili.com once and refresh Zhiku settings.'
