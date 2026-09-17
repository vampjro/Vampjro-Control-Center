const { exec } = require('child_process');
const ps = require('../utils/powershell');
const logger = require('../core/logger');
const wsHandler = require('../websocket/handler');
const hwProfile = require('../utils/hardware-profile');

let interval = null;
let lastList = null;

async function start() {
  const intervals = hwProfile.getIntervals();
  const ms = intervals?.processes || 10000;
  interval = setInterval(async () => {
    const subs = wsHandler.getSubscribers('processes');
    if (subs.length === 0) return;
    try {
      const procs = await getProcesses();
      wsHandler.broadcastToChannel('processes', { type: 'processList', data: procs });
    } catch {}
  }, ms);
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

function health() {
  return { lastUpdate: lastList ? Date.now() : null, count: lastList?.length || 0 };
}

async function getProcesses() {
  return new Promise((resolve, reject) => {
    exec('wmic process get ProcessId,Name,WorkingSetSize /format:csv',
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
        const procs = [];
        for (const line of lines) {
          const parts = line.split(',');
          if (parts.length >= 4) {
            const name = parts[1]?.trim();
            const pid = parseInt(parts[2]) || 0;
            const ramBytes = parseInt(parts[3]) || 0;
            if (pid > 0 && name) {
              procs.push({ pid, name, cpu: 0, ram: Math.round(ramBytes / 1024 / 1024 * 10) / 10, threads: 0 });
            }
          }
        }
        procs.sort((a, b) => b.ram - a.ram);
        lastList = procs;
        resolve(procs);
      }
    );
  });
}

async function killProcess(pid) {
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) throw new Error('Invalid PID');
  if (safePid === process.pid) throw new Error('Cannot kill VAMPJRO server');
  await ps.run(`Stop-Process -Id ${safePid} -Force -ErrorAction Stop`);
  logger.logAction('panel', 'killProcess', `PID ${safePid}`);
  return { success: true, pid: safePid };
}

function wsHandlers() {
  return {
    getProcesses: async () => await getProcesses(),
    killProcess: async (msg) => await killProcess(msg.pid)
  };
}

module.exports = { start, stop, health, wsHandlers };
