<#
  Copy old ImageFlow photos from Google Drive (ACE folder) into SharePoint and check them in.

  First run downloads portable Node + rclone (no admin) into %LOCALAPPDATA%\AceDriveToSharePoint
  and opens the browser once for a read-only Google sign-in.

  Examples:
    .\Copy-Drive-To-SharePoint.ps1                          # dry run summary, then asks to start
    .\Copy-Drive-To-SharePoint.ps1 --only "V2X"             # one customer folder only
    .\Copy-Drive-To-SharePoint.ps1 --dry-run                # plan only, copy nothing
    .\Copy-Drive-To-SharePoint.ps1 --folder "<Drive folder link>"   # use a different root folder
    .\Copy-Drive-To-SharePoint.ps1 --reset-google           # sign in to Google again
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Home_ = Join-Path $env:LOCALAPPDATA "AceDriveToSharePoint"
$Tools = Join-Path $Home_ "tools"
$RcloneConf = Join-Path $Home_ "rclone.conf"
$Remote = "acedrive"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
New-Item -ItemType Directory -Force -Path $Tools | Out-Null

function Get-Zip($url, $dest) {
  $zip = Join-Path $env:TEMP ([IO.Path]::GetFileName($url))
  Write-Host "Downloading $url ..."
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP ("ace-unzip-" + [guid]::NewGuid())
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp | Select-Object -First 1
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item $inner.FullName $dest
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$Node = Join-Path $Tools "node\node.exe"
if (-not (Test-Path $Node)) {
  $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
  $v = ($index | Where-Object { $_.version -like "v20.*" } | Select-Object -First 1).version
  Get-Zip "https://nodejs.org/dist/$v/node-$v-win-x64.zip" (Join-Path $Tools "node")
}

$Runner = Join-Path $Tools "runner"
$Tsx = Join-Path $Runner "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $Tsx)) {
  Write-Host "Installing the TypeScript runner (tsx)..."
  New-Item -ItemType Directory -Force -Path $Runner | Out-Null
  $env:Path = (Join-Path $Tools "node") + ";" + $env:Path
  & (Join-Path $Tools "node\npm.cmd") install --prefix $Runner --no-audit --no-fund --loglevel=error tsx@4 | Out-Null
  if (-not (Test-Path $Tsx)) { throw "Could not install tsx." }
}

$Rclone = Join-Path $Tools "rclone\rclone.exe"
if (-not (Test-Path $Rclone)) {
  Get-Zip "https://downloads.rclone.org/rclone-current-windows-amd64.zip" (Join-Path $Tools "rclone")
}

$argv = @($args)
if ($argv -contains "--reset-google") {
  & $Rclone --config $RcloneConf config delete $Remote 2>$null
  $argv = $argv | Where-Object { $_ -ne "--reset-google" }
}

$remotes = & $Rclone --config $RcloneConf listremotes 2>$null
if ($remotes -notcontains "${Remote}:") {
  Write-Host ""
  Write-Host "A browser window will open. Sign in with the Google account that can see the ACE folder"
  Write-Host "('Shared with me' > ACE) and click Allow. Access is read-only."
  Write-Host ""
  & $Rclone --config $RcloneConf config create $Remote drive scope=drive.readonly | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Google sign-in did not finish. Run this again." }
}

$env:ACE_RCLONE = $Rclone
$env:ACE_RCLONE_CONF = $RcloneConf
$env:ACE_RCLONE_REMOTE = $Remote
$env:ACE_TOOL_HOME = $Home_

Push-Location $RepoRoot
try {
  & $Node $Tsx (Join-Path $PSScriptRoot "migrate.ts") @argv
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $code
