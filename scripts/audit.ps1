<#
.SYNOPSIS
  Windows wrapper for scripts/audit.mjs (the cross-platform runner).

.EXAMPLE
  .\scripts\audit.ps1 C:\Projects\my-app
  .\scripts\audit.ps1 C:\Projects\my-app -Request "Build a KVKK-compliant signup form with email verification"
  .\scripts\audit.ps1 C:\Projects\my-app -Spec C:\Projects\my-app\docs\spec.md -Interactive
  .\scripts\audit.ps1 C:\Projects\my-app -DryRun
  .\scripts\audit.ps1 C:\Projects\my-app -Sandbox     # also run the project's tests in Docker

.NOTES
  Exit codes: 0 Ship / Ship with fixes, 2 Do not ship, 3 permission violation, 4 run error.
#>
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Target,
    [string]$Spec,
    [string]$Request,
    [switch]$Interactive,
    [double]$Budget,
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$NoScanners,
    [switch]$Sandbox,
    [switch]$NoSandbox,
    [switch]$NoSecretFiles
)

$runner = Join-Path $PSScriptRoot 'audit.mjs'
$nodeArgs = @($runner, $Target)
if ($Spec)        { $nodeArgs += @('--spec', $Spec) }
if ($Interactive) { $nodeArgs += '--interactive' }
if ($Budget -gt 0) { $nodeArgs += @('--budget', [string]$Budget) }
if ($Yes)         { $nodeArgs += '--yes' }
if ($DryRun)      { $nodeArgs += '--dry-run' }
if ($NoScanners)  { $nodeArgs += '--no-scanners' }
if ($Sandbox)     { $nodeArgs += '--sandbox' }
if ($NoSandbox)     { $nodeArgs += '--no-sandbox' }
if ($NoSecretFiles) { $nodeArgs += '--no-secret-files' }

# Request text travels via an env var: Windows PowerShell 5.1 mangles embedded quotes in native args.
if ($Request) { $env:AUDIT_REQUEST_TEXT = $Request }
try {
    & node @nodeArgs
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:\AUDIT_REQUEST_TEXT -ErrorAction SilentlyContinue
}
exit $code
