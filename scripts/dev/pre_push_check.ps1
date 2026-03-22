$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$progressRoot = 'docs/product/'

Set-Location $repoRoot

$insideWorkTree = & git -c "safe.directory=$repoRoot" -c "core.quotepath=false" rev-parse --is-inside-work-tree 2>$null
if ($LASTEXITCODE -ne 0 -or ($insideWorkTree | Out-String).Trim() -ne 'true') {
  throw "Not a git repository: $repoRoot"
}

$branch = ((& git -c "safe.directory=$repoRoot" -c "core.quotepath=false" branch --show-current) | Out-String).Trim()
$statusLines = @(& git -c "safe.directory=$repoRoot" -c "core.quotepath=false" status --short)

Write-Host '==> Zhiku manual push check'
Write-Host "Repo: $repoRoot"
Write-Host "Branch: $branch"
Write-Host ''

if ($statusLines.Count -eq 0) {
  Write-Host 'Working tree is clean.'
  exit 0
}

$changedFiles = @()
foreach ($line in $statusLines) {
  if (-not $line) {
    continue
  }

  $text = $line.ToString()
  if ($text.Length -lt 4) {
    continue
  }

  $file = $text.Substring(3).Trim()
  if ($file.StartsWith('"') -and $file.EndsWith('"')) {
    $file = $file.Trim('"')
  }

  if ($file) {
    $changedFiles += $file.Replace('\', '/')
  }
}

$uniqueFiles = @($changedFiles | Sort-Object -Unique)
$progressTouched = $false
foreach ($item in $uniqueFiles) {
  if ($item.StartsWith($progressRoot)) {
    $progressTouched = $true
    break
  }
}

$nonProgressChanges = @($uniqueFiles | Where-Object { -not $_.StartsWith($progressRoot) })

Write-Host 'Changed files:'
$uniqueFiles | ForEach-Object { Write-Host " - $_" }
Write-Host ''

if ($nonProgressChanges.Count -gt 0 -and -not $progressTouched) {
  Write-Warning "Progress docs under $progressRoot were not updated"
} else {
  Write-Host 'Progress doc check: OK'
}

Write-Host ''
Write-Host 'Suggested manual workflow:'
Write-Host '1. Review the progress log under docs/product/'
Write-Host '2. git add -A'
Write-Host '3. git commit -m "your commit message"'
Write-Host "4. git push origin $branch"
