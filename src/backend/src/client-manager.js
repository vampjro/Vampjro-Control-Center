'use strict';

const crypto = require('crypto');
const db = require('./db');
const protocol = require('../../shared/protocol');

const clientSockets = new Map();
const pendingResults = new Map();
const COMMAND_TIMEOUT_MS = 30000;
const STALE_THRESHOLD_MS = 90000;
let staleCheckTimer = null;

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function createPairing(name, channel = 'stable') {
  const clientId = protocol.generateClientId();
  const secret = crypto.randomBytes(32).toString('hex');
  const secretHash = hashSecret(secret);
  const pairingCode = protocol.generatePairingCode();

  db.prepare(
    'INSERT INTO clients (id, name, secret_hash, channel, paired_at) VALUES (?, ?, ?, ?, ?)'
  ).run(clientId, name || 'Unnamed Client', secretHash, channel, Date.now());

  return { clientId, secret, pairingCode };
}

function authenticateClient(clientId, secret) {
  if (!clientId || !secret) return { success: false, error: 'Missing credentials' };

  const client = db.prepare(
    'SELECT * FROM clients WHERE id = ? AND revoked = 0'
  ).get(clientId);

  if (!client) return { success: false, error: 'Unknown or revoked client' };

  const secretHash = hashSecret(secret);
  if (!crypto.timingSafeEqual(Buffer.from(client.secret_hash), Buffer.from(secretHash))) {
    return { success: false, error: 'Invalid secret' };
  }

  db.prepare(
    'UPDATE clients SET state = ?, last_seen = ? WHERE id = ?'
  ).run('online', Date.now(), clientId);

  return { success: true, name: client.name };
}

function setClientSocket(clientId, ws) {
  clientSockets.set(clientId, ws);
  db.prepare('UPDATE clients SET state = ? WHERE id = ?').run('online', clientId);
}

function removeClientSocket(clientId) {
  clientSockets.delete(clientId);
  db.prepare(
    'UPDATE clients SET state = ?, last_seen = ? WHERE id = ?'
  ).run('offline', Date.now(), clientId);
}

function updateLastSeen(clientId) {
  db.prepare('UPDATE clients SET last_seen = ? WHERE id = ?').run(Date.now(), clientId);
}

function updateHealth(clientId, data) {
  db.prepare(
    'UPDATE clients SET last_health = ?, last_seen = ? WHERE id = ?'
  ).run(JSON.stringify(data), Date.now(), clientId);
}

function updateClientVersion(clientId, version, status) {
  const state = status === 'installed' ? 'online' : 'updating';
  db.prepare(
    'UPDATE clients SET version = ?, state = ? WHERE id = ?'
  ).run(version, state, clientId);
}

function sendToClient(clientId, msg) {
  const ws = clientSockets.get(clientId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function deliverResult(clientId, msg) {
  const entry = pendingResults.get(msg.requestId);
  if (entry) {
    if (entry.targetClientId && entry.targetClientId !== clientId) return;
    clearTimeout(entry.timer);
    entry.callback(msg);
    pendingResults.delete(msg.requestId);
  }
}

function sendCommandToClient(clientId, msg, ownerWs) {
  const sent = sendToClient(clientId, msg);
  if (!sent) {
    if (ownerWs && ownerWs.readyState === ownerWs.OPEN) {
      ownerWs.send(JSON.stringify({
        type: protocol.MessageType.REMOTE_ERROR,
        requestId: msg.requestId,
        error: 'Client offline'
      }));
    }
    return;
  }

  const timer = setTimeout(() => {
    pendingResults.delete(msg.requestId);
    if (ownerWs && ownerWs.readyState === ownerWs.OPEN) {
      ownerWs.send(JSON.stringify({
        type: protocol.MessageType.REMOTE_ERROR,
        requestId: msg.requestId,
        error: 'Command timeout'
      }));
    }
  }, COMMAND_TIMEOUT_MS);

  pendingResults.set(msg.requestId, {
    targetClientId: clientId,
    callback: (result) => {
      if (ownerWs && ownerWs.readyState === ownerWs.OPEN) {
        ownerWs.send(JSON.stringify(result));
      }
    },
    timer
  });
}

function startStaleCheck() {
  if (staleCheckTimer) return;
  staleCheckTimer = setInterval(() => {
    const now = Date.now();
    const rows = db.prepare(
      'SELECT id, last_seen FROM clients WHERE state = ? AND revoked = 0'
    ).all('online');

    for (const row of rows) {
      if (row.last_seen && (now - row.last_seen) > STALE_THRESHOLD_MS) {
        if (!clientSockets.has(row.id)) {
          db.prepare('UPDATE clients SET state = ? WHERE id = ?').run('offline', row.id);
        }
      }
    }
  }, 60000);
}

function stopStaleCheck() {
  if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
}

function revokePairing(clientId) {
  const ws = clientSockets.get(clientId);
  if (ws) {
    ws.send(protocol.createMessage(protocol.MessageType.UNPAIR));
    ws.close();
  }
  clientSockets.delete(clientId);
  db.prepare('UPDATE clients SET revoked = 1, state = ? WHERE id = ?').run('offline', clientId);
}

function getAllClients() {
  const rows = db.prepare(
    'SELECT id, name, channel, version, state, last_seen, paired_at, revoked FROM clients ORDER BY paired_at DESC'
  ).all();

  return rows.map(r => ({
    ...r,
    online: clientSockets.has(r.id) && !r.revoked
  }));
}

function getClientDetail(clientId) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return null;

  let lastHealth = null;
  try { lastHealth = client.last_health ? JSON.parse(client.last_health) : null; } catch {}

  return {
    id: client.id,
    name: client.name,
    channel: client.channel,
    version: client.version,
    state: client.state,
    lastSeen: client.last_seen,
    lastHealth,
    pairedAt: client.paired_at,
    revoked: !!client.revoked,
    online: clientSockets.has(client.id) && !client.revoked
  };
}

function getOnlineCount() {
  return clientSockets.size;
}

function broadcastUpdate(updateMsg) {
  const channel = updateMsg.channel || 'stable';
  const rollout = updateMsg.rolloutPercent || 100;

  const clients = db.prepare(
    'SELECT id FROM clients WHERE channel = ? AND revoked = 0'
  ).all(channel);

  let sent = 0;
  for (const client of clients) {
    if (rollout < 100) {
      const hash = crypto.createHash('md5').update(client.id + updateMsg.version).digest();
      const bucket = hash[0] % 100;
      if (bucket >= rollout) continue;
    }

    if (sendToClient(client.id, {
      type: protocol.MessageType.UPDATE_AVAILABLE,
      version: updateMsg.version,
      downloadUrl: updateMsg.downloadUrl,
      sha256: updateMsg.sha256,
      notes: updateMsg.notes,
      mandatory: updateMsg.mandatory || false
    })) {
      sent++;
    }
  }

  return sent;
}

module.exports = {
  createPairing,
  authenticateClient,
  setClientSocket,
  removeClientSocket,
  updateLastSeen,
  updateHealth,
  updateClientVersion,
  sendToClient,
  sendCommandToClient,
  deliverResult,
  revokePairing,
  getAllClients,
  getClientDetail,
  getOnlineCount,
  broadcastUpdate,
  startStaleCheck,
  stopStaleCheck
};
