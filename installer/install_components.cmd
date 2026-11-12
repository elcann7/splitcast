@echo off
rem Downloads Splitcast's heavy parts into the bundled Python: the AI runtime (onnxruntime-gpu + CUDA wheels),
rem then ffmpeg and the default models. Safe to run again; used by the installer and by "repair components".
setlocal
title Splitcast - downloading components
set "APP=%~dp0"
set "PY=%APP%..\runtime\python.exe"
set "PYTHONPATH=%APP%backend"
set "PYTHONUTF8=1"

echo.
echo  Splitcast needs to download its AI components (about 2 GB, once).
echo  Keep this window open. It closes by itself when everything is ready.
echo.

"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location -r "%APP%backend\requirements.txt"
if errorlevel 1 goto :fail

"%PY%" -m scenepack.bootstrap
if errorlevel 1 goto :fail

exit /b 0

:fail
echo.
echo  Something went wrong. Check your internet connection and run
echo  "Splitcast - repair components" from the Start menu to try again.
echo.
pause
exit /b 1
