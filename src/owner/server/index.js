'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const protocol = require('../../shared/protocol');

const VERSION = require('../package.json').version;

const PORT = parseInt(process.env.OWNER_PORT) || 5000;
const HOST = process.env.OWNER_HOST || '127.0.0.1';
const BACKEND_URL = process.env.BACKEND_URL || 'ws://localhost:4000/owner';

const app = express();
const server = http.createServer(app);
const localWss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json());

// The release pipeline only works from a full dev checkout (it needs
// tests/, build/, and .env.release next to this repo) — never from an
// installed, distributed Owner EXE. Loaded lazily so a missing build/
// directory in an installed copy doesn't crash startup; its absence is
// exactly how the UI knows to hide the Release Manager section.
const RELEASE_PIPELINE_PATH = path.join(__dirname, '..', '..', '..', 'build', 'scripts', 'release-pipeline.js');
let releasePipeline = null;
try {
  if (require('fs').existsSync(RELEASE_PIPELINE_PATH)) {
    releasePipeline = require(RELEASE_PIPELINE_PATH);
  }
} catch (_) { releasePipeline = null; }

let releaseInProgress = false;

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    product: 'VAMPJRO Control Owner',
    version: VERSION,
    uptime: Math.round(process.uptime()),
    backendConnected: backendWs && backendWs.readyState === WebSocket.OPEN
  });
});

app.get('/api/release/available', (req, res) => {
  res.json({ available: !!releasePipeline });
});

app.get('/api/release/config', (req, res) => {
  if (!releasePipeline) return res.status(404).json({ error: 'Release pipeline not available' });
  res.json(releasePipeline.maskedConfig());
});

app.post('/api/release/config', (req, res) => {
  if (!releasePipeline) return res.status(404).json({ error: 'Release pipeline not available' });
  const { githubOwner, githubRepository, githubRepoVisibility, gistId, githubToken } = req.body || {};
  const update = {};
  if (githubOwner !== undefined) update.GITHUB_OWNER = githubOwner;
  if (githubRepository !== undefined) update.GITHUB_REPOSITORY = githubRepository;
  if (githubRepoVisibility !== undefined) update.GITHUB_REPO_VISIBILITY = githubRepoVisibility;
  if (gistId !== undefined) update.GIST_ID = gistId;
  if (githubToken) update.GITHUB_TOKEN = githubToken; // only overwrite if a new one was actually entered
  releasePipeline.saveReleaseConfig(update);
  res.json(releasePipeline.maskedConfig());
});

app.get('/api/release/test-connection', async (req, res) => {
  if (!releasePipeline) return res.status(404).json({ error: 'Release pipeline not available' });
  const cfg = releasePipeline.loadReleaseConfig();
  const result = await releasePipeline.stepValidateConnection(cfg);
  res.json(result);
});

app.get('/api/release/history', (req, res) => {
  if (!releasePipeline) return res.status(404).json({ error: 'Release pipeline not available' });
  res.json(releasePipeline.getHistory());
});

app.post('/api/release/publish', async (req, res) => {
  if (!releasePipeline) return res.status(404).json({ error: 'Release pipeline not available' });
  if (releaseInProgress) return res.status(409).json({ error: 'A release is already in progress' });
  const { version, releaseNotes, dryRun } = req.body || {};
  if (!version) return res.status(400).json({ error: 'version is required' });

  releaseInProgress = true;
  broadcastToLocal({ type: 'releaseStarted', version, dryRun: !!dryRun });
  try {
    const result = await releasePipeline.publishRelease({ version, releaseNotes, dryRun: !!dryRun }, (progress) => {
      broadcastToLocal({ type: 'releaseProgress', ...progress });
    });
    broadcastToLocal({ type: 'releaseFinished', result });
    res.json(result);
  } catch (err) {
    const failure = { version, status: 'failed', error: err.message };
    broadcastToLocal({ type: 'releaseFinished', result: failure });
    res.status(500).json(failure);
  } finally {
    releaseInProgress = false;
  }
});

let backendWs = null;
let backendAuthenticated = false;
let ownerToken = null;
let reconnectDelay = 1000;
let localClients = new Set();

function connectToBackend() {
  try { backendWs = new WebSocket(BACKEND_URL); } catch (_) { scheduleReconnect(); return; }

  backendWs.on('open', () => {
    console.log('[Owner] Connected to Backend');
    reconnectDelay = 1000;

    if (ownerToken) {
      backendWs.send(protocol.createMessage(protocol.MessageType.OWNER_AUTH, {
        token: ownerToken
      }));
    }
  });

  backendWs.on('message', (raw) => {
    const msg = protocol.parseMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case protocol.MessageType.OWNER_AUTH_OK:
        backendAuthenticated = true;
        broadcastToLocal({ type: 'backendConnected', authenticated: true });
        break;

      case protocol.MessageType.OWNER_AUTH_FAIL:
        backendAuthenticated = false;
        broadcastToLocal({ type: 'backendAuthFailed', error: msg.error });
        break;

      default:
        broadcastToLocal(msg);
        break;
    }
  });

  backendWs.on('close', () => {
    console.log('[Owner] Backend disconnected');
    backendAuthenticated = false;
    broadcastToLocal({ type: 'backendDisconnected' });
    scheduleReconnect();
  });

  backendWs.on('error', () => {});
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
    connectToBackend();
  }, reconnectDelay);
}

function sendToBackend(msg) {
  if (backendWs && backendWs.readyState === WebSocket.OPEN) {
    backendWs.send(JSON.stringify(msg));
  }
}

function broadcastToLocal(msg) {
  const data = JSON.stringify(msg);
  for (const client of localClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

localWss.on('connection', (ws) => {
  localClients.add(ws);

  ws.send(JSON.stringify({
    type: 'status',
    backendConnected: backendAuthenticated
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setToken') {
      ownerToken = msg.token;
      if (backendWs && backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(protocol.createMessage(protocol.MessageType.OWNER_AUTH, {
          token: ownerToken
        }));
      }
      return;
    }

    const allowedTypes = new Set([
      protocol.MessageType.CLIENT_LIST,
      protocol.MessageType.CLIENT_STATUS,
      protocol.MessageType.REMOTE_COMMAND,
      protocol.MessageType.PAIR_REQUEST,
      protocol.MessageType.UNPAIR,
      protocol.MessageType.UPDATE_AVAILABLE,
      protocol.MessageType.AUDIT_QUERY
    ]);
    if (!allowedTypes.has(msg.type)) return;

    sendToBackend(msg);
  });

  ws.on('close', () => localClients.delete(ws));
  ws.on('error', () => {});
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  VAMPJRO Control Owner');
  console.log('  =====================');
  console.log(`  Version:   ${VERSION}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Backend:   ${BACKEND_URL}`);
  console.log('');
});

connectToBackend();

process.on('SIGINT', () => {
  if (backendWs) backendWs.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
});
