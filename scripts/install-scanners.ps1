<#
.SYNOPSIS
  One-time install of the free scanners used by the audit pre-pass.
  gitleaks + osv-scanner via winget; semgrep, pip-audit, bandit via pip (Python 3.12, whose
  Scripts folder is on PATH). Safe to re-run: already-installed tools are upgraded or skipped.
#>
$ErrorActionPreference = 'Continue'

function Test-Tool($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host '== winget packages =='
foreach ($pkg in @(
    @{ Id = 'Gitleaks.Gitleaks'; Cmd = 'gitleaks' },
    @{ Id = 'Google.OSVScanner'; Cmd = 'osv-scanner' }
)) {
    if (Test-Tool $pkg.Cmd) { Write-Host "  $($pkg.Cmd): already installed"; continue }
    Write-Host "  installing $($pkg.Id)..."
    winget install --id $pkg.Id -e --source winget --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { Write-Warning "  winget could not install $($pkg.Id). Install it manually; the audit will list it as a coverage gap." }
}

Write-Host '== pip packages (py -3.12) =='
py -3.12 -m pip install --upgrade --disable-pip-version-check semgrep pip-audit bandit
if ($LASTEXITCODE -ne 0) { Write-Warning '  pip install failed for one or more packages.' }

# winget updates PATH for new shells only; refresh this session so the check below is accurate.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

Write-Host '== result (open a NEW terminal if something shows missing) =='
foreach ($t in 'gitleaks', 'osv-scanner', 'semgrep', 'pip-audit', 'bandit', 'npm') {
    if (Test-Tool $t) { Write-Host ("  {0,-12} OK" -f $t) } else { Write-Host ("  {0,-12} MISSING" -f $t) -ForegroundColor Yellow }
}
