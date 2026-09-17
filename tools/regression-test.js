const WebSocket = require('ws');
const http = require('http');

const HOST = 'localhost';
const PORT = 3000;
const PIN = '0000';
let passed = 0, failed = 0, skipped = 0;
const results = [];

function log(status, name, detail) {
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '⊘';
  console.log(`  ${icon} ${name}${detail ? ': ' + detail : ''}`);
  results.push({ status, name, detail });
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else skipped++;
}

function wsRequest(ws, msg, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const rid = Math.random().toString(36).slice(2);
    msg.requestId = rid;
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    function handler(raw) {
      const data = JSON.parse(raw);
      if (data.requestId === rid || data.type === msg.type + 'Result') {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(data);
      }
    }
    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connect timeout')), 5000);
  });
}

async function testHealthEndpoint() {
  return new Promise((resolve) => {
    http.get(`http://${HOST}:${PORT}/api/health`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'ok' && json.version) {
            log('PASS', 'HTTP /api/health', `v${json.version}, uptime ${json.uptime}s`);
          } else {
            log('FAIL', 'HTTP /api/health', 'Unexpected response');
          }
        } catch {
          log('FAIL', 'HTTP /api/health', 'Invalid JSON');
        }
        resolve();
      });
    }).on('error', (err) => {
      log('FAIL', 'HTTP /api/health', err.message);
      resolve();
    });
  });
}

