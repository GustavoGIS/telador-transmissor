# Compila native/AudioExclude.cs → native/audio-exclude.exe
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "native\AudioExclude.cs"
$out = Join-Path $root "native\audio-exclude.exe"

if (-not (Test-Path $src)) {
  Write-Error "Missing $src"
  exit 1
}

$cscCandidates = @(
  "${env:WINDIR}\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "${env:WINDIR}\Microsoft.NET\Framework\v4.0.30319\csc.exe",
  "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe",
  "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  Write-Error "csc.exe not found. Install .NET Framework Developer Pack or VS Build Tools."
  exit 1
}

Write-Host "Compiling with $csc"
& $csc /nologo /optimize+ /target:exe /platform:anycpu /out:"$out" /r:System.Windows.Forms.dll "$src"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "OK $out"
