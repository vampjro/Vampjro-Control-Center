const os = require('os');
const { exec } = require('child_process');
const si = require('systeminformation');
const logger = require('../core/logger');
const wsHandler = require('../websocket/handler');
const hwProfile = require('../utils/hardware-profile');

let staticCache = null;
let interval = null;
let lastStats = null;
let prevCpuTimes = null;
let batteryCache = { data: null, ts: 0 };
let fsCache = { data: null, ts: 0 };
const history = { cpu: [], ram: [], net: [] };
const MAX_HISTORY = 720;
const BATTERY_CACHE_MS = 60000;
const FS_CACHE_MS = 30000;

function getCpuLoad() {
  const cpus = os.cpus();
  const now = cpus.map(c => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    return { idle: c.times.idle, total };
  });
  if (!prevCpuTimes) {
    prevCpuTimes = now;
    return { load: 0, cores: now.map(() => 0) };
  }
  let totalIdle = 0, totalAll = 0;
  const cores = now.map((c, i) => {
    const prev = prevCpuTimes[i];
    const idleDelta = c.idle - prev.idle;
    const totalDelta = c.total - prev.total;
    totalIdle += idleDelta;
    totalAll += totalDelta;
    return totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;
  });
  prevCpuTimes = now;
  const load = totalAll > 0 ? Math.round((1 - totalIdle / totalAll) * 1000) / 10 : 0;
  return { load, cores };
}

function getMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = Math.round(used / total * 1000) / 10;
  return { total, used, active: used, available: free, percent };
}

function wmicRun(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function getBattery() {
  const now = Date.now();
  if (batteryCache.data && (now - batteryCache.ts) < BATTERY_CACHE_MS) return batteryCache.data;
  try {
    const raw = await wmicRun('wmic path Win32_Battery get EstimatedChargeRemaining,BatteryStatus /format:csv');
    const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
    if (lines.length > 0) {
      const parts = lines[lines.length - 1].split(',');
      const status = parseInt(parts[1]) || 0;
      const percent = parseInt(parts[2]) || 0;
      batteryCache.data = { hasBattery: true, percent, charging: status === 2, timeRemaining: -1 };
    } else {
      batteryCache.data = { hasBattery: false };
    }
  } catch {
    if (!batteryCache.data) batteryCache.data = { hasBattery: false };
  }
  batteryCache.ts = now;
  return batteryCache.data;
}

async function getFilesystems() {
  const now = Date.now();
  if (fsCache.data && (now - fsCache.ts) < FS_CACHE_MS) return fsCache.data;
  try {
    const raw = await wmicRun('wmic logicaldisk get DeviceID,Size,FreeSpace /format:csv');
    const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
    const drives = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 4) {
        const mount = parts[1]?.trim();
        const free = parseInt(parts[2]) || 0;
        const size = parseInt(parts[3]) || 0;
        if (size > 0 && mount) {
          const used = size - free;
          drives.push({ mount, size, used, available: free, percent: Math.round(used / size * 1000) / 10 });
        }
      }
    }
    fsCache.data = drives;
  } catch {
    if (!fsCache.data) fsCache.data = [];
  }
  fsCache.ts = now;
  return fsCache.data;
}

async function initialize() {
  getCpuLoad();
  logger.info('System module: using fast native APIs');
  loadStaticInfoBackground();
}

function loadStaticInfoBackground() {
  (async () => {
    try {
      const cpus = os.cpus();
      const brand = cpus[0]?.model || 'Unknown CPU';
      const totalMem = os.totalmem();

      staticCache = {
        cpu: { manufacturer: '', brand, speed: cpus[0]?.speed / 1000 || 0, cores: new Set(cpus.map((_, i) => Math.floor(i / 2))).size, threads: cpus.length },
        totalMem,
        gpu: [],
        os: { distro: 'Windows', release: os.release(), arch: os.arch(), hostname: os.hostname() },
        disks: [],
        battery: { hasBattery: false }
      };

      const [gpu, disk, batt] = await Promise.all([
        si.graphics().catch(() => ({ controllers: [] })),
        si.diskLayout().catch(() => []),
        getBattery()
      ]);
      staticCache.gpu = (gpu.controllers || []).map(g => ({ model: g.model, vram: g.vram }));
      staticCache.disks = (disk || []).map(d => ({ name: d.name, type: d.type, size: d.size }));
      staticCache.battery = batt.hasBattery ? { hasBattery: true } : { hasBattery: false };
      logger.info('System module: static info loaded');
    } catch (err) {
      logger.error('Static info background load failed', { error: err.message });
    }
  })();
}

async function start() {
  const intervals = hwProfile.getIntervals();
  const ms = intervals?.system || 5000;
  interval = setInterval(async () => {
    const subs = wsHandler.getSubscribers('system');
    if (subs.length === 0) return;
    try {
      const stats = await getLiveStats();
      wsHandler.broadcastToChannel('system', { type: 'systemStats', data: stats });
    } catch {}
  }, ms);
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
}

function health() {
  return { lastUpdate: lastStats ? Date.now() : null, historySize: history.cpu.length };
}

async function getStaticInfo() {
  if (staticCache) return staticCache;
  return { cpu: { brand: os.cpus()[0]?.model }, totalMem: os.totalmem(), gpu: [], os: { distro: 'Windows' }, disks: [], battery: { hasBattery: false } };
}

async function getLiveStats() {
  const cpu = getCpuLoad();
  const mem = getMemory();
  const [fs, batt] = await Promise.all([getFilesystems(), getBattery()]);
  const ts = Date.now();

  history.cpu.push({ ts, v: cpu.load });
  history.ram.push({ ts, v: mem.percent });
  if (history.cpu.length > MAX_HISTORY) history.cpu.shift();
  if (history.ram.length > MAX_HISTORY) history.ram.shift();

  lastStats = {
    cpu: { load: cpu.load, cores: cpu.cores },
    mem,
    fs,
    uptime: os.uptime(),
    net: [],
    battery: batt.hasBattery ? { percent: batt.percent, charging: batt.charging, timeRemaining: batt.timeRemaining } : null,
    ts
  };
  return lastStats;
}

function getHistory(channel, count) {
  const h = history[channel];
  if (!h) return [];
  return h.slice(-(count || 60));
}

function wsHandlers() {
  return {
    getSystemStats: async () => await getLiveStats(),
    getStaticInfo: async () => await getStaticInfo(),
    getSystemHistory: (msg) => ({
      cpu: getHistory('cpu', msg.count),
      ram: getHistory('ram', msg.count),
      net: getHistory('net', msg.count)
    })
  };
}

module.exports = { initialize, start, stop, health, wsHandlers, getLiveStats, getStaticInfo, getHistory };
