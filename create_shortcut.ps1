# Creates a desktop shortcut to ScenepackStudio.bat next to this script (works from any location).
$root = $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Splitcast.lnk'
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'ScenepackStudio.bat'
$s.WorkingDirectory = $root
$s.Description = 'Splitcast - per-character scenepacks from films'
$s.IconLocation = Join-Path $root 'branding\app.ico'
$s.WindowStyle = 7   # minimised: the launcher only spawns the app and exits
$s.Save()
Write-Output "Created $lnk -> $($s.TargetPath)"
