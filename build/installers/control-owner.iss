#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
[Setup]
AppName=VAMPJRO Control Owner
AppVersion={#AppVersion}
AppPublisher=VAMPJRO
AppPublisherURL=https://t.me/vampjro
DefaultDirName={localappdata}\VAMPJRO\Owner\App
DefaultGroupName=VAMPJRO Owner
OutputDir=..\..\release
OutputBaseFilename=VAMPJRO Build Owner
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=lowest
SetupIconFile=..\resources\assets\icon-owner.ico
UninstallDisplayIcon={app}\icon-owner.ico
WizardStyle=modern
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE.txt

[Languages]
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\dist\control-owner\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\resources\node-runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion

[Icons]
Name: "{group}\VAMPJRO Control Owner"; Filename: "{app}\VAMPJRO-Owner.bat"
Name: "{group}\Disinstalla VAMPJRO Owner"; Filename: "{uninstallexe}"
Name: "{autodesktop}\VAMPJRO Control Owner"; Filename: "{app}\VAMPJRO-Owner.bat"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Crea icona sul desktop"; GroupDescription: "Icone:"; Flags: unchecked

[Run]
Filename: "{app}\VAMPJRO-Owner.bat"; Description: "Avvia VAMPJRO Control Owner"; Flags: nowait postinstall skipifsilent shellexec
