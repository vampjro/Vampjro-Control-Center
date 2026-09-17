const os = require('os');
const { exec } = require('child_process');

let staticCache = null;

function getLocalInterfaces() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(nets)) {
    const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (!ipv4 && addrs.every(a => a.internal)) continue;
    result.push({
      name,
      type: name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless') ? 'wireless' : 'wired',
      ip4: ipv4?.address || null,
      mac: addrs[0]?.mac || null,
      speed: null,
      dhcp: null
    });
  }
  return result;
}

function wmicRun(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000, maxBuffer: 512 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

async function getGateway() {
  try {
    const raw = await wmicRun('wmic nicconfig where "IPEnabled=true" get DefaultIPGateway /format:csv');
    const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 2) {
        const gw = parts[1].replace(/[{}"]/g, '').trim();
        if (gw && gw !== '') return gw;
      }
    }
  } catch {}
  return null;
}

async function getStaticInfo() {
  if (staticCache) return staticCache;
  const interfaces = getLocalInterfaces();
  const gateway = await getGateway();
  staticCache = { interfaces, gateway };
  return staticCache;
}

function ping() {
  return new Promise(resolve => {
    exec('ping -n 1 -w 3000 8.8.8.8', { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ reachable: false, ms: -1 });
      const match = stdout.match(/time[=<](\d+)/i);
      resolve({ reachable: true, ms: match ? parseInt(match[1]) : 0 });
    });
  });
}

function wsHandlers() {
  return {
    getNetwork: async () => {
      const info = await getStaticInfo();
      return { ...info, live: [] };
    },
    ping: async () => await ping()
  };
}

module.exports = { wsHandlers };
