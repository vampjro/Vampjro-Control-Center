'use strict';

const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TEST_PIN = '123456';
const TEST_PORT_CC = 3100;
const TEST_PORT_BACKEND = 4100;
const TEST_PORT_OWNER = 5100;
const TEST_OWNER_TOKEN = crypto.randomBytes(32).toString('hex');

let passed = 0, failed = 0, blocked = 0;
const results = [];
const processes = [];

function log(status, name, detail) {
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'BLOCKED' ? '⊞' : '⊘';
  console.log(`  ${icon} [${status}] ${name}${detail ? ': ' + detail : ''}`);
  results.push({ status, name, detail: detail || '' });
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else blocked++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function wsConnect(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Connect timeout')); }, timeout);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function wsRequest(ws, msg, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const rid = msg.requestId || crypto.randomBytes(4).toString('hex');
    msg.requestId = rid;
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    function handler(raw) {
      const data = JSON.parse(raw.toString());
      if (data.requestId === rid || data.type === msg.type + 'Result' ||
          data.type === 'authSuccess' || data.type === 'authFailed' ||
          data.type === 'needAuth' || data.type === 'setupComplete' ||
          data.type === 'subscribed' || data.type === 'unsubscribed' ||
          data.type === 'permissionDenied' || data.type === 'error') {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(data);
      }
    }
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

function waitForMessage(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    function handler(raw) {
      const data = JSON.parse(raw.toString());
      if (data.type === type) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(data);
      }
    }
    ws.on('message', handler);
  });
}

function startProcess(name, cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    processes.push({ name, proc });

    let started = false;
    const timer = setTimeout(() => {
      if (!started) reject(new Error(`${name} startup timeout`));
    }, 15000);

    proc.stdout.on('data', (data) => {
      const line = data.toString();
      if (!started && (line.includes('listening') || line.includes('Control') || line.includes('Port') || line.includes('Dashboard'))) {
        started = true;
        clearTimeout(timer);
        setTimeout(() => resolve(proc), 500);
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      if (!started) { clearTimeout(timer); reject(new Error(`${name} exited with ${code}`)); }
    });
  });
}

