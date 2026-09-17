const ps = require('../utils/powershell');

async function getAudioSessions() {
  const cmd = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDevEnum{}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDE{int EnumAudioEndpoints(int d,int s,out IntPtr p);int GetDefaultAudioEndpoint(int d,int r,out IMMDev dev);}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDev{int Activate(ref Guid i,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)]out object o);}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IASM2{int _0();int _1();int _2();int GetSessionEnumerator(out IAudioSE e);}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSE{int GetCount(out int c);int GetSession(int i,out IAudioSC s);}
[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSC{int _0();int _1();int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)]out string n);int _3();int GetProcessId(out uint pid);int _5();int _6();int QueryInterface2(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object o);}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimVol{int SetMasterVolume(float f,ref Guid g);int GetMasterVolume(out float f);int SetMute(bool m,ref Guid g);int GetMute(out bool m);}
public class AudioMixer{
public static string GetSessions(){
try{var e=(IMMDE)(new MMDevEnum());IMMDev d;e.GetDefaultAudioEndpoint(0,1,out d);
Guid g=typeof(IASM2).GUID;object o;d.Activate(ref g,23,IntPtr.Zero,out o);var asm=(IASM2)o;
IAudioSE se;asm.GetSessionEnumerator(out se);int count;se.GetCount(out count);
var r=new List<string>();
for(int i=0;i<count;i++){IAudioSC sc;se.GetSession(i,out sc);string name;sc.GetDisplayName(out name);
uint pid;sc.GetProcessId(out pid);
Guid sv=typeof(ISimVol).GUID;object vo;
try{sc.QueryInterface2(ref sv,out vo);var v=(ISimVol)vo;float vol;v.GetMasterVolume(out vol);bool muted;v.GetMute(out muted);
r.Add(pid+"|"+Math.Round(vol*100)+"|"+(muted?"1":"0")+"|"+name);}catch{r.Add(pid+"|-1|0|"+name);}}
return string.Join("\\n",r);}catch(Exception ex){return "ERR:"+ex.Message;}}}
'@
[AudioMixer]::GetSessions()
`;

  try {
    const result = await ps.run(cmd, { timeout: 10000 });
    if (result.startsWith('ERR:')) return { sessions: [], error: result.substring(4) };

    const lines = result.split('\n').filter(Boolean);
    const procs = new Map();
    try {
      const procResult = await ps.run('Get-Process | Select-Object Id, ProcessName | ConvertTo-Json -Compress');
      const procList = JSON.parse(procResult);
      (Array.isArray(procList) ? procList : [procList]).forEach(p => procs.set(p.Id, p.ProcessName));
    } catch {}

    const sessions = lines.map(line => {
      const [pid, vol, muted, name] = line.split('|');
      const pidNum = parseInt(pid, 10);
      return {
        pid: pidNum,
        name: name || procs.get(pidNum) || `PID ${pid}`,
        processName: procs.get(pidNum) || '',
        volume: parseInt(vol, 10),
        muted: muted === '1'
      };
    }).filter(s => s.pid > 0);

    return { sessions };
  } catch (e) {
    return { sessions: [], error: e.message };
  }
}

async function setSessionVolume(pid, volume) {
  const safePid = parseInt(pid, 10);
  const safeVol = Math.max(0, Math.min(100, parseInt(volume, 10)));
  const cmd = `
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDevEnum{}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDE{int EnumAudioEndpoints(int d,int s,out IntPtr p);int GetDefaultAudioEndpoint(int d,int r,out IMMDev dev);}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDev{int Activate(ref Guid i,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)]out object o);}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IASM2{int _0();int _1();int _2();int GetSessionEnumerator(out IAudioSE e);}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSE{int GetCount(out int c);int GetSession(int i,out IAudioSC s);}
[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSC{int _0();int _1();int _2();int _3();int GetProcessId(out uint pid);int _5();int _6();int QueryInterface2(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object o);}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimVol{int SetMasterVolume(float f,ref Guid g);int GetMasterVolume(out float f);int SetMute(bool m,ref Guid g);int GetMute(out bool m);}
public class AudioSet{public static void Set(uint targetPid,float vol){
var e=(IMMDE)(new MMDevEnum());IMMDev d;e.GetDefaultAudioEndpoint(0,1,out d);
Guid g=typeof(IASM2).GUID;object o;d.Activate(ref g,23,IntPtr.Zero,out o);var asm=(IASM2)o;
IAudioSE se;asm.GetSessionEnumerator(out se);int count;se.GetCount(out count);
for(int i=0;i<count;i++){IAudioSC sc;se.GetSession(i,out sc);uint pid;sc.GetProcessId(out pid);
if(pid==targetPid){Guid sv=typeof(ISimVol).GUID;object vo;sc.QueryInterface2(ref sv,out vo);var v=(ISimVol)vo;Guid empty=Guid.Empty;v.SetMasterVolume(vol,ref empty);return;}}}}
'@
[AudioSet]::Set(${safePid},${safeVol/100})
`;
  try {
    await ps.run(cmd, { timeout: 8000 });
    return { success: true, pid: safePid, volume: safeVol };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function wsHandlers() {
  return {
    getAudio: async () => await getAudioSessions(),
    setAudioVolume: async (msg) => await setSessionVolume(msg.pid, msg.volume)
  };
}

module.exports = { wsHandlers };
