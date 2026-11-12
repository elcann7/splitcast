@echo off
setlocal
set "DATA=%LOCALAPPDATA%\ScenepackStudio"
set "PY=%DATA%\venv\Scripts\pythonw.exe"
set "PYTHONPYCACHEPREFIX=%DATA%\pycache"
cd /d "%~dp0"

if not exist "%DATA%\venv\Scripts\python.exe" goto :setup
if not exist "%DATA%\bin\ffmpeg.exe" goto :setup
goto :run

:setup
echo First run: setting up Splitcast. This downloads about 2 GB once.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. See the messages above.
  pause
  exit /b 1
)

:run
start "" "%PY%" "%~dp0app.py"
endlocal