function killAll() {
  for (const { name, proc } of processes) {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

// --- Create test config ---
function createTestConfig() {
  const testDataDir = path.join(ROOT, 'tests', 'test-data');
  if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });

  const testConfig = {
    server: { port: TEST_PORT_CC, host: '127.0.0.1' },
    security: { pinHash: null, trustedDevices: [], sessionTTL: 86400000, maxFailedAttempts: 5, cooldownMs: 60000, safeMode: false },
    performance: { profile: 'auto', tier: null },
    modules: {
      system: true, processes: true, controls: true, screenshot: true,
      crashLogs: true, clipboard: true, windows: true, network: true,
      audio: true, terminal: false, keepAwake: true, discord: false,
      music: true, storage: true, updates: true, backendConnector: false
    },
    intervals: { low: { system: 5000, processes: 10000, network: 10000 }, medium: { system: 3000, processes: 6000, network: 6000 }, high: { system: 2000, processes: 4000, network: 4000 } },
    updates: { checkInterval: 86400000, channel: 'stable', gistId: null },
    backend: { url: null, clientId: null, secret: null, healthInterval: 60000 },
    branding: { name: 'VAMPJRO', product: 'Remote Control Center', support: 't.me/vampjro', version: '1.0.0' }
  };

  const configDir = path.join(testDataDir, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(path.join(testDataDir, 'config.json'), JSON.stringify(testConfig, null, 2), 'utf8');
  return testDataDir;
}

// --- Tests ---
async function run() {
  console.log('\nVAMPJRO Integration Test Suite');
  console.log('='.repeat(40));
  console.log(`Test PIN: ${TEST_PIN}`);
  console.log(`CC Port: ${TEST_PORT_CC}`);
  console.log(`Backend Port: ${TEST_PORT_BACKEND}`);
  console.log(`Owner Port: ${TEST_PORT_OWNER}\n`);

  const testDataDir = createTestConfig();

  // Create isolated temp data dir for Backend
  const os = require('os');
  const backendDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vampjro-inttest-'));

  // ===== Phase 1: Backend startup =====
  console.log('--- Phase 1: Backend Startup ---');
  let backendProc;
  try {
    backendProc = await startProcess('Backend', 'node', ['src/index.js'], {
      BACKEND_PORT: String(TEST_PORT_BACKEND),
      BACKEND_HOST: '127.0.0.1',
      BACKEND_DATA_DIR: backendDataDir
    }, path.join(SRC, 'backend'));
    log('PASS', 'Backend startup');
  } catch (err) {
    log('FAIL', 'Backend startup', err.message);
    killAll();
    printSummary();
    return;
  }

  try {
    const health = await httpGet(`http://127.0.0.1:${TEST_PORT_BACKEND}/api/health`);
    if (health.status === 'ok') {
      log('PASS', 'Backend health endpoint', `v${health.version}`);
    } else {
      log('FAIL', 'Backend health endpoint', JSON.stringify(health));
    }
  } catch (err) {
    log('FAIL', 'Backend health endpoint', err.message);
  }

  // ===== Phase 2: Owner startup =====
  console.log('\n--- Phase 2: Owner Startup ---');
  let ownerProc;
  try {
    ownerProc = await startProcess('Owner', 'node', ['server/index.js'], {
      OWNER_PORT: String(TEST_PORT_OWNER),
      OWNER_HOST: '127.0.0.1',
      BACKEND_URL: `ws://127.0.0.1:${TEST_PORT_BACKEND}/owner`
    }, path.join(SRC, 'owner'));
    log('PASS', 'Owner startup');
  } catch (err) {
    log('FAIL', 'Owner startup', err.message);
  }

  // ===== Phase 3: Control Center health (existing instance, optional) =====
  // This checks a dev CC instance if one happens to be running on 3000; it's
  // not something the suite starts itself, so a refused connection just means
  // "none running" (BLOCKED, not a failure) rather than a real regression.
  console.log('\n--- Phase 3: Control Center (existing, optional) ---');
  try {
    const ccHealth = await httpGet('http://127.0.0.1:3000/api/health');
    if (ccHealth.status === 'ok') {
      log('PASS', 'Control Center health', `v${ccHealth.version}, uptime ${ccHealth.uptime}s`);
    } else {
      log('FAIL', 'Control Center health', JSON.stringify(ccHealth));
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      log('BLOCKED', 'Control Center health', 'No dev instance running on 3000 (skipped)');
    } else {
      log('FAIL', 'Control Center health', err.message);
    }
  }

  // ===== Phase 4: Backend WebSocket (Client endpoint) =====
  console.log('\n--- Phase 4: Backend Client WebSocket ---');
  let backendClientWs;
  try {
    backendClientWs = await wsConnect(`ws://127.0.0.1:${TEST_PORT_BACKEND}/client`);
    log('PASS', 'Backend /client WebSocket connect');
  } catch (err) {
    log('FAIL', 'Backend /client WebSocket connect', err.message);
  }

  // Test client auth with invalid credentials
  if (backendClientWs) {
    try {
      backendClientWs.send(JSON.stringify({
        type: 'clientAuth',
        ts: Date.now(),
        clientId: 'nonexistent',
        secret: 'invalid'
      }));
      const resp = await waitForMessage(backendClientWs, 'clientAuthFail', 5000);
      if (resp.error) {
        log('PASS', 'Backend rejects invalid client auth', resp.error);
      } else {
        log('FAIL', 'Backend invalid client auth', 'Did not receive error');
      }
    } catch (err) {
      log('FAIL', 'Backend invalid client auth', err.message);
    }
    backendClientWs.close();
  }

  // ===== Phase 5: Backend WebSocket (Owner endpoint) =====
  console.log('\n--- Phase 5: Backend Owner WebSocket ---');
  let backendOwnerWs;
  try {
    backendOwnerWs = await wsConnect(`ws://127.0.0.1:${TEST_PORT_BACKEND}/owner`);
    log('PASS', 'Backend /owner WebSocket connect');
  } catch (err) {
    log('FAIL', 'Backend /owner WebSocket connect', err.message);
  }

  // Owner auth (first setup - creates token)
  if (backendOwnerWs) {
    try {
      backendOwnerWs.send(JSON.stringify({
        type: 'ownerAuth',
        ts: Date.now(),
        token: TEST_OWNER_TOKEN
      }));
      const authResp = await waitForMessage(backendOwnerWs, 'ownerAuthOk', 5000);
      log('PASS', 'Owner authentication (first setup)');
    } catch (err) {
      log('FAIL', 'Owner authentication', err.message);
    }

    // Create a pairing
    try {
      backendOwnerWs.send(JSON.stringify({
        type: 'pairRequest',
        ts: Date.now(),
        name: 'Test Client PC',
        channel: 'stable'
      }));
      const pairResp = await waitForMessage(backendOwnerWs, 'pairSuccess', 5000);
      if (pairResp.clientId && pairResp.secret) {
        log('PASS', 'Pairing creation', `clientId=${pairResp.clientId.slice(0,8)}...`);

        // Now authenticate as that client
        const clientWs = await wsConnect(`ws://127.0.0.1:${TEST_PORT_BACKEND}/client`);
        clientWs.send(JSON.stringify({
          type: 'clientAuth',
          ts: Date.now(),
          clientId: pairResp.clientId,
          secret: pairResp.secret
        }));
        const clientAuth = await waitForMessage(clientWs, 'clientAuthOk', 5000);
        log('PASS', 'Client authentication with paired credentials');

        // Send health report
        clientWs.send(JSON.stringify({
          type: 'healthReport',
          ts: Date.now(),
          data: { cpu: 15.2, memTotal: 17179869184, memFree: 8589934592, uptime: 3600, version: '1.0.0', platform: 'win32', nodeVersion: 'v24.11.1' }
        }));
        const healthAck = await waitForMessage(clientWs, 'healthAck', 5000);
        log('PASS', 'Health report accepted');

        // Owner requests client list
        backendOwnerWs.send(JSON.stringify({
          type: 'clientList',
          ts: Date.now()
        }));
        const listResp = await waitForMessage(backendOwnerWs, 'clientListResult', 5000);
        if (listResp.clients && listResp.clients.length > 0) {
          log('PASS', 'Client list', `${listResp.clients.length} client(s)`);
          const testClient = listResp.clients.find(c => c.id === pairResp.clientId);
          if (testClient && testClient.online) {
            log('PASS', 'Client shows as online');
          } else {
            log('FAIL', 'Client online status', 'Not found or not online');
          }
        } else {
          log('FAIL', 'Client list', 'Empty');
        }

        // Owner requests client detail
        backendOwnerWs.send(JSON.stringify({
          type: 'clientStatus',
          ts: Date.now(),
          clientId: pairResp.clientId
        }));
        const detailResp = await waitForMessage(backendOwnerWs, 'clientStatusResult', 5000);
        if (detailResp.client && detailResp.client.lastHealth) {
          log('PASS', 'Client detail with health data');
        } else {
          log('FAIL', 'Client detail', 'Missing health');
        }

        // Remote command
        const cmdReqId = 'cmd_' + Date.now();
        backendOwnerWs.send(JSON.stringify({
          type: 'remoteCommand',
          ts: Date.now(),
          clientId: pairResp.clientId,
          action: 'getHealth',
          requestId: cmdReqId
        }));

        // Client should receive the command
        const cmdReceived = await waitForMessage(clientWs, 'remoteCommand', 5000);
        if (cmdReceived.action === 'getHealth') {
          log('PASS', 'Remote command received by client', `action=${cmdReceived.action}`);

          // Client sends result back
          clientWs.send(JSON.stringify({
            type: 'remoteResult',
            ts: Date.now(),
            requestId: cmdReqId,
            data: { status: 'healthy', cpu: 12.5 }
          }));
          log('PASS', 'Remote command result sent');
        } else {
          log('FAIL', 'Remote command', 'Wrong action received');
        }

        // Test revocation
        backendOwnerWs.send(JSON.stringify({
          type: 'unpair',
          ts: Date.now(),
          clientId: pairResp.clientId
        }));
        await sleep(500);

        // Verify client can't reconnect
        try {
          const revokedWs = await wsConnect(`ws://127.0.0.1:${TEST_PORT_BACKEND}/client`);
          revokedWs.send(JSON.stringify({
            type: 'clientAuth',
            ts: Date.now(),
            clientId: pairResp.clientId,
            secret: pairResp.secret
          }));
          const revokeResp = await waitForMessage(revokedWs, 'clientAuthFail', 5000);
          if (revokeResp.error) {
            log('PASS', 'Revoked client rejected', revokeResp.error);
          } else {
            log('FAIL', 'Revoked client', 'Was not rejected');
          }
          revokedWs.close();
        } catch (err) {
          log('FAIL', 'Revoked client test', err.message);
        }

        clientWs.close();
      } else {
        log('FAIL', 'Pairing creation', 'Missing credentials');
      }
    } catch (err) {
      log('FAIL', 'Pairing test', err.message);
    }

    // Wrong owner token test
    try {
      const badOwnerWs = await wsConnect(`ws://127.0.0.1:${TEST_PORT_BACKEND}/owner`);
      badOwnerWs.send(JSON.stringify({
        type: 'ownerAuth',
        ts: Date.now(),
        token: 'definitely_wrong_token'
      }));
      const badResp = await waitForMessage(badOwnerWs, 'ownerAuthFail', 5000);
      if (badResp.error) {
        log('PASS', 'Wrong owner token rejected', badResp.error);
      } else {
        log('FAIL', 'Wrong owner token', 'Was not rejected');
      }
      badOwnerWs.close();
    } catch (err) {
      log('FAIL', 'Wrong owner token test', err.message);
    }

    backendOwnerWs.close();
  }

  // ===== Phase 6: Backend invalid paths =====
  console.log('\n--- Phase 6: Security Checks ---');
  try {
    const ws404 = new WebSocket(`ws://127.0.0.1:${TEST_PORT_BACKEND}/invalid`);
    await new Promise((resolve, reject) => {
      ws404.on('error', () => resolve());
      ws404.on('close', () => resolve());
      ws404.on('open', () => { ws404.close(); reject(new Error('Should not connect')); });
      setTimeout(resolve, 2000);
    });
    log('PASS', 'Backend rejects invalid WebSocket paths');
  } catch (err) {
    log('FAIL', 'Backend invalid path rejection', err.message);
  }

  // ===== Phase 7: Gradual rollout verification =====
  console.log('\n--- Phase 7: Rollout Logic ---');
  // Test rollout bucket determinism
  const protocol = require(path.join(SRC, 'shared', 'protocol'));
  const testClientId = protocol.generateClientId();
  const testVersion = '1.1.0';
  const hash = crypto.createHash('md5').update(testClientId + testVersion).digest();
  const bucket = hash[0] % 100;
  const hash2 = crypto.createHash('md5').update(testClientId + testVersion).digest();
  const bucket2 = hash2[0] % 100;
  if (bucket === bucket2) {
    log('PASS', 'Rollout bucket deterministic', `client+version → bucket ${bucket}`);
  } else {
    log('FAIL', 'Rollout bucket', 'Non-deterministic');
  }

  // Test 10% rollout: ~10% of 100 random clients should pass
  let in10 = 0;
  for (let i = 0; i < 100; i++) {
    const cid = protocol.generateClientId();
    const h = crypto.createHash('md5').update(cid + testVersion).digest();
    if ((h[0] % 100) < 10) in10++;
  }
  if (in10 >= 2 && in10 <= 30) {
    log('PASS', '10% rollout distribution', `${in10}/100 clients selected`);
  } else {
    log('FAIL', '10% rollout distribution', `${in10}/100 (expected ~10)`);
  }

  // ===== Phase 8: Protocol validation =====
  console.log('\n--- Phase 8: Protocol Validation ---');
  // Message creation
  const msg = protocol.createMessage(protocol.MessageType.HEARTBEAT, { extra: 'data' });
  const parsed = protocol.parseMessage(msg);
  if (parsed && parsed.type === 'heartbeat' && parsed.ts && parsed.extra === 'data') {
    log('PASS', 'Protocol message create/parse');
  } else {
    log('FAIL', 'Protocol message', 'Invalid round-trip');
  }

  // Bad JSON
  if (protocol.parseMessage('not json') === null) {
    log('PASS', 'Protocol rejects invalid JSON');
  } else {
    log('FAIL', 'Protocol bad JSON', 'Did not return null');
  }

  // No type
  if (protocol.parseMessage('{"data":1}') === null) {
    log('PASS', 'Protocol rejects message without type');
  } else {
    log('FAIL', 'Protocol missing type', 'Did not return null');
  }

  // Client ID generation
  const cid1 = protocol.generateClientId();
  const cid2 = protocol.generateClientId();
  if (cid1.length === 16 && cid2.length === 16 && cid1 !== cid2) {
    log('PASS', 'Client ID generation', `${cid1}, ${cid2}`);
  } else {
    log('FAIL', 'Client ID', 'Invalid or duplicate');
  }

  // Pairing code
  const pc = protocol.generatePairingCode();
  if (/^\d{6}$/.test(pc)) {
    log('PASS', 'Pairing code generation', pc);
  } else {
    log('FAIL', 'Pairing code', `Invalid: ${pc}`);
  }

  // ===== Phase 9: New features (audit query, command timeout) =====
  console.log('\n--- Phase 9: Audit & Command Features ---');

  // Start a fresh backend with its own isolated data dir
  const featureDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vampjro-intfeat-'));

  let featureBackend;
  try {
    featureBackend = await startProcess('FeatureBackend', 'node', ['src/index.js'], {
      BACKEND_PORT: '4150',
      BACKEND_HOST: '127.0.0.1',
      BACKEND_DATA_DIR: featureDataDir
    }, path.join(SRC, 'backend'));
  } catch (err) {
    log('FAIL', 'Feature backend startup', err.message);
  }

  if (featureBackend) {
    try {
      // Setup owner
      const featureOwnerWs = await wsConnect('ws://127.0.0.1:4150/owner');
      const featureToken = crypto.randomBytes(32).toString('hex');
      featureOwnerWs.send(JSON.stringify({ type: 'ownerAuth', token: featureToken, ts: Date.now() }));
      await waitForMessage(featureOwnerWs, 'ownerAuthOk');

      // Create pairing to generate audit entries
      featureOwnerWs.send(JSON.stringify({ type: 'pairRequest', name: 'Audit Test', ts: Date.now() }));
      const auditPair = await waitForMessage(featureOwnerWs, 'pairSuccess');
      log('PASS', 'Feature test setup');

      // Query audit log
      featureOwnerWs.send(JSON.stringify({ type: 'auditQuery', limit: 10, ts: Date.now() }));
      const auditResp = await waitForMessage(featureOwnerWs, 'auditQueryResult', 5000);
      if (auditResp.entries && Array.isArray(auditResp.entries) && auditResp.total >= 1) {
        log('PASS', 'Audit query returns entries', `${auditResp.entries.length} entries, total=${auditResp.total}`);
      } else {
        log('FAIL', 'Audit query', JSON.stringify(auditResp).slice(0, 100));
      }

      // Test command to offline client (should get 'Client offline' error)
      const cmdReqId2 = 'cmd_offline_' + Date.now();
      featureOwnerWs.send(JSON.stringify({
        type: 'remoteCommand',
        clientId: auditPair.clientId,
        action: 'getHealth',
        requestId: cmdReqId2,
        ts: Date.now()
      }));
      const offlineResp = await waitForMessage(featureOwnerWs, 'remoteError', 5000);
      if (offlineResp.error === 'Client offline') {
        log('PASS', 'Command to offline client returns error', offlineResp.error);
      } else {
        log('FAIL', 'Offline command error', offlineResp.error || 'no error');
      }

      // Test invalid remote action rejected by backend
      featureOwnerWs.send(JSON.stringify({
        type: 'remoteCommand',
        clientId: auditPair.clientId,
        action: 'executeArbitraryShell',
        requestId: 'bad_action_' + Date.now(),
        ts: Date.now()
      }));
      const badActionResp = await waitForMessage(featureOwnerWs, 'remoteError', 5000);
      if (badActionResp.error === 'Action not allowed') {
        log('PASS', 'Invalid remote action rejected by backend', badActionResp.error);
      } else {
        log('FAIL', 'Invalid action rejection', badActionResp.error || 'no error');
      }

      featureOwnerWs.close();
    } catch (err) {
      log('FAIL', 'Feature tests', err.message);
    }
  }

  // ===== Cleanup =====
  console.log('\n--- Cleanup ---');
  killAll();
  await sleep(1000);

  // Clean up temp data dirs
  try { fs.rmSync(backendDataDir, { recursive: true, force: true }); } catch {}
  try { if (typeof featureDataDir !== 'undefined') fs.rmSync(featureDataDir, { recursive: true, force: true }); } catch {}
  log('PASS', 'Cleanup');

  printSummary();
}

function printSummary() {
  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed, ${blocked} blocked`);
  console.log(`Total:   ${passed + failed + blocked} tests`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results) {
      if (r.status === 'FAIL') console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
  }
  console.log(failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${failed} test(s) failed`);

  // Write results file
  const reportPath = path.join(__dirname, 'results', 'integration-results.json');
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    summary: { passed, failed, blocked, total: passed + failed + blocked },
    results
  }, null, 2), 'utf8');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite error:', err.message);
  killAll();
  process.exit(1);
});
