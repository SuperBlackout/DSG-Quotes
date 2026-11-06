# DSG Quotes one-command release. Windows PowerShell 5.1 compatible.
# Usage: pnpm release [--dry-run] [--yes] [--only <step>] [--skip <step>]
# Finds Python 3.10+, then hands everything to release.py (standard library only).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..')

function Find-Python {
    $candidates = @(@('py', '-3'), @('python'), @('python3'))
    foreach ($c in $candidates) {
        $cmd = Get-Command $c[0] -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $extra = @()
        if ($c.Count -gt 1) { $extra = $c[1..($c.Count - 1)] }
        & $cmd.Source @extra -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 3)" 2>$null
        if ($LASTEXITCODE -eq 0) { return ,(@($cmd.Source) + $extra) }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Host 'Python 3.10+ was not found. Install it from https://www.python.org/downloads/ and re-run.' -ForegroundColor Red
    exit 2
}

Set-Location $repoRoot
$pyExe = $py[0]
$pyPre = @()
if ($py.Count -gt 1) { $pyPre = $py[1..($py.Count - 1)] }
$env:PYTHONIOENCODING = 'utf-8'
& $pyExe @pyPre -X utf8 (Join-Path $here 'release.py') @args
exit $LASTEXITCODE
