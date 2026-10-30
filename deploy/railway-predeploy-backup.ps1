[CmdletBinding()]
param(
  [string]$ProjectId = "a7e458bf-8f9c-41b7-8440-72988cc75d7f",
  [string]$Service = "jarvis-telegram",
  [string]$Environment = "production"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $root "migration-backups"
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$downloadDirectory = Join-Path $backupRoot "data-$timestamp"
$recordPath = Join-Path $backupRoot "previous-deployment-id.txt"
$manifestPath = Join-Path $backupRoot "migration-manifest.json"

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

# Linking is local CLI context only. It does not deploy or change service variables.
& railway link --project $ProjectId --service $Service --environment $Environment --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Railway project linking failed." }

$deploymentJson = & railway deployment list --service $Service --environment $Environment --json --limit 20
if ($LASTEXITCODE -ne 0) { throw "Could not read Railway deployment history." }
$deployments = @($deploymentJson | ConvertFrom-Json)
$previous = $deployments | Where-Object { $_.status -eq "SUCCESS" } | Select-Object -First 1
if (-not $previous -or -not $previous.id) { throw "No successful Railway deployment was found." }
Set-Content -NoNewline -Encoding utf8 -Path $recordPath -Value $previous.id

& railway volume files download / $downloadDirectory
if ($LASTEXITCODE -ne 0) { throw "Railway volume download failed." }
$downloadedFiles = @(Get-ChildItem -LiteralPath $downloadDirectory -Recurse -File)
if ($downloadedFiles.Count -eq 0) { throw "The downloaded volume backup is empty." }

$fileManifest = foreach ($file in $downloadedFiles) {
  $relative = [System.IO.Path]::GetRelativePath($downloadDirectory, $file.FullName)
  [ordered]@{
    path = $relative.Replace("\\", "/")
    bytes = $file.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  }
}

$manifest = [ordered]@{
  capturedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
  projectId = $ProjectId
  service = $Service
  environment = $Environment
  previousDeploymentId = $previous.id
  backupDirectory = Split-Path -Leaf $downloadDirectory
  files = $fileManifest
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -Path $manifestPath

Write-Host "RAILWAY_BACKUP_OK deployment=$($previous.id) files=$($downloadedFiles.Count)"
Write-Host "Keep migration-backups/ outside version control and do not deploy until it is stored safely."
