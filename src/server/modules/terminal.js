const { spawn } = require('child_process');
const logger = require('../core/logger');

const sessions = new Map();
const MAX_SESSIONS = 2;
const SESSION_TIMEOUT = 600000;

function createSession(clientId) {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
    if (oldest) destroySession(oldest[0]);
  }

  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const session = {
    proc,
    clientId,
    output: [],
    maxOutput: 500,
    lastActivity: Date.now(),
    timeout: null
  };

  session.proc.stdout.on('data', (data) => {
    const text = data.toString();
    session.output.push({ type: 'stdout', text, ts: Date.now() });
    if (session.output.length > session.maxOutput) session.output.shift();
  });

  session.proc.stderr.on('data', (data) => {
    const text = data.toString();
    session.output.push({ type: 'stderr', text, ts: Date.now() });
    if (session.output.length > session.maxOutput) session.output.shift();
  });

  session.proc.on('close', () => {
    sessions.delete(clientId);
  });

  resetTimeout(session);
  sessions.set(clientId, session);
  logger.logAction(clientId, 'terminal', 'session opened');
  return { sessionId: clientId, status: 'open' };
}

function resetTimeout(session) {
  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(() => {
    destroySession(session.clientId);
  }, SESSION_TIMEOUT);
}

function execute(clientId, command) {
  const session = sessions.get(clientId);
  if (!session) throw new Error('No active session');
  if (typeof command !== 'string' || command.length > 5000) throw new Error('Invalid command');

  session.lastActivity = Date.now();
  resetTimeout(session);

  session.output.push({ type: 'input', text: command, ts: Date.now() });
  session.proc.stdin.write(command + '\n');
  logger.logAction(clientId, 'terminal', `exec: ${command.substring(0, 100)}`);
  return { sent: true };
}

function getOutput(clientId, since) {
  const session = sessions.get(clientId);
  if (!session) return { output: [], status: 'closed' };
  const filtered = since ? session.output.filter(o => o.ts > since) : session.output.slice(-50);
  return { output: filtered, status: 'open' };
}

function destroySession(clientId) {
  const session = sessions.get(clientId);
  if (!session) return;
  if (session.timeout) clearTimeout(session.timeout);
  try { session.proc.kill(); } catch {}
  sessions.delete(clientId);
  logger.logAction(clientId, 'terminal', 'session closed');
}

function stop() {
  for (const [id] of sessions) destroySession(id);
}

function wsHandlers() {
  return {
    terminal: async (msg, client) => {
      switch (msg.action) {
        case 'open': return createSession(client.id);
        case 'exec': return execute(client.id, msg.command);
        case 'output': return getOutput(client.id, msg.since);
        case 'close': destroySession(client.id); return { status: 'closed' };
        default: throw new Error('Unknown terminal action');
      }
    }
  };
}

module.exports = { stop, wsHandlers };