async function run() {
  console.log('\nVAMPJRO Regression Test Suite');
  console.log('==============================\n');

  console.log('--- Connectivity ---');
  await testHealthEndpoint();

  let ws;
  try {
    ws = await connect();
    log('PASS', 'WebSocket connect');
  } catch (err) {
    log('FAIL', 'WebSocket connect', err.message);
    printSummary();
    return;
  }

  // Auth
  console.log('\n--- Authentication ---');
  try {
    const authResp = await wsRequest(ws, { type: 'auth', pin: PIN });
    if (authResp.type === 'authSuccess' && authResp.token) {
      log('PASS', 'PIN auth', `token=${authResp.token.slice(0, 8)}...`);
      log('PASS', 'Module status in auth', `${Object.keys(authResp.modules).length} modules`);
      log('PASS', 'Hardware tier', authResp.hardwareTier);
    } else {
      log('FAIL', 'PIN auth', authResp.error || authResp.type);
    }
  } catch (err) {
    log('FAIL', 'PIN auth', err.message);
    ws.close();
    printSummary();
    return;
  }

  // Wrong PIN
  try {
    const ws2 = await connect();
    const msg = await new Promise(resolve => {
      ws2.on('message', raw => {
        const d = JSON.parse(raw);
        if (d.type === 'needAuth') {
          ws2.send(JSON.stringify({ type: 'auth', pin: '9999', requestId: 'bad' }));
        }
        if (d.type === 'authFailed') resolve(d);
      });
    });
    if (msg.error) log('PASS', 'Wrong PIN rejected', msg.error);
    else log('FAIL', 'Wrong PIN rejection');
    ws2.close();
  } catch (err) {
    log('FAIL', 'Wrong PIN test', err.message);
  }

  // Subscribe
  console.log('\n--- Subscriptions ---');
  try {
    const sub = await wsRequest(ws, { type: 'subscribe', channels: ['system', 'processes'] });
    if (sub.type === 'subscribed' && sub.channels?.includes('system')) {
      log('PASS', 'Subscribe', sub.channels.join(', '));
    } else {
      log('FAIL', 'Subscribe', JSON.stringify(sub));
    }
  } catch (err) {
    log('FAIL', 'Subscribe', err.message);
  }

  // System stats
  console.log('\n--- System Module ---');
  try {
    const stats = await wsRequest(ws, { type: 'getSystemStats' });
    if (stats.data?.cpu?.load !== undefined && stats.data?.mem?.percent !== undefined) {
      log('PASS', 'getSystemStats', `CPU=${stats.data.cpu.load}%, RAM=${stats.data.mem.percent}%`);
    } else {
      log('FAIL', 'getSystemStats', 'Missing data');
    }
  } catch (err) {
    log('FAIL', 'getSystemStats', err.message);
  }

  try {
    const info = await wsRequest(ws, { type: 'getStaticInfo' });
    if (info.data?.cpu?.brand) {
      log('PASS', 'getStaticInfo', info.data.cpu.brand);
    } else {
      log('FAIL', 'getStaticInfo', 'Missing CPU brand');
    }
  } catch (err) {
    log('FAIL', 'getStaticInfo', err.message);
  }

  try {
    const hist = await wsRequest(ws, { type: 'getSystemHistory', count: 10 });
    if (hist.data?.cpu !== undefined) {
      log('PASS', 'getSystemHistory', `${hist.data.cpu.length} CPU points`);
    } else {
      log('FAIL', 'getSystemHistory', 'Missing data');
    }
  } catch (err) {
    log('FAIL', 'getSystemHistory', err.message);
  }

  // Processes
  console.log('\n--- Processes Module ---');
  try {
    const procs = await wsRequest(ws, { type: 'getProcesses' }, 15000);
    if (Array.isArray(procs.data) && procs.data.length > 0) {
      log('PASS', 'getProcesses', `${procs.data.length} processes`);
    } else {
      log('FAIL', 'getProcesses', 'Empty or invalid');
    }
  } catch (err) {
    log('FAIL', 'getProcesses', err.message);
  }

  // Controls
  console.log('\n--- Controls Module ---');
  try {
    const vol = await wsRequest(ws, { type: 'getVolume' });
    if (vol.data !== undefined) {
      log('PASS', 'getVolume', `level=${JSON.stringify(vol.data).slice(0, 60)}`);
    } else {
      log('FAIL', 'getVolume');
    }
  } catch (err) {
    log('FAIL', 'getVolume', err.message);
  }

  try {
    const br = await wsRequest(ws, { type: 'getBrightness' });
    log(br.data !== undefined ? 'PASS' : 'FAIL', 'getBrightness');
  } catch (err) {
    log('FAIL', 'getBrightness', err.message);
  }

  // Clipboard
  console.log('\n--- Clipboard Module ---');
  try {
    const clip = await wsRequest(ws, { type: 'getClipboard' });
    log('PASS', 'getClipboard', typeof clip.data === 'string' ? `${clip.data.length} chars` : 'ok');
  } catch (err) {
    log('FAIL', 'getClipboard', err.message);
  }

  // Windows
  console.log('\n--- Windows Module ---');
  try {
    const wins = await wsRequest(ws, { type: 'getWindows' });
    if (Array.isArray(wins.data)) {
      log('PASS', 'getWindows', `${wins.data.length} windows`);
    } else {
      log('FAIL', 'getWindows');
    }
  } catch (err) {
    log('FAIL', 'getWindows', err.message);
  }

  // Network
  console.log('\n--- Network Module ---');
  try {
    const net = await wsRequest(ws, { type: 'getNetwork' }, 15000);
    if (net.data) {
      log('PASS', 'getNetwork', `interfaces=${net.data.interfaces?.length || '?'}`);
    } else {
      log('FAIL', 'getNetwork');
    }
  } catch (err) {
    log('FAIL', 'getNetwork', err.message);
  }

  // Storage
  console.log('\n--- Storage Module ---');
  try {
    const stor = await wsRequest(ws, { type: 'getStorage' }, 15000);
    if (stor.data) {
      log('PASS', 'getStorage', `partitions=${stor.data.partitions?.length || '?'}`);
    } else {
      log('FAIL', 'getStorage');
    }
  } catch (err) {
    log('FAIL', 'getStorage', err.message);
  }

  // Audio
  console.log('\n--- Audio Module ---');
  try {
    const audio = await wsRequest(ws, { type: 'getAudio' });
    if (audio.data !== undefined) {
      log('PASS', 'getAudio');
    } else {
      log('FAIL', 'getAudio');
    }
  } catch (err) {
    log('FAIL', 'getAudio', err.message);
  }

  // Crash logs
  console.log('\n--- Crash Logs Module ---');
  try {
    const crash = await wsRequest(ws, { type: 'getCrashLogs' });
    log('PASS', 'getCrashLogs', Array.isArray(crash.data) ? `${crash.data.length} entries` : 'ok');
  } catch (err) {
    log('FAIL', 'getCrashLogs', err.message);
  }

  // Keep Awake
  console.log('\n--- Keep Awake Module ---');
  try {
    const ka = await wsRequest(ws, { type: 'getKeepAwakeStatus' });
    log('PASS', 'getKeepAwakeStatus', JSON.stringify(ka.data).slice(0, 80));
  } catch (err) {
    log('FAIL', 'getKeepAwakeStatus', err.message);
  }

  // Discord
  console.log('\n--- Discord Module ---');
  try {
    const disc = await wsRequest(ws, { type: 'getDiscordStatus' });
    if (disc.data?.capabilities) {
      log('PASS', 'getDiscordStatus', `canary=${disc.data.canaryInstalled}, vencord=${disc.data.vencordInstalled}, orion=${disc.data.orionVersion || 'n/a'}`);
    } else {
      log('FAIL', 'getDiscordStatus', 'Missing capabilities');
    }
  } catch (err) {
    log('FAIL', 'getDiscordStatus', err.message);
  }

  // Updates
  console.log('\n--- Updates Module ---');
  try {
    const upd = await wsRequest(ws, { type: 'getUpdateStatus' });
    if (upd.data?.currentVersion) {
      log('PASS', 'getUpdateStatus', `v${upd.data.currentVersion}, gist=${upd.data.gistConfigured}`);
    } else {
      log('FAIL', 'getUpdateStatus');
    }
  } catch (err) {
    log('FAIL', 'getUpdateStatus', err.message);
  }

  try {
    const check = await wsRequest(ws, { type: 'checkUpdates' });
    if (check.data?.status) {
      log('PASS', 'checkUpdates', `status=${check.data.status}`);
    } else {
      log('FAIL', 'checkUpdates');
    }
  } catch (err) {
    log('FAIL', 'checkUpdates', err.message);
  }

  // Music status
  console.log('\n--- Music Module ---');
  try {
    const mus = await wsRequest(ws, { type: 'getMusicStatus' });
    log('PASS', 'getMusicStatus', JSON.stringify(mus.data).slice(0, 80));
  } catch (err) {
    log('FAIL', 'getMusicStatus', err.message);
  }

  // Unsubscribe
  console.log('\n--- Cleanup ---');
  try {
    const unsub = await wsRequest(ws, { type: 'unsubscribe', channels: ['system', 'processes'] });
    if (unsub.type === 'unsubscribed') {
      log('PASS', 'Unsubscribe');
    } else {
      log('FAIL', 'Unsubscribe');
    }
  } catch (err) {
    log('FAIL', 'Unsubscribe', err.message);
  }

  ws.close();
  printSummary();
}

function printSummary() {
  console.log('\n==============================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`Total:   ${passed + failed + skipped} tests`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results) {
      if (r.status === 'FAIL') console.log(`  ✗ ${r.name}: ${r.detail || ''}`);
    }
  }
  console.log(failed === 0 ? '\n✓ All tests passed!' : `\n✗ ${failed} test(s) failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite error:', err.message);
  process.exit(1);
});
