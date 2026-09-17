const ps = require('../utils/powershell');
const logger = require('../core/logger');

let awakeTimer = null;
let awakeUntil = null;
let awakeMode = null;

async function setKeepAwake(duration) {
  await clearKeepAwake();
  const minutes = parseInt(duration, 10);

  await ps.run("powercfg /change standby-timeout-ac 0; powercfg /change standby-timeout-dc 0; powercfg /change monitor-timeout-ac 0; powercfg /change monitor-timeout-dc 0");

  if (minutes > 0) {
    awakeUntil = Date.now() + minutes * 60 * 1000;
    awakeMode = `${minutes}min`;
    awakeTimer = setTimeout(async () => {
      await clearKeepAwake();
    }, minutes * 60 * 1000);
  } else {
    awakeUntil = null;
    awakeMode = 'indefinite';
  }

  logger.logAction('panel', 'keepAwake', awakeMode);
  return { active: true, mode: awakeMode, until: awakeUntil };
}

async function clearKeepAwake() {
  if (awakeTimer) { clearTimeout(awakeTimer); awakeTimer = null; }
  awakeUntil = null;
  awakeMode = null;
  try {
    await ps.run("powercfg /change standby-timeout-ac 30; powercfg /change standby-timeout-dc 15; powercfg /change monitor-timeout-ac 10; powercfg /change monitor-timeout-dc 5");
  } catch {}
  return { active: false };
}

function getStatus() {
  if (!awakeMode) return { active: false };
  if (awakeUntil && Date.now() > awakeUntil) {
    awakeMode = null;
    awakeUntil = null;
    return { active: false };
  }
  return { active: true, mode: awakeMode, until: awakeUntil, remaining: awakeUntil ? awakeUntil - Date.now() : null };
}

function stop() { clearKeepAwake(); }

function wsHandlers() {
  return {
    keepAwake: async (msg) => await setKeepAwake(msg.duration),
    clearKeepAwake: async () => await clearKeepAwake(),
    getKeepAwakeStatus: () => getStatus()
  };
}

module.exports = { stop, wsHandlers };
