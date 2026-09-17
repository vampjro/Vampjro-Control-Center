'use strict';

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACKEND_PORT = parseInt(process.env.LOAD_TEST_PORT) || 4200;
const TARGET_CLIENTS = parseInt(process.env.LOAD_TEST_CLIENTS) || 1000;
const RAMP_BATCH = 50;
const RAMP_DELAY_MS = 200;
const TEST_DURATION_MS = 30000;

let backendProcess = null;
let tempDataDir = null;
const clientSockets = [];
const pairedClients = [];
let ownerWs = null;
const stats = {
  connected: 0,
  authenticated: 0,
  heartbeats: 0,
  healthReports: 0,
  errors: 0,
  rejected: 0,
  peakMemoryMB: 0,
  startTime: 0,
  endTime: 0
};

function log(msg) { console.log(`  [${((Date.now() - stats.startTime) / 1000).toFixed(1)}s] ${msg}`); }

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function waitForMsg(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

function connectWs(wsPath) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${BACKEND_PORT}${wsPath}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function createTempDataDir() {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vampjro-loadtest-'));
  return tempDataDir;
}

async function startBackend() {
  const { spawn } = require('child_process');
  const dataDir = createTempDataDir();
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      BACKEND_PORT: String(BACKEND_PORT),
      BACKEND_DATA_DIR: dataDir
    };
    backendProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'backend', 'src', 'index.js')], {
      env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let started = false;
    backendProcess.stdout.on('data', (data) => {
      if (!started && data.toString().includes('VAMPJRO Backend')) {
        started = true;
        setTimeout(resolve, 500);
      }
    });
    backendProcess.stderr.on('data', () => {});
    backendProcess.on('error', reject);
    setTimeout(() => { if (!started) reject(new Error('Backend start timeout')); }, 15000);
  });
}

async function setupOwner() {
  ownerWs = await connectWs('/owner');
  const token = crypto.randomBytes(32).toString('hex');
  ownerWs.send(JSON.stringify({ type: 'ownerAuth', token, ts: Date.now() }));
  await waitForMsg(ownerWs, 'ownerAuthOk');
  return token;
}

async function createPairings(count) {
  for (let i = 0; i < count; i++) {
    ownerWs.send(JSON.stringify({
      type: 'pairRequest',
      name: `LoadTest-${i}`,
      ts: Date.now()
    }));
    const result = await waitForMsg(ownerWs, 'pairSuccess', 10000);
    pairedClients.push({ clientId: result.clientId, secret: result.secret, index: i });
  }
}

async function connectClient(pairing) {
  try {
    const ws = await connectWs('/client');
    ws.send(JSON.stringify({
      type: 'clientAuth',
      clientId: pairing.clientId,
      secret: pairing.secret,
      ts: Date.now()
    }));

    await waitForMsg(ws, 'clientAuthOk', 5000);
    stats.authenticated++;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'heartbeat') {
          stats.heartbeats++;
          ws.send(JSON.stringify({ type: 'heartbeatAck', ts: Date.now() }));
        }
      } catch {}
    });

    ws.on('error', () => { stats.errors++; });
    clientSockets.push(ws);
    stats.connected++;
    return ws;
  } catch (e) {
    stats.rejected++;
    return null;
  }
}

async function sendHealthReports() {
  for (const ws of clientSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'healthReport',
        data: {
          cpu: Math.random() * 100,
          memTotal: 16 * 1024 * 1024 * 1024,
          memFree: Math.random() * 8 * 1024 * 1024 * 1024,
          uptime: Math.round(Math.random() * 86400),
          version: '1.0.0',
          platform: 'win32',
          nodeVersion: process.version
        },
        ts: Date.now()
      }));
      stats.healthReports++;
    }
  }
}

async function testClientList() {
  ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));
  const result = await waitForMsg(ownerWs, 'clientListResult', 15000);
  return result.clients ? result.clients.length : 0;
}

function trackMemory() {
  const mem = process.memoryUsage();
  const mb = Math.round(mem.heapUsed / 1024 / 1024);
  if (mb > stats.peakMemoryMB) stats.peakMemoryMB = mb;
  return mb;
}

async function cleanup() {
  for (const ws of clientSockets) {
    try { ws.close(); } catch {}
  }
  if (ownerWs) try { ownerWs.close(); } catch {}
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    try { backendProcess.kill('SIGKILL'); } catch {}
  }
  if (tempDataDir) {
    try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch {}
  }
}

