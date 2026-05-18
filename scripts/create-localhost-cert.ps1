$ErrorActionPreference = "Stop"

$certDir = Join-Path $PSScriptRoot "..\certs"
$pfxPath = Join-Path $certDir "localhost.pfx"

if (-not $env:HTTPS_PFX_PASSPHRASE) {
  throw "Set HTTPS_PFX_PASSPHRASE before creating a localhost PFX certificate."
}

$password = ConvertTo-SecureString $env:HTTPS_PFX_PASSPHRASE -AsPlainText -Force

New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$cert = New-SelfSignedCertificate `
  -DnsName "localhost", "127.0.0.1" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -FriendlyName "SEC Form 4 Tracker Localhost" `
  -NotAfter (Get-Date).AddYears(1) `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -KeyExportPolicy Exportable

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null

Write-Host "Wrote $pfxPath"
Write-Host "Set HTTPS_PFX_PASSPHRASE to the same value before starting the server."
Write-Host "HTTPS will be available at https://localhost:3443 after restarting the server."
