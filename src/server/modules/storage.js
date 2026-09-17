const { exec } = require('child_process');
const si = require('systeminformation');

let diskLayoutCache = null;

function wmicRun(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000, maxBuffer: 512 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

async function getPartitions() {
  try {
    const raw = await wmicRun('wmic logicaldisk get DeviceID,Size,FreeSpace,FileSystem /format:csv');
    const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
    const parts = [];
    for (const line of lines) {
      const cols = line.split(',');
      if (cols.length >= 5) {
        const mount = cols[1].trim();
        const fs = cols[2].trim();
        const free = parseInt(cols[3]) || 0;
        const size = parseInt(cols[4]) || 0;
        if (size > 0) {
          const used = size - free;
          parts.push({ mount, type: fs, size, used, available: free, percent: Math.round(used / size * 1000) / 10 });
        }
      }
    }
    return parts;
  } catch {
    return [];
  }
}

async function getDiskLayout() {
  if (diskLayoutCache) return diskLayoutCache;
  try {
    const layout = await si.diskLayout();
    diskLayoutCache = (layout || []).map(d => ({
      name: d.name, type: d.type, size: d.size, vendor: d.vendor, interfaceType: d.interfaceType
    }));
  } catch {
    diskLayoutCache = [];
  }
  return diskLayoutCache;
}

async function getStorage() {
  const [disks, partitions] = await Promise.all([getDiskLayout(), getPartitions()]);
  return { disks, partitions };
}

function wsHandlers() {
  return {
    getStorage: async () => await getStorage()
  };
}

module.exports = { wsHandlers };
