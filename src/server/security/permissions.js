const config = require('../core/config');

const LEVELS = {
  READ: 0,
  CONTROL: 1,
  DANGEROUS: 2,
  ADMIN: 3
};

const ACTION_LEVELS = {
  getSystemStats: LEVELS.READ,
  getProcesses: LEVELS.READ,
  getCrashLogs: LEVELS.READ,
  getVolume: LEVELS.READ,
  getBrightness: LEVELS.READ,
  getClipboard: LEVELS.READ,
  getWindows: LEVELS.READ,
  getNetwork: LEVELS.READ,
  getStorage: LEVELS.READ,
  getAudio: LEVELS.READ,
  getModuleStatus: LEVELS.READ,
  getUpdateStatus: LEVELS.READ,
  checkUpdates: LEVELS.READ,
  getDownloadStatus: LEVELS.READ,
  getDiscordStatus: LEVELS.READ,
  getStaticInfo: LEVELS.READ,
  getSystemHistory: LEVELS.READ,
  getMusicStatus: LEVELS.READ,
  getKeepAwakeStatus: LEVELS.READ,
  refreshCrashLogs: LEVELS.READ,
  getBackendStatus: LEVELS.READ,

  setVolume: LEVELS.CONTROL,
  setMute: LEVELS.CONTROL,
  setBrightness: LEVELS.CONTROL,
  screenshot: LEVELS.CONTROL,
  setClipboard: LEVELS.CONTROL,
  keepAwake: LEVELS.CONTROL,
  clearKeepAwake: LEVELS.CONTROL,
  musicCommand: LEVELS.CONTROL,
  setAudioVolume: LEVELS.CONTROL,
  focusWindow: LEVELS.CONTROL,
  minimizeWindow: LEVELS.CONTROL,
  maximizeWindow: LEVELS.CONTROL,
  downloadUpdate: LEVELS.CONTROL,
  launchDiscord: LEVELS.CONTROL,
  openMusicPlayer: LEVELS.CONTROL,

  killProcess: LEVELS.DANGEROUS,
  closeWindow: LEVELS.DANGEROUS,
  lock: LEVELS.DANGEROUS,
  sleep: LEVELS.DANGEROUS,

  shutdown: LEVELS.ADMIN,
  restart: LEVELS.ADMIN,
  terminal: LEVELS.ADMIN,
  shutdownTimer: LEVELS.ADMIN,
  installUpdate: LEVELS.ADMIN
};

function getLevelName(level) {
  return Object.keys(LEVELS).find(k => LEVELS[k] === level) || 'UNKNOWN';
}

function check(action) {
  const safeMode = config.get('security.safeMode');
  const level = ACTION_LEVELS[action];

  // Unknown actions must never be implicitly allowed.
  if (level === undefined) {
    return {
      allowed: false,
      level: 'UNKNOWN',
      reason: 'Unknown action'
    };
  }

  if (safeMode && level >= LEVELS.DANGEROUS) {
    return {
      allowed: false,
      level: getLevelName(level),
      reason: 'Safe Mode enabled'
    };
  }

  return {
    allowed: true,
    level: getLevelName(level),
    requiresConfirmation: level >= LEVELS.DANGEROUS
  };
}

function isDangerous(action) {
  const level = ACTION_LEVELS[action];
  return level !== undefined && level >= LEVELS.DANGEROUS;
}

function getRequiredLevel(action) {
  const level = ACTION_LEVELS[action];
  return level === undefined ? null : getLevelName(level);
}

module.exports = {
  check,
  isDangerous,
  getRequiredLevel,
  LEVELS,
  ACTION_LEVELS
};