'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const db = require('./db');
const clientManager = require('./client-manager');
const ownerAuth = require('./owner-auth');
const auditLog = require('./audit-log');
const protocol = require('../../shared/protocol');

const PORT = parseInt(process.env.BACKEND_PORT) || 4000;
const HOST = process.env.BACKEND_HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const MAX_WS_PAYLOAD = 1024 * 1024;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    product: 'VAMPJRO Backend',
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    clients: clientManager.getOnlineCount()
  });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/client' || pathname === '/owner') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, pathname);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

wss.on('connection', (ws, req, pathname) => {
  const ip = (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress;

  if (pathname === '/client') {
    handleClientConnection(ws, ip);
  } else if (pathname === '/owner') {
    handleOwnerConnection(ws, ip);
  }
});

function handleClientConnection(ws, ip) {
  let clientId = null;
  let authenticated = false;
  let heartbeatTimer = null;

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(protocol.createMessage(protocol.MessageType.HEARTBEAT));
      }
    }, protocol.HEARTBEAT_INTERVAL);
  }

  ws.on('message', (raw) => {
    const msg = protocol.parseMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case protocol.MessageType.CLIENT_AUTH: {
        const result = clientManager.authenticateClient(msg.clientId, msg.secret);
        if (result.success) {
          clientId = msg.clientId;
          authenticated = true;
          clientManager.setClientSocket(clientId, ws);
          ws.send(protocol.createMessage(protocol.MessageType.CLIENT_AUTH_OK, {
            clientId,
            name: result.name
          }));
          startHeartbeat();
          auditLog.log(protocol.AuditAction.CLIENT_PAIRED, { clientId, ip });
        } else {
          ws.send(protocol.createMessage(protocol.MessageType.CLIENT_AUTH_FAIL, {
            error: result.error
          }));
        }
        break;
      }

      case protocol.MessageType.HEARTBEAT_ACK:
        if (authenticated) {
          clientManager.updateLastSeen(clientId);
        }
        break;

      case protocol.MessageType.HEALTH_REPORT:
        if (authenticated) {
          const healthJson = JSON.stringify(msg.data || {});
          if (healthJson.length <= 10240) {
            clientManager.updateHealth(clientId, msg.data);
          }
          ws.send(protocol.createMessage(protocol.MessageType.HEALTH_ACK));
        }
        break;

      case protocol.MessageType.REMOTE_RESULT:
        if (authenticated) {
          clientManager.deliverResult(clientId, msg);
        }
        break;

      case protocol.MessageType.REMOTE_ERROR:
        if (authenticated) {
          clientManager.deliverResult(clientId, msg);
        }
        break;

      case protocol.MessageType.UPDATE_STATUS:
        if (authenticated) {
          clientManager.updateClientVersion(clientId, msg.version, msg.status);
        }
        break;
    }
  });

  ws.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (clientId) {
      clientManager.removeClientSocket(clientId);
    }
  });

  ws.on('error', () => {});
}

function handleOwnerConnection(ws, ip) {
  let authenticated = false;

  ws.on('message', (raw) => {
    const msg = protocol.parseMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case protocol.MessageType.OWNER_AUTH: {
        const result = ownerAuth.authenticate(msg.token, ip);
        if (result.success) {
          authenticated = true;
          ws.send(protocol.createMessage(protocol.MessageType.OWNER_AUTH_OK));
          auditLog.log(protocol.AuditAction.OWNER_LOGIN, { ip });
        } else {
          ws.send(protocol.createMessage(protocol.MessageType.OWNER_AUTH_FAIL, {
            error: result.error,
            cooldown: result.cooldown
          }));
          auditLog.log(protocol.AuditAction.OWNER_LOGIN, { ip, failed: true });
        }
        break;
      }

      case protocol.MessageType.CLIENT_LIST:
        if (!authenticated) return;
        ws.send(protocol.createMessage(protocol.MessageType.CLIENT_LIST_RESULT, {
          clients: clientManager.getAllClients()
        }));
        break;

      case protocol.MessageType.CLIENT_STATUS:
        if (!authenticated) return;
        ws.send(protocol.createMessage(protocol.MessageType.CLIENT_STATUS_RESULT, {
          client: clientManager.getClientDetail(msg.clientId)
        }));
        break;

      case protocol.MessageType.REMOTE_COMMAND: {
        if (!authenticated) return;
        const allowedActions = new Set(Object.values(protocol.RemoteAction));
        if (!msg.action || !allowedActions.has(msg.action)) {
          ws.send(protocol.createMessage(protocol.MessageType.REMOTE_ERROR, {
            requestId: msg.requestId,
            error: 'Action not allowed'
          }));
          return;
        }
        clientManager.sendCommandToClient(msg.clientId, {
          type: protocol.MessageType.REMOTE_COMMAND,
          action: msg.action,
          params: msg.params,
          requestId: msg.requestId
        }, ws);
        auditLog.log(protocol.AuditAction.REMOTE_COMMAND_SENT, {
          clientId: msg.clientId,
          action: msg.action,
          ip
        });
        break;
      }

      case protocol.MessageType.PAIR_REQUEST: {
        if (!authenticated) return;
        const name = typeof msg.name === 'string' ? msg.name.slice(0, 100) : '';
        const validChannels = new Set(Object.values(protocol.ReleaseChannel));
        const channel = validChannels.has(msg.channel) ? msg.channel : 'stable';
        const pairingResult = clientManager.createPairing(name, channel);
        ws.send(protocol.createMessage(protocol.MessageType.PAIR_SUCCESS, pairingResult));
        break;
      }

      case protocol.MessageType.UNPAIR:
        if (!authenticated) return;
        clientManager.revokePairing(msg.clientId);
        auditLog.log(protocol.AuditAction.CLIENT_UNPAIRED, { clientId: msg.clientId, ip });
        break;

      case protocol.MessageType.UPDATE_AVAILABLE:
        if (!authenticated) return;
        clientManager.broadcastUpdate(msg);
        auditLog.log(protocol.AuditAction.UPDATE_PUSHED, {
          version: msg.version,
          channel: msg.channel,
          rollout: msg.rolloutPercent
        });
        break;

      case protocol.MessageType.AUDIT_QUERY: {
        if (!authenticated) return;
        const limit = Math.min(Math.max(parseInt(msg.limit) || 50, 1), 500);
        const offset = Math.max(parseInt(msg.offset) || 0, 0);
        const entries = auditLog.query({
          limit,
          offset,
          action: typeof msg.action === 'string' ? msg.action : undefined,
          since: typeof msg.since === 'number' ? msg.since : undefined
        });
        const total = auditLog.count();
        ws.send(protocol.createMessage(protocol.MessageType.AUDIT_QUERY_RESULT, {
          entries,
          total,
          limit,
          offset
        }));
        break;
      }
    }
  });

  ws.on('close', () => {});
  ws.on('error', () => {});
}

db.init().then(() => {
  clientManager.startStaleCheck();
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  VAMPJRO Backend Control Plane');
    console.log('  =============================');
    console.log(`  Version:   1.0.0`);
    console.log(`  Port:      ${PORT}`);
    console.log(`  Clients:   ws://HOST:${PORT}/client`);
    console.log(`  Owner:     ws://HOST:${PORT}/owner`);
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  clientManager.stopStaleCheck();
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});

process.on('SIGTERM', () => {
  clientManager.stopStaleCheck();
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});
