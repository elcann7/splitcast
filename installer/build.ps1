<#
  Builds installer\Output\Splitcast-Setup.exe (the version is inside the file; the name stays the same so
  https://github.com/<owner>/splitcast/releases/latest/download/Splitcast-Setup.exe always points at the newest one).

    1. builds the UI (npm run build)
    2. stages an embedded Python 3.12 with pip (build\runtime) and renames pythonw.exe to Splitcast.exe
       with our icon, so Task Manager and the taskbar say "Splitcast", not "Python"
    3. stages the app files (build\app)
    4. compiles splitcast.iss with Inno Setup 6

  One installer for every GPU: the NVIDIA build of ONNX Runtime (CUDA) is installed normally, the DirectML build
  (AMD, Intel, any DirectX 12 GPU) goes into runtime\Lib\dml-packages, and the app picks one at startup
  (backend/scenepack/devices.py). Needs: Node 20+, Inno Setup 6 (preinstalled on GitHub's windows runners).
#>
param([string]$Version)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Here  = $PSScriptRoot
$Root  = Split-Path $Here -Parent
$Build = Join-Path $Here 'build'
$Cache = Join-Path $Here 'cache'
$PyVer = '3.12.8'
$PyZip = "python-$PyVer-embed-amd64.zip"

if (-not $Version) { $Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Get-Cached($url, $name) {
    $f = Join-Path $Cache $name
    if (-not (Test-Path $f)) { Write-Host "downloading $url"; Invoke-WebRequest $url -OutFile $f -UseBasicParsing }
    return $f
}

New-Item -ItemType Directory -Force $Cache | Out-Null
if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
New-Item -ItemType Directory -Force $Build | Out-Null

# --- 1. UI -----------------------------------------------------------------
Step 'Build the UI'
Push-Location $Root
try {
    if (-not (Test-Path 'node_modules')) { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
    npm run build
    if ($LASTEXITCODE) { throw 'UI build failed' }
} finally { Pop-Location }

# --- 2. embedded Python ----------------------------------------------------
Step "Embedded Python $PyVer"
$rt = Join-Path $Build 'runtime'
Expand-Archive (Get-Cached "https://www.python.org/ftp/python/$PyVer/$PyZip" $PyZip) $rt -Force
$pth = Get-ChildItem $rt -Filter 'python*._pth' | Select-Object -First 1
$zipName = (Get-ChildItem $rt -Filter 'python*.zip' | Select-Object -First 1).Name
Set-Content $pth.FullName -Encoding ascii -Value @($zipName, '.', 'Lib\site-packages', '..\app\backend', 'import site')
& (Join-Path $rt 'python.exe') (Get-Cached 'https://bootstrap.pypa.io/get-pip.py' 'get-pip.py') --no-warn-script-location --disable-pip-version-check
if ($LASTEXITCODE) { throw 'get-pip failed' }

Step 'Splitcast.exe (renamed pythonw.exe with our icon)'
Copy-Item (Join-Path $rt 'pythonw.exe') (Join-Path $rt 'Splitcast.exe')
$rcedit = Get-Cached 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' 'rcedit-x64.exe'
& $rcedit (Join-Path $rt 'Splitcast.exe') --set-icon (Join-Path $Root 'branding\app.ico') `
    --set-version-string FileDescription 'Splitcast' --set-version-string ProductName 'Splitcast' `
    --set-version-string OriginalFilename 'Splitcast.exe' --set-file-version "$Version.0" --set-product-version "$Version.0"
if ($LASTEXITCODE) { throw 'rcedit failed' }

# --- 3. app files ----------------------------------------------------------
Step 'Stage the app'
$app = Join-Path $Build 'app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $Root 'app.py') $app
Copy-Item (Join-Path $Here 'install_components.cmd') $app
robocopy (Join-Path $Root 'backend') (Join-Path $app 'backend') /E /XD __pycache__ /XF *.pyc /NFL /NDL /NJH /NJS | Out-Null
robocopy (Join-Path $Root 'dist') (Join-Path $app 'dist') /E /XF sample_demo.mp4 /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Directory -Force (Join-Path $app 'branding') | Out-Null
Copy-Item (Join-Path $Root 'branding\app.ico') (Join-Path $app 'branding')
foreach ($f in 'README.md', 'LICENSE') { if (Test-Path (Join-Path $Root $f)) { Copy-Item (Join-Path $Root $f) $app } }

# --- 3b. bundle the AI runtime, ffmpeg and the default models ------------------
# Like a pro desktop app, the installer is self-contained: nothing is downloaded while installing.
Step "Python packages (CUDA build of ONNX Runtime, ~2.3 GB unpacked)"
$py = Join-Path $rt 'python.exe'
# a few small dependencies (proxy_tools) ship as source and need a build backend; get-pip does not install one
& $py -m pip install --disable-pip-version-check --no-warn-script-location setuptools wheel
if ($LASTEXITCODE) { throw 'pip install setuptools failed' }
& $py -m pip install --disable-pip-version-check --no-warn-script-location -r (Join-Path $app 'backend\requirements.txt')
if ($LASTEXITCODE) { throw 'pip install failed' }

Step 'DirectML build of ONNX Runtime (a separate folder, chosen at startup)'
& $py -m pip install --disable-pip-version-check --no-warn-script-location --no-deps --target (Join-Path $rt 'Lib\dml-packages') -r (Join-Path $app 'backend/requirements-dml.txt')
if ($LASTEXITCODE) { throw 'pip install (DirectML) failed' }

Step 'ffmpeg and the balanced model pack (staged as the user data folder)'
$data = Join-Path $Build 'data'
$env:SCENEPACK_DATA = $data
$env:PYTHONUTF8 = '1'
& $py -m scenepack.bootstrap
if ($LASTEXITCODE) { throw 'bootstrap failed' }
Remove-Item -Recurse -Force (Join-Path $data 'tmp'), (Join-Path $data 'pycache') -ErrorAction SilentlyContinue
Remove-Item Env:SCENEPACK_DATA

# --- 4. compile ------------------------------------------------------------
Step 'Compile the installer'
$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 was not found. Install it (winget install JRSoftware.InnoSetup).' }
& $iscc "/DAppVersion=$Version" (Join-Path $Here 'splitcast.iss')
if ($LASTEXITCODE) { throw 'ISCC failed' }

$out = Join-Path $Here "Output\Splitcast-Setup.exe"
Write-Host ("`nDone: {0}  ({1:N1} MB)" -f $out, ((Get-Item $out).Length / 1MB)) -ForegroundColor Green

