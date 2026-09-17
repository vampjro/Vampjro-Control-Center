#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
[Setup]
AppName=VAMPJRO Control Center
AppVersion={#AppVersion}
AppPublisher=VAMPJRO
AppPublisherURL=https://t.me/vampjro
DefaultDirName={localappdata}\VAMPJRO\ControlCenter\App
DefaultGroupName=VAMPJRO
OutputDir=..\..\release
OutputBaseFilename=VAMPJRO Build
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=lowest
SetupIconFile=..\resources\assets\icon.ico
UninstallDisplayIcon={app}\icon.ico
WizardStyle=modern
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE.txt

[Languages]
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\dist\control-center\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\resources\node-runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion

[Icons]
Name: "{group}\VAMPJRO Control Center"; Filename: "{app}\VAMPJRO.bat"
Name: "{group}\Disinstalla VAMPJRO"; Filename: "{uninstallexe}"
Name: "{autodesktop}\VAMPJRO Control Center"; Filename: "{app}\VAMPJRO.bat"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Crea icona sul desktop"; GroupDescription: "Icone:"; Flags: unchecked
Name: "autostart"; Description: "Avvia automaticamente al login"; GroupDescription: "Opzioni:"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "VAMPJRO Control Center"; ValueData: """{app}\VAMPJRO.bat"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\VAMPJRO.bat"; Description: "Avvia VAMPJRO Control Center"; Flags: nowait postinstall skipifsilent shellexec
