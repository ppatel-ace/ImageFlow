# Probe Azure cert → Graph → SharePoint (GCC High) for Ace JobTravelerPhotos Access.
# Usage:
#   .\scripts\test-sharepoint-cert.ps1
#   .\scripts\test-sharepoint-cert.ps1 -UploadTest
#   .\scripts\test-sharepoint-cert.ps1 -SiteId "aceelectronics.sharepoint.us,{guid},{guid}"

param(
  [switch]$UploadTest,
  [string]$SiteId = $env:SHAREPOINT_SITE_ID
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pfxPath = Join-Path $root "certs\ace-jobtravelerphotos.pfx"
$pfxPassword = "temp-export-only"
$tenantId = "6ab850db-8359-47f8-9e46-ddb57a3f87bd"
$clientId = "9ae5ad08-419d-41fd-a1ef-b57f014d06ba"
$tokenUrl = "https://login.microsoftonline.us/$tenantId/oauth2/v2.0/token"
$graph = "https://graph.microsoft.us/v1.0"
$hostname = "aceelectronics.sharepoint.us"
$sitePath = "/sites/jobtravelerphotos"

function ConvertTo-Base64Url([byte[]]$bytes) {
  $b64 = [Convert]::ToBase64String($bytes)
  return ($b64.TrimEnd("=") -replace "\+", "-" -replace "/", "_")
}

Write-Host "=== 1) Load certificate ===" -ForegroundColor Cyan
if (-not (Test-Path $pfxPath)) { throw "Missing PFX: $pfxPath" }
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor `
         [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path $pfxPath), $pfxPassword, $flags)
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
if (-not $rsa) { throw "Could not load RSA private key from PFX" }
$x5tS256 = ConvertTo-Base64Url ([System.Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData))
Write-Host "Subject:    $($cert.Subject)"
Write-Host "Thumbprint: $($cert.Thumbprint)"
Write-Host "x5t#S256:   $x5tS256"

Write-Host "`n=== 2) Request access token (client assertion) ===" -ForegroundColor Cyan
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$headerJson = "{`"alg`":`"RS256`",`"typ`":`"JWT`",`"x5t#S256`":`"$x5tS256`"}"
$jti = [guid]::NewGuid().ToString()
$payloadJson = "{`"aud`":`"$tokenUrl`",`"iss`":`"$clientId`",`"sub`":`"$clientId`",`"jti`":`"$jti`",`"nbf`":$($now-60),`"exp`":$($now+600)}"
$header = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($headerJson))
$payload = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($payloadJson))
$data = "$header.$payload"
$sigBytes = $rsa.SignData([Text.Encoding]::ASCII.GetBytes($data), [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$assertion = "$data.$(ConvertTo-Base64Url $sigBytes)"

$body = @{
  grant_type            = "client_credentials"
  client_id             = $clientId
  scope                 = "https://graph.microsoft.us/.default"
  client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  client_assertion      = $assertion
}

try {
  $tokenRes = Invoke-RestMethod -Method POST -Uri $tokenUrl -ContentType "application/x-www-form-urlencoded" -Body $body
} catch {
  Write-Host "TOKEN FAILED. Typical causes:" -ForegroundColor Red
  Write-Host "  - .cer not uploaded to app registration yet"
  Write-Host "  - Graph API permission Sites.Selected missing / no admin consent"
  Write-Host $_.Exception.Message
  if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
  exit 1
}
$token = $tokenRes.access_token
Write-Host "Token OK (expires_in=$($tokenRes.expires_in))" -ForegroundColor Green

$headers = @{ Authorization = "Bearer $token" }

Write-Host "`n=== 3) Resolve site ===" -ForegroundColor Cyan
if (-not $SiteId) {
  $lookup = "$graph/sites/$([uri]::EscapeDataString($hostname)):$sitePath"
  Write-Host "Trying hostname lookup: $lookup"
  try {
    $site = Invoke-RestMethod -Method GET -Uri $lookup -Headers $headers
    $SiteId = $site.id
    Write-Host "Site OK: $($site.displayName)" -ForegroundColor Green
    Write-Host "SHAREPOINT_SITE_ID=$SiteId"
  } catch {
    Write-Host "Hostname lookup failed (common with Sites.Selected)." -ForegroundColor Yellow
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    Write-Host ""
    Write-Host "Get the site id while still connected with PnP, then re-run:" -ForegroundColor Yellow
    Write-Host '  (Get-PnPSite).Id'
    Write-Host '  # or Graph as admin: GET /sites/aceelectronics.sharepoint.us:/sites/jobtravelerphotos'
    Write-Host "  .\scripts\test-sharepoint-cert.ps1 -SiteId 'aceelectronics.sharepoint.us,{guid},{guid}'"
    exit 2
  }
} else {
  Write-Host "Using provided SiteId: $SiteId"
  $site = Invoke-RestMethod -Method GET -Uri "$graph/sites/$SiteId" -Headers $headers
  Write-Host "Site OK: $($site.displayName)" -ForegroundColor Green
}

Write-Host "`n=== 4) Default drive ===" -ForegroundColor Cyan
$drive = Invoke-RestMethod -Method GET -Uri "$graph/sites/$SiteId/drive" -Headers $headers
Write-Host "Drive OK: $($drive.name) ($($drive.id))" -ForegroundColor Green

if ($UploadTest) {
  Write-Host "`n=== 5) Upload probe file ===" -ForegroundColor Cyan
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $folder = "Testing/_ImageFlowProbe/PROBE"
  $fileName = "probe-$stamp.txt"
  $content = [Text.Encoding]::UTF8.GetBytes("ImageFlow SharePoint probe $stamp`n")
  $uploadUri = "$graph/drives/$($drive.id)/root:/$folder/$fileName`:/content"
  Invoke-RestMethod -Method PUT -Uri $uploadUri -Headers (@{
    Authorization = "Bearer $token"
    "Content-Type" = "text/plain"
  }) -Body $content | Out-Null
  Write-Host "Uploaded: $folder/$fileName" -ForegroundColor Green
}

Write-Host "`nAll checks passed." -ForegroundColor Green
Write-Host "Add this to .env / Portainer if not already set:"
Write-Host "  SHAREPOINT_SITE_ID=$SiteId"
