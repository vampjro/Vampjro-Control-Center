const ps = require('../utils/powershell');
const logger = require('../core/logger');

const VOLUME_CS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDevEnum {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDE { int EnumAudioEndpoints(int d,int s,out IntPtr p); int GetDefaultAudioEndpoint(int d,int r,out IMMDev dev); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDev { int Activate(ref Guid i,int c,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAEV { int _0();int _1();int _2();int _3();int _4();int _5();int _6();
int SetMasterVolumeLevelScalar(float f,ref Guid g);int GetMasterVolumeLevelScalar(out float f);
int SetMute([MarshalAs(UnmanagedType.Bool)] bool m,ref Guid g);int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m); }
public class VolCtl {
  static IAEV Get(){var e=(IMMDE)(new MMDevEnum());IMMDev d;e.GetDefaultAudioEndpoint(0,1,out d);
  Guid g=typeof(IAEV).GUID;object o;d.Activate(ref g,23,IntPtr.Zero,out o);return(IAEV)o;}
  public static int GetVol(){float f;Get().GetMasterVolumeLevelScalar(out f);return(int)(f*100);}
  public static void SetVol(int v){var a=Get();Guid g=Guid.Empty;a.SetMasterVolumeLevelScalar(v/100f,ref g);}
  public static bool GetMute(){bool m;Get().GetMute(out m);return m;}
  public static void SetMute(bool m){var a=Get();Guid g=Guid.Empty;a.SetMute(m,ref g);}
}
'@
`;

let volumeAvailable = null;

async function testVolume() {
  if (volumeAvailable !== null) return volumeAvailable;
  try {
    await ps.run(VOLUME_CS + `; [VolCtl]::GetVol()`, { timeout: 10000 });
    volumeAvailable = true;
  } catch {
    volumeAvailable = false;
  }
  return volumeAvailable;
}

function health() {
  return { volumeAvailable };
}

async function getVolume() {
  if (!(await testVolume())) return { volume: -1, muted: false, error: 'Volume API unavailable' };
  try {
    const result = await ps.run(VOLUME_CS + `; Write-Output "$([VolCtl]::GetVol())|$([VolCtl]::GetMute())"`, { timeout: 8000 });
    const [vol, muted] = result.split('|');
    return { volume: parseInt(vol, 10), muted: muted === 'True' };
  } catch (e) {
    return { volume: -1, muted: false, error: e.message };
  }
}

async function setVolume(level) {
  const safe = Math.max(0, Math.min(100, parseInt(level, 10)));
  if (!(await testVolume())) return { success: false, error: 'Volume API unavailable' };
  try {
    await ps.run(VOLUME_CS + `; [VolCtl]::SetVol(${safe})`);
    logger.logAction('panel', 'setVolume', `${safe}%`);
    return { success: true, volume: safe };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function setMute(muted) {
  if (!(await testVolume())) return { success: false, error: 'Volume API unavailable' };
  try {
    await ps.run(VOLUME_CS + `; [VolCtl]::SetMute($${muted ? 'true' : 'false'})`);
    logger.logAction('panel', 'setMute', muted);
    return { success: true, muted };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getBrightness() {
  try {
    const result = await ps.run('(Get-CimInstance -Namespace root\\WMI -ClassName WmiMonitorBrightness).CurrentBrightness');
    return { brightness: parseInt(result, 10) };
  } catch {
    return { brightness: -1, error: 'Brightness not available' };
  }
}

async function setBrightness(level) {
  const safe = Math.max(0, Math.min(100, parseInt(level, 10)));
  try {
    await ps.run(`(Get-CimInstance -Namespace root\\WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(0, ${safe})`);
    logger.logAction('panel', 'setBrightness', `${safe}%`);
    return { success: true, brightness: safe };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function shutdown() {
  logger.logAction('panel', 'shutdown', 'initiated');
  await ps.run('Stop-Computer -Force');
  return { success: true };
}

async function restart() {
  logger.logAction('panel', 'restart', 'initiated');
  await ps.run('Restart-Computer -Force');
  return { success: true };
}

async function sleep() {
  logger.logAction('panel', 'sleep', 'initiated');
  await ps.runRaw('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
  return { success: true };
}

async function lock() {
  logger.logAction('panel', 'lock', 'initiated');
  await ps.runRaw('rundll32.exe user32.dll,LockWorkStation');
  return { success: true };
}

function wsHandlers() {
  return {
    getVolume: async () => await getVolume(),
    setVolume: async (msg) => await setVolume(msg.level),
    setMute: async (msg) => await setMute(msg.muted),
    getBrightness: async () => await getBrightness(),
    setBrightness: async (msg) => await setBrightness(msg.level),
    shutdown: async () => await shutdown(),
    restart: async () => await restart(),
    sleep: async () => await sleep(),
    lock: async () => await lock()
  };
}

module.exports = { initialize: testVolume, health, wsHandlers };
