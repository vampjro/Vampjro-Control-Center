const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('../core/logger');

let orionScriptPath = null;
let orionVersion = null;
let vencordSettingsPath = null;

const QUEST_BRIDGE_URL = 'http://127.0.0.1:34123/status';
const QUEST_BRIDGE_POLL_MS = 30000;
let questBridgeCache = null;
let questBridgeCacheAt = 0;
let questBridgeTimer = null;

async function pollQuestBridge() {
  try {
    const res = await fetch(QUEST_BRIDGE_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error('bad status');
    questBridgeCache = await res.json();
  } catch {
    questBridgeCache = null;
  }
  questBridgeCacheAt = Date.now();
}

function initialize() {
  const home = require('os').homedir();
  const questPath = path.join(home, 'Desktop', 'quest.txt');
  if (fs.existsSync(questPath)) {
    orionScriptPath = questPath;
    try {
      const content = fs.readFileSync(questPath, 'utf8');
      const match = content.match(/VERSION:\s*"([^"]+)"/);
      if (match) orionVersion = match[1];
    } catch {}
    logger.info(`Orion script found: ${orionVersion || 'unknown version'}`);
  }

  const vcSettingsPath = path.join(process.env.APPDATA || '', 'Vencord', 'settings', 'settings.json');
  if (fs.existsSync(vcSettingsPath)) {
    vencordSettingsPath = vcSettingsPath;
  }

  pollQuestBridge();
  questBridgeTimer = setInterval(pollQuestBridge, QUEST_BRIDGE_POLL_MS);
}

function stop() {
  if (questBridgeTimer) { clearInterval(questBridgeTimer); questBridgeTimer = null; }
}

function checkCanaryInstalled() {
  return fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'DiscordCanary'));
}

function checkVencordInstalled() {
  return fs.existsSync(path.join(process.env.APPDATA || '', 'Vencord'));
}

function getOrionPluginStatus() {
  if (!vencordSettingsPath) return { installed: false, enabled: false };
  try {
    const raw = fs.readFileSync(vencordSettingsPath, 'utf8');
    const settings = JSON.parse(raw);
    const plugin = settings?.plugins?.OrionQuests;
    if (!plugin) return { installed: false, enabled: false };
    return {
      installed: true,
      enabled: !!plugin.enabled,
      autoStart: !!plugin.autoStart,
      tryToClaimReward: !!plugin.tryToClaimReward,
      gameConcurrency: plugin.gameConcurrency || 1,
      videoConcurrency: plugin.videoConcurrency || 2
    };
  } catch {
    return { installed: false, enabled: false };
  }
}

function checkCanaryRunning() {
  return new Promise(resolve => {
    exec('wmic process where "Name=\'DiscordCanary.exe\'" get ProcessId /format:csv',
      { timeout: 5000, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err) return resolve(false);
        const lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('Node'));
        resolve(lines.length > 0);
      });
  });
}

async function getStatus() {
  const canaryInstalled = checkCanaryInstalled();
  const canaryRunning = await checkCanaryRunning();
  const vencordInstalled = checkVencordInstalled();
  const orionPlugin = getOrionPluginStatus();

  return {
    canaryInstalled,
    canaryRunning,
    vencordInstalled,
    orionAvailable: !!orionScriptPath,
    orionVersion: orionVersion || null,
    orionPlugin,
    questBridge: questBridgeCache,
    questBridgeAgeMs: questBridgeCache ? Date.now() - questBridgeCacheAt : null,
    capabilities: {
      canDetectDiscord: true,
      canDetectVencord: vencordInstalled,
      canReadOrionPlugin: !!vencordSettingsPath,
      canReadOrionScript: !!orionScriptPath
    }
  };
}

function health() {
  return { orionAvailable: !!orionScriptPath, orionVersion, questBridgeConnected: !!questBridgeCache };
}

function wsHandlers() {
  return {
    getDiscordStatus: async () => await getStatus()
  };
}

module.exports = { initialize, stop, health, wsHandlers };