async function run() {
  console.log('');
  console.log('VAMPJRO Backend Load Test');
  console.log('========================================');
  console.log(`Target: ${TARGET_CLIENTS} concurrent clients`);
  console.log(`Backend port: ${BACKEND_PORT}`);
  console.log('');

  stats.startTime = Date.now();

  try {
    log('Starting Backend (isolated temp data dir)...');
    await startBackend();
    log(`Backend started, data dir: ${tempDataDir}`);

    const health = await httpGet(`http://localhost:${BACKEND_PORT}/api/health`);
    log(`Health: ${health.status}`);

    log('Setting up Owner auth...');
    await setupOwner();
    log('Owner authenticated (first-time setup)');

    log(`Creating ${TARGET_CLIENTS} pairings...`);
    const pairStart = Date.now();
    await createPairings(TARGET_CLIENTS);
    log(`${TARGET_CLIENTS} pairings created in ${((Date.now() - pairStart) / 1000).toFixed(1)}s`);

    log(`Ramping up ${TARGET_CLIENTS} client connections (batches of ${RAMP_BATCH})...`);
    const rampStart = Date.now();
    for (let i = 0; i < pairedClients.length; i += RAMP_BATCH) {
      const batch = pairedClients.slice(i, i + RAMP_BATCH);
      await Promise.all(batch.map(p => connectClient(p)));
      const mem = trackMemory();
      if ((i + RAMP_BATCH) % 200 === 0 || i + RAMP_BATCH >= pairedClients.length) {
        log(`  ${stats.connected}/${TARGET_CLIENTS} connected, ${stats.authenticated} auth'd, ${mem}MB heap`);
      }
      await new Promise(r => setTimeout(r, RAMP_DELAY_MS));
    }
    log(`Ramp complete in ${((Date.now() - rampStart) / 1000).toFixed(1)}s`);

    log('Sending health reports from all clients...');
    await sendHealthReports();
    log(`${stats.healthReports} health reports sent`);

    log('Querying client list from Owner...');
    const listCount = await testClientList();
    log(`Client list returned ${listCount} clients`);

    log(`Sustaining ${TEST_DURATION_MS / 1000}s under load...`);
    const sustainStart = Date.now();
    let intervals = 0;
    while (Date.now() - sustainStart < TEST_DURATION_MS) {
      await new Promise(r => setTimeout(r, 5000));
      trackMemory();
      intervals++;
      const healthCheck = await httpGet(`http://localhost:${BACKEND_PORT}/api/health`);
      log(`  Interval #${intervals}: ${healthCheck.clients} online, ${stats.heartbeats} HBs, ${trackMemory()}MB`);
    }

    log('Sending final health reports...');
    try { await sendHealthReports(); } catch (e) { log(`Final health reports partial: ${e.message}`); }

    let finalHealth;
    try { finalHealth = await httpGet(`http://localhost:${BACKEND_PORT}/api/health`); } catch { finalHealth = { clients: '?', uptime: '?' }; }
    stats.endTime = Date.now();

    console.log('');
    console.log('========================================');
    console.log('LOAD TEST RESULTS');
    console.log('========================================');
    console.log(`Duration:          ${((stats.endTime - stats.startTime) / 1000).toFixed(1)}s`);
    console.log(`Target clients:    ${TARGET_CLIENTS}`);
    console.log(`Connected:         ${stats.connected}`);
    console.log(`Authenticated:     ${stats.authenticated}`);
    console.log(`Heartbeats recv'd: ${stats.heartbeats}`);
    console.log(`Health reports:    ${stats.healthReports}`);
    console.log(`Errors:            ${stats.errors}`);
    console.log(`Rejected:          ${stats.rejected}`);
    console.log(`Peak heap (test):  ${stats.peakMemoryMB}MB`);
    console.log(`Backend online:    ${finalHealth.clients}`);
    console.log(`Backend uptime:    ${finalHealth.uptime}s`);
    console.log('');

    const success = stats.connected >= TARGET_CLIENTS * 0.95 &&
                    stats.authenticated >= TARGET_CLIENTS * 0.95 &&
                    stats.errors < TARGET_CLIENTS * 0.05;

    if (success) {
      console.log(`RESULT: PASS — ${stats.connected}/${TARGET_CLIENTS} clients handled successfully`);
    } else {
      console.log(`RESULT: FAIL — too many errors or dropped connections`);
    }
    console.log('');

  } catch (err) {
    console.error('Load test error:', err.message);
  } finally {
    await cleanup();
  }
}

run();
