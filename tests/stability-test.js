'use strict';

const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BACKEND_PORT = 4500;
const DURATION_MS = parseInt(process.env.STABILITY_DURATION) || 5 * 60 * 1000; // 5 min default
const NUM_CLIENTS = 50;
const SAMPLE_INTERVAL_MS = 10000;

let backendProcess = null;
let tempDataDir = null;
const clientSockets = [];
const metrics = {
  samples: [],
  heartbeats: 0,
  healthReports: 0,
  healthAcks: 0,
  reconnects: 0,
  errors: 0,
  commandsSent: 0,
  commandResults: 0,
  commandErrors: 0,
  startTime: 0,
  endTime: 0,
  peakHeapMB: 0
};

function log(msg) { console.log(`  [${((Date.now() - metrics.startTime) / 1000).toFixed(0)}s] ${msg}`); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function wsConnect(wsPath) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BACKEND_PORT}${wsPath}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitMsg(ws, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === type) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function startBackend() {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vampjro-stability-'));
  return new Promise((resolve, reject) => {
    backendProcess = spawn(process.execPath, [path.join(SRC, 'backend', 'src', 'index.js')], {
      env: { ...process.env, BACKEND_PORT: String(BACKEND_PORT), BACKEND_HOST: '127.0.0.1', BACKEND_DATA_DIR: tempDataDir },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let started = false;
    backendProcess.stdout.on('data', data => {
      if (!started && data.toString().includes('Backend')) { started = true; setTimeout(resolve, 500); }
    });
    backendProcess.stderr.on('data', () => {});
    backendProcess.on('error', reject);
    setTimeout(() => { if (!started) reject(new Error('Backend start timeout')); }, 15000);
  });
}

function trackMemory() {
  const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (mb > metrics.peakHeapMB) metrics.peakHeapMB = mb;
  return mb;
}

async function cleanup() {
  for (const ws of clientSockets) { try { ws.close(); } catch {} }
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    try { backendProcess.kill('SIGKILL'); } catch {}
  }
  if (tempDataDir) { try { fs.rmSync(tempDataDir, { recursive: true, force: true }); } catch {} }
}

async function run() {
  console.log('');
  console.log('VAMPJRO Stability Test');
  console.log('========================================');
  console.log(`Duration: ${Math.round(DURATION_MS / 60000)} minutes`);
  console.log(`Clients: ${NUM_CLIENTS}`);
  console.log(`Backend port: ${BACKEND_PORT}\n`);

  metrics.startTime = Date.now();

  try {
    log('Starting Backend...');
    await startBackend();
    log('Backend started');

    // Setup owner
    const ownerWs = await wsConnect('/owner');
    const token = crypto.randomBytes(32).toString('hex');
    ownerWs.send(JSON.stringify({ type: 'ownerAuth', token, ts: Date.now() }));
    await waitMsg(ownerWs, 'ownerAuthOk');
    log('Owner authenticated');

    // Create pairings
    const pairs = [];
    for (let i = 0; i < NUM_CLIENTS; i++) {
      ownerWs.send(JSON.stringify({ type: 'pairRequest', name: `Stab-${i}`, ts: Date.now() }));
      const pair = await waitMsg(ownerWs, 'pairSuccess');
      pairs.push(pair);
    }
    log(`${NUM_CLIENTS} pairings created`);

    // Connect all clients
    for (const pair of pairs) {
      const ws = await wsConnect('/client');
      ws.send(JSON.stringify({ type: 'clientAuth', clientId: pair.clientId, secret: pair.secret, ts: Date.now() }));
      await waitMsg(ws, 'clientAuthOk');

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'heartbeat') {
            metrics.heartbeats++;
            ws.send(JSON.stringify({ type: 'heartbeatAck', ts: Date.now() }));
          } else if (msg.type === 'healthAck') {
            metrics.healthAcks++;
          } else if (msg.type === 'remoteCommand') {
            ws.send(JSON.stringify({ type: 'remoteResult', requestId: msg.requestId, data: { ok: true }, ts: Date.now() }));
            metrics.commandResults++;
          }
        } catch {}
      });

      ws.on('error', () => { metrics.errors++; });
      ws.on('close', () => {
        // Attempt reconnect
        setTimeout(async () => {
          try {
            const newWs = await wsConnect('/client');
            newWs.send(JSON.stringify({ type: 'clientAuth', clientId: pair.clientId, secret: pair.secret, ts: Date.now() }));
            await waitMsg(newWs, 'clientAuthOk');
            const idx = clientSockets.indexOf(ws);
            if (idx >= 0) clientSockets[idx] = newWs;
            metrics.reconnects++;
          } catch {}
        }, 2000);
      });

      clientSockets.push(ws);
    }
    log(`${NUM_CLIENTS} clients connected`);

    // Owner result/error handler
    ownerWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'remoteResult') metrics.commandResults++;
        if (msg.type === 'remoteError') metrics.commandErrors++;
      } catch {}
    });

    // Sustained test loop
    const endTime = Date.now() + DURATION_MS;
    let sampleIndex = 0;

    while (Date.now() < endTime) {
      await new Promise(r => setTimeout(r, SAMPLE_INTERVAL_MS));
      sampleIndex++;

      // Send health reports
      let healthSent = 0;
      for (const ws of clientSockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'healthReport',
            data: { cpu: Math.random() * 100, memFree: Math.random() * 8e9, uptime: Math.round(Math.random() * 86400) },
            ts: Date.now()
          }));
          healthSent++;
          metrics.healthReports++;
        }
      }

      // Send some remote commands every 3rd interval
      if (sampleIndex % 3 === 0) {
        const idx = Math.floor(Math.random() * pairs.length);
        const reqId = `stab_${Date.now()}_${idx}`;
        ownerWs.send(JSON.stringify({
          type: 'remoteCommand', clientId: pairs[idx].clientId, action: 'getHealth', requestId: reqId, ts: Date.now()
        }));
        metrics.commandsSent++;
      }

      // Query audit log periodically
      if (sampleIndex % 5 === 0) {
        ownerWs.send(JSON.stringify({ type: 'auditQuery', limit: 10, ts: Date.now() }));
      }

      // Query client list
      ownerWs.send(JSON.stringify({ type: 'clientList', ts: Date.now() }));

      let health;
      try { health = await httpGet(`http://127.0.0.1:${BACKEND_PORT}/api/health`); } catch { health = { clients: '?', status: '?' }; }

      const mem = trackMemory();
      const sample = {
        ts: Date.now(),
        elapsed: Math.round((Date.now() - metrics.startTime) / 1000),
        onlineClients: health.clients,
        heartbeats: metrics.heartbeats,
        healthReports: metrics.healthReports,
        errors: metrics.errors,
        heapMB: mem,
        commands: metrics.commandsSent,
        reconnects: metrics.reconnects
      };
      metrics.samples.push(sample);

      log(`Sample #${sampleIndex}: ${health.clients} online, ${metrics.heartbeats} HBs, ${metrics.healthReports} HRs, ${metrics.errors} errs, ${mem}MB, ${metrics.reconnects} reconns`);
    }

    metrics.endTime = Date.now();
    ownerWs.close();

    // Results
    const duration = Math.round((metrics.endTime - metrics.startTime) / 1000);
    const firstSample = metrics.samples[0];
    const lastSample = metrics.samples[metrics.samples.length - 1];
    const heapGrowth = lastSample ? lastSample.heapMB - (firstSample?.heapMB || 0) : 0;
    const maxHeap = Math.max(...metrics.samples.map(s => s.heapMB));
    const minHeap = Math.min(...metrics.samples.map(s => s.heapMB));

    console.log('\n========================================');
    console.log('STABILITY TEST RESULTS');
    console.log('========================================');
    console.log(`Duration:          ${duration}s (${Math.round(duration / 60)} min)`);
    console.log(`Clients:           ${NUM_CLIENTS}`);
    console.log(`Heartbeats:        ${metrics.heartbeats}`);
    console.log(`Health reports:    ${metrics.healthReports}`);
    console.log(`Health ACKs:       ${metrics.healthAcks}`);
    console.log(`Commands sent:     ${metrics.commandsSent}`);
    console.log(`Command results:   ${metrics.commandResults}`);
    console.log(`Command errors:    ${metrics.commandErrors}`);
    console.log(`Reconnects:        ${metrics.reconnects}`);
    console.log(`Errors:            ${metrics.errors}`);
    console.log(`Peak heap:         ${metrics.peakHeapMB}MB`);
    console.log(`Heap range:        ${minHeap}-${maxHeap}MB`);
    console.log(`Heap growth:       ${heapGrowth > 0 ? '+' : ''}${heapGrowth}MB`);
    console.log(`Samples:           ${metrics.samples.length}`);
    console.log('');

    const stable = metrics.errors < NUM_CLIENTS * 0.1 &&
                   heapGrowth < 50 &&
                   metrics.heartbeats > 0;

    if (stable) {
      console.log('RESULT: PASS — system stable throughout test');
    } else {
      console.log('RESULT: FAIL — instability detected');
      if (metrics.errors >= NUM_CLIENTS * 0.1) console.log('  → Too many errors');
      if (heapGrowth >= 50) console.log('  → Excessive heap growth (memory leak?)');
      if (metrics.heartbeats === 0) console.log('  → No heartbeats received');
    }
    console.log('');

  } catch (err) {
    console.error('Stability test error:', err.message);
  } finally {
    await cleanup();
  }
}

run();
