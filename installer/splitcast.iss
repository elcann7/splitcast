; Splitcast installer (Inno Setup 6). Build with installer\build.ps1, which stages installer\build\{runtime,app} first.
; Self-contained, like any pro desktop app: embedded Python, the AI runtime (onnxruntime-gpu + CUDA libraries),
; ffmpeg and the default models are all inside. Nothing is downloaded while installing (only the WebView2
; runtime, and only when Windows does not have it). install_components.cmd is kept for "repair".

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{6B1F0C3E-5D84-4C57-9A0B-2E7A4F1D9C11}
AppName=Splitcast
AppVersion={#AppVersion}
AppPublisher=Splitcast
AppPublisherURL=https://github.com/elcann7/splitcast
DefaultDirName={localappdata}\Programs\Splitcast
DefaultGroupName=Splitcast
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=Splitcast-Setup-{#AppVersion}
SetupIconFile=..\branding\app.ico
UninstallDisplayIcon={app}\runtime\Splitcast.exe
UninstallDisplayName=Splitcast
WizardStyle=modern
Compression=lzma2/normal
SolidCompression=no
DiskSpanning=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Splitcast setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "build\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "build\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
; ffmpeg and the default models go to the user data folder; kept on uninstall (the uninstaller asks about them)
Source: "build\data\*"; DestDir: "{localappdata}\Splitcast"; Flags: recursesubdirs createallsubdirs onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{autoprograms}\Splitcast"; Filename: "{app}\runtime\Splitcast.exe"; Parameters: """{app}\app\app.py"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\branding\app.ico"
Name: "{autoprograms}\Splitcast - repair components"; Filename: "{app}\app\install_components.cmd"; WorkingDir: "{app}\app"; IconFilename: "{app}\app\branding\app.ico"
Name: "{autodesktop}\Splitcast"; Filename: "{app}\runtime\Splitcast.exe"; Parameters: """{app}\app\app.py"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app\branding\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\Splitcast.exe"; Parameters: """{app}\app\app.py"""; WorkingDir: "{app}\app"; Description: "Launch Splitcast"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  WebView2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed: Boolean;
var
  v: String;
begin
  Result :=
    (RegQueryStringValue(HKLM32, WebView2Key, 'pv', v) and (v <> '') and (v <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, WebView2Key, 'pv', v) and (v <> '') and (v <> '0.0.0.0'));
end;

procedure EnsureWebView2;
var
  file: String;
  code: Integer;
begin
  if WebView2Installed then Exit;
  WizardForm.StatusLabel.Caption := 'Installing Microsoft Edge WebView2 runtime...';
  try
    file := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
    DownloadTemporaryFile('https://go.microsoft.com/fwlink/p/?LinkId=2124703', 'MicrosoftEdgeWebview2Setup.exe', '', nil);
    Exec(file, '/silent /install', '', SW_SHOW, ewWaitUntilTerminated, code);
  except
    MsgBox('Splitcast needs the Microsoft Edge WebView2 runtime, and it could not be downloaded. ' +
           'Install it from microsoft.com/edge/webview2 and start Splitcast again.', mbInformation, MB_OK);
  end;
end;

procedure DownloadComponents;
var
  code: Integer;
begin
  WizardForm.StatusLabel.Caption := 'Downloading the AI components (about 2 GB, once)...';
  if (not Exec(ExpandConstant('{cmd}'), '/C ""' + ExpandConstant('{app}\app\install_components.cmd') + '""',
               ExpandConstant('{app}\app'), SW_SHOW, ewWaitUntilTerminated, code)) or (code <> 0) then
    MsgBox('Splitcast is installed, but its AI components did not finish downloading.' + #13#10 + #13#10 +
           'Check your internet connection, then run "Splitcast - repair components" from the Start menu.',
           mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    EnsureWebView2;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  data: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    data := ExpandConstant('{localappdata}\Splitcast');
    if DirExists(data) then
      if MsgBox('Also delete your projects, downloaded models and settings?' + #13#10 + data,
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(data, True, True, True);
  end;
end;

