const os = require('os');
const { exec } = require('child_process');
const config = require('../core/config');
const logger = require('../core/logger');

let profile = null;

function wmicRun(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000, maxBuffer: 512 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
  });
}

async function detect() {
  try {
    const cpus = os.cpus();
    const brand = cpus[0]?.model || 'Unknown CPU';
    const speed = (cpus[0]?.speed || 2000) / 1000;
    const threads = cpus.length;
    const cores = Math.max(1, Math.floor(threads / 2));
    const ramGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);

    let hasSSD = false;
    let gpuModel = '';
    let hasDiscreteGPU = false;

    try {
      const diskRaw = await wmicRun('wmic diskdrive get MediaType,Model /format:csv');
      hasSSD = diskRaw.toLowerCase().includes('ssd') || diskRaw.toLowerCase().includes('solid');
    } catch {}

    try {
      const gpuRaw = await wmicRun('wmic path win32_VideoController get Name /format:csv');
      const gpuLines = gpuRaw.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
      const gpuNames = gpuLines.map(l => l.split(',').pop()?.trim()).filter(Boolean);
      gpuModel = gpuNames.join(', ');
      hasDiscreteGPU = gpuNames.some(g =>
        !g.toLowerCase().includes('intel') && !g.toLowerCase().includes('integrated')
      );
    } catch {}

    let score = 0;
    if (cores >= 8 && speed >= 3) score += 30;
    else if (cores >= 4 && speed >= 2.5) score += 20;
    else if (cores >= 2) score += 10;

    if (ramGB >= 32) score += 25;
    else if (ramGB >= 16) score += 20;
    else if (ramGB >= 8) score += 15;
    else score += 5;

    if (hasSSD) score += 25;
    else score += 5;

    if (hasDiscreteGPU) score += 20;
    else score += 5;

    let tier;
    if (score >= 70) tier = 'HIGH';
    else if (score >= 45) tier = 'MEDIUM';
    else tier = 'LOW';

    profile = {
      tier, score,
      details: {
        cpu: brand, cores, threads, speed, ramGB,
        storage: hasSSD ? 'SSD' : 'HDD',
        gpu: gpuModel, discreteGPU: hasDiscreteGPU
      }
    };

    const userProfile = config.get('performance.profile');
    if (userProfile && userProfile !== 'auto') {
      profile.effectiveTier = userProfile.toUpperCase();
    } else {
      profile.effectiveTier = tier;
    }

    config.set('performance.tier', tier);
    logger.info(`Hardware tier: ${tier} (score: ${score})`, profile.details);
    return profile;
  } catch (err) {
    logger.error('Hardware profiling failed', { error: err.message });
    profile = { tier: 'LOW', effectiveTier: 'LOW', score: 0, details: {} };
    return profile;
  }
}

function getProfile() { return profile; }

function getEffectiveTier() {
  if (!profile) return 'LOW';
  return profile.effectiveTier || profile.tier;
}

function getIntervals() {
  const tier = getEffectiveTier().toLowerCase();
  return config.get(`intervals.${tier}`) || config.get('intervals.low');
}

module.exports = { detect, getProfile, getEffectiveTier, getIntervals };
