const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.env.VAMPJRO_DATA_DIR || path.join(__dirname, '..', '..', '..', 'local-data'), 'logs');
const MAX_LOG_SIZE = 512 * 1024;
const MAX_LOG_FILES = 3;

let logStream = null;
const actionLog = [];
const MAX_ACTION_LOG = 200;

function init() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  rotate();
  const logFile = path.join(LOG_DIR, 'server.log');
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
}

function rotate() {
  const logFile = path.join(LOG_DIR, 'server.log');
  if (!fs.existsSync(logFile)) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > MAX_LOG_SIZE) {
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const old = path.join(LOG_DIR, `server.${i}.log`);
        const next = path.join(LOG_DIR, `server.${i + 1}.log`);
        if (fs.existsSync(old)) {
          if (i + 1 > MAX_LOG_FILES) fs.unlinkSync(old);
          else fs.renameSync(old, next);
        }
      }
      fs.renameSync(logFile, path.join(LOG_DIR, 'server.1.log'));
    }
  } catch {}
}

function write(level, msg, meta) {
  const ts = new Date().toISOString();
  const line = meta ? `[${ts}] ${level}: ${msg} ${JSON.stringify(meta)}` : `[${ts}] ${level}: ${msg}`;
  if (logStream) logStream.write(line + '\n');
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
}

function info(msg, meta) { write('INFO', msg, meta); }
function warn(msg, meta) { write('WARN', msg, meta); }
function error(msg, meta) { write('ERROR', msg, meta); }

function logAction(device, action, result) {
  const entry = { ts: Date.now(), device, action, result };
  actionLog.push(entry);
  if (actionLog.length > MAX_ACTION_LOG) actionLog.shift();
  write('ACTION', `${device}: ${action} → ${result}`);
}

function getActionLog() { return actionLog.slice(-100); }

function close() {
  if (logStream) { logStream.end(); logStream = null; }
}

module.exports = { init, info, warn, error, logAction, getActionLog, close };
