<#
  Splitcast - one-time setup (idempotent; safe to re-run).
    1. Python venv in %LOCALAPPDATA%\ScenepackStudio\venv
    2. dependencies from backend\requirements.txt (onnxruntime-gpu with CUDA runtime wheels)
    3. static ffmpeg + ffprobe (NVENC capable) in ...\bin
    4. model weights for the "balanced" preset (other presets download on demand from the app)
    5. proof that ONNX Runtime really runs on the GPU
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x faster without the progress bar

$Root    = $PSScriptRoot
$Data    = Join-Path $env:LOCALAPPDATA 'ScenepackStudio'
$Venv    = Join-Path $Data 'venv'
$VenvPy  = Join-Path $Venv 'Scripts\python.exe'
$Bin     = Join-Path $Data 'bin'
$Backend = Join-Path $Root 'backend'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

New-Item -ItemType Directory -Force $Data, $Bin, (Join-Path $Data 'models'), (Join-Path $Data 'projects'), (Join-Path $Data 'tmp') | Out-Null

# --- 1. venv ---------------------------------------------------------------
Step 'Python virtual environment'
if (-not (Test-Path $VenvPy)) {
    $sysPy = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $sysPy) { throw 'Python 3.12 was not found on PATH. Install it from python.org and re-run.' }
    $ver = & $sysPy -c "import sys; print('%d.%d' % sys.version_info[:2])"
    if ([version]$ver -lt [version]'3.10') { throw "Python $ver is too old (need 3.10+)." }
    & $sysPy -m venv $Venv
    if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
}
Write-Host "venv: $Venv"

# --- 2. dependencies -------------------------------------------------------
Step 'Python dependencies (the CUDA runtime wheels are large on first install)'
& $VenvPy -m pip install --disable-pip-version-check -q --upgrade pip
& $VenvPy -m pip install --disable-pip-version-check -r (Join-Path $Backend 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

# --- 3. ffmpeg -------------------------------------------------------------
Step 'ffmpeg / ffprobe'
$ff = Join-Path $Bin 'ffmpeg.exe'; $fp = Join-Path $Bin 'ffprobe.exe'
if (-not ((Test-Path $ff) -and (Test-Path $fp))) {
    # BtbN (GitHub CDN) first: fast and includes NVENC; gyan.dev is the fallback.
    $sources = @(
        'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
        'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    )
    $tmp = Join-Path $Data 'tmp\ffmpeg_dl'
    $ok = $false
    foreach ($url in $sources) {
        try {
            Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force $tmp | Out-Null
            $zip = Join-Path $tmp 'ffmpeg.zip'
            Write-Host "downloading $url"
            # curl.exe ships with Windows 10+; it aborts connections that crawl (<150 kB/s for 30 s) so we can try the next mirror
            & curl.exe -L --fail --silent --show-error --retry 2 --speed-limit 150000 --speed-time 30 -o $zip $url
            if ($LASTEXITCODE -ne 0) { throw "curl exit code $LASTEXITCODE" }
            Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
            $f1 = Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter ffmpeg.exe | Select-Object -First 1
            $f2 = Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter ffprobe.exe | Select-Object -First 1
            if ($f1 -and $f2) {
                Copy-Item $f1.FullName $ff -Force; Copy-Item $f2.FullName $fp -Force
                $ok = $true; break
            }
        } catch { Write-Warning "failed: $($_.Exception.Message)" }
    }
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    if (-not $ok) { throw 'Could not download ffmpeg from any source.' }
}
& $ff -version | Select-Object -First 1

# --- 4. models -------------------------------------------------------------
Step 'Model weights (balanced preset)'
# Paths travel through the environment, not the command line: the repo path contains non-ASCII characters
$env:PYTHONPATH = $Backend
$env:PYTHONPYCACHEPREFIX = (Join-Path $Data "pycache")   # keep bytecode out of the repo
& $VenvPy -m scenepack.model_download balanced
if ($LASTEXITCODE -ne 0) { throw 'model download failed' }

# --- 5. prove the GPU path ---------------------------------------------------
Step 'ONNX Runtime device check'
& $VenvPy -m scenepack.runtime

Write-Host "`nSetup complete. Start the app with ScenepackStudio.bat" -ForegroundColor Green
