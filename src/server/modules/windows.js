const ps = require('../utils/powershell');
const logger = require('../core/logger');

async function getWindows() {
  const cmd = `Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;using System.Collections.Generic;
public class WinEnum{
[DllImport("user32.dll")]static extern bool EnumWindows(EnumWindowsProc e,IntPtr l);
[DllImport("user32.dll")]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")]static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")]static extern int GetWindowThreadProcessId(IntPtr h,out int pid);
delegate bool EnumWindowsProc(IntPtr h,IntPtr l);
public static string Get(){var r=new List<string>();
EnumWindows((h,l)=>{if(!IsWindowVisible(h))return true;var sb=new StringBuilder(256);GetWindowText(h,sb,256);
var t=sb.ToString();if(string.IsNullOrWhiteSpace(t))return true;int pid;GetWindowThreadProcessId(h,out pid);
r.Add(pid+"|"+(IsIconic(h)?"min":IsZoomed(h)?"max":"normal")+"|"+t);return true;},IntPtr.Zero);
return string.Join("\\n",r);}
}
'@
[WinEnum]::Get()`;

  try {
    const result = await ps.run(cmd, { timeout: 10000 });
    return result.split('\n').filter(Boolean).map(line => {
      const [pid, state, ...titleParts] = line.split('|');
      return { pid: parseInt(pid, 10), state, title: titleParts.join('|') };
    });
  } catch {
    return [];
  }
}

async function focusWindow(pid) {
  await ps.run(`Add-Type @'
using System;using System.Runtime.InteropServices;
public class WF{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}
'@
$p=Get-Process -Id ${parseInt(pid,10)} -ErrorAction Stop; [WF]::ShowWindow($p.MainWindowHandle,9); [WF]::SetForegroundWindow($p.MainWindowHandle)`);
  logger.logAction('panel', 'focusWindow', `PID ${pid}`);
  return { success: true };
}

async function minimizeWindow(pid) {
  await ps.run(`Add-Type @'
using System;using System.Runtime.InteropServices;
public class WM{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}
'@
$p=Get-Process -Id ${parseInt(pid,10)} -ErrorAction Stop; [WM]::ShowWindow($p.MainWindowHandle,6)`);
  return { success: true };
}

async function maximizeWindow(pid) {
  await ps.run(`Add-Type @'
using System;using System.Runtime.InteropServices;
public class WX{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);}
'@
$p=Get-Process -Id ${parseInt(pid,10)} -ErrorAction Stop; [WX]::ShowWindow($p.MainWindowHandle,3)`);
  return { success: true };
}

async function closeWindow(pid) {
  await ps.run(`(Get-Process -Id ${parseInt(pid,10)} -ErrorAction Stop).CloseMainWindow()`);
  logger.logAction('panel', 'closeWindow', `PID ${pid}`);
  return { success: true };
}

function wsHandlers() {
  return {
    getWindows: async () => await getWindows(),
    focusWindow: async (msg) => await focusWindow(msg.pid),
    minimizeWindow: async (msg) => await minimizeWindow(msg.pid),
    maximizeWindow: async (msg) => await maximizeWindow(msg.pid),
    closeWindow: async (msg) => await closeWindow(msg.pid)
  };
}

module.exports = { wsHandlers };
