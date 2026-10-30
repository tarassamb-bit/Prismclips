; Prism installer for Windows. Built by .github/workflows/release.yml with Inno Setup 6.
; Expects the self-contained app in ..\..\dist\windows (with ffmpeg.exe and ffprobe.exe beside Prism.exe).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F0D3A52-58B4-4C2B-9F0E-2E7C1B9B7A41}
AppName=Prism
AppVersion={#AppVersion}
AppPublisher=Prism
DefaultDirName={autopf}\Prism
DefaultGroupName=Prism
DisableProgramGroupPage=yes
; Installs for the current user only, so no administrator prompt.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=Prism-Windows-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Prism.exe

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\..\dist\windows\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Prism"; Filename: "{app}\Prism.exe"
Name: "{autodesktop}\Prism"; Filename: "{app}\Prism.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Prism.exe"; Description: "Open Prism"; Flags: nowait postinstall skipifsilent
; "Restart to update" installs silently, then reopens Prism.
Filename: "{app}\Prism.exe"; Flags: nowait; Check: WizardSilent
