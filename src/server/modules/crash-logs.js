const ps = require('../utils/powershell');

let cache = { logs: [], ts: 0 };
const CACHE_TTL = 30000;

async function getCrashLogs(days = 7, max = 50) {
  const now = Date.now();
  if (cache.logs.length && (now - cache.ts) < CACHE_TTL) return cache.logs;

  const d = parseInt(days, 10) || 7;
  const m = parseInt(max, 10) || 50;
  const cmd = `$d=(Get-Date).AddDays(-${d}); Get-WinEvent -FilterHashtable @{LogName='Application','System'; Level=1,2; StartTime=$d} -MaxEvents ${m} -ErrorAction SilentlyContinue | Select-Object @{N='Time';E={$_.TimeCreated.ToString('o')}}, Id, LevelDisplayName, ProviderName, @{N='Msg';E={$_.Message.Substring(0,[Math]::Min($_.Message.Length,400))}} | ConvertTo-Json -Compress`;

  try {
    const result = await ps.run(cmd, { timeout: 30000 });
    let logs = result ? JSON.parse(result) : [];
    if (!Array.isArray(logs)) logs = [logs];
    cache.logs = logs.map(l => ({
      time: l.Time,
      eventId: l.Id,
      level: l.LevelDisplayName || 'Error',
      source: l.ProviderName || '',
      message: l.Msg || ''
    }));
    cache.ts = now;
    return cache.logs;
  } catch {
    return cache.logs.length ? cache.logs : [];
  }
}

function clearCache() { cache = { logs: [], ts: 0 }; }

function wsHandlers() {
  return {
    getCrashLogs: async (msg) => await getCrashLogs(msg.days, msg.max),
    refreshCrashLogs: async (msg) => { clearCache(); return await getCrashLogs(msg.days, msg.max); }
  };
}

module.exports = { wsHandlers };
