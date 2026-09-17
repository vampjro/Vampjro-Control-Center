const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');

const config = require('./core/config');
const logger = require('./core/logger');
const moduleManager = require('./core/module-manager');
const watchdog = require('./core/watchdog');
const hwProfile = require('./utils/hardware-profile');
const musicModule = require('./modules/music');
const auth = require('./security/auth');
const permissions = require('./security/permissions');
const protocol = require('./websocket/protocol');

config.load();
logger.init();

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: config.get('branding.version'),
    uptime: Math.round(process.uptime())
  });
});

moduleManager.register('system', require('./modules/system'));
moduleManager.register('processes', require('./modules/processes'));
moduleManager.register('controls', require('./modules/controls'));
moduleManager.register('screenshot', require('./modules/screenshot'));
moduleManager.register('crashLogs', require('./modules/crash-logs'));
moduleManager.register('clipboard', require('./modules/clipboard'));
moduleManager.register('windows', require('./modules/windows'));
moduleManager.register('network', require('./modules/network'));
moduleManager.register('storage', require('./modules/storage'));
moduleManager.register('audio', require('./modules/audio'));
moduleManager.register('terminal', require('./modules/terminal'));
moduleManager.register('keepAwake', require('./modules/keep-awake'));
moduleManager.register('discord', require('./modules/discord'));
moduleManager.register('music', musicModule);
moduleManager.register('updates', require('./modules/updates'));
moduleManager.register('backendConnector', require('./modules/backend-connector'));

const panelWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const musicWss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
const panelClients = new Set();

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  if (origin) {
    try {
      const url = new URL(origin);
      const host = url.hostname;
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        host.startsWith('192.168.') || host.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
      const isAppleMusic = url.protocol === 'https:' && host === 'music.apple.com';
      const isExtension = url.protocol === 'chrome-extension:';
      if (!isLocal && !isAppleMusic && !isExtension) {
        logger.warn(`WebSocket origin rejected: ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/music') {
    musicWss.handleUpgrade(req, socket, head, ws => musicWss.emit('connection', ws, req));
  } else {
    panelWss.handleUpgrade(req, socket, head, ws => panelWss.emit('connection', ws, req));
  }
});

panelWss.on('connection', (ws, req) => {
  const client = protocol.createClient(ws, { req });
  panelClients.add(client);
  watchdog.setWsClients(panelClients.size);
  logger.info(`Panel client connected: ${client.ip}`);
  protocol.startHeartbeat(client);

  if (!auth.isPinSet()) {
    protocol.safeSend(client, { type: 'needSetup' });
  } else {
    protocol.safeSend(client, { type: 'needAuth' });
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'pong') { client.lastPong = Date.now(); return; }

    if (msg.type === 'setupPin') {
      if (auth.isPinSet()) return protocol.safeSend(client, { type: 'error', error: 'PIN already set', requestId: msg.requestId });
      if (!/^\d{4,6}$/.test(String(msg.pin))) return protocol.safeSend(client, { type: 'error', error: 'PIN must be 4-6 digits', requestId: msg.requestId });
      auth.setupPin(String(msg.pin));
      return protocol.safeSend(client, { type: 'setupComplete', requestId: msg.requestId });
    }

    if (msg.type === 'auth') {
      const result = auth.authenticate(String(msg.pin), client.ip);
      if (result.success) {
        client.authenticated = true;
        client.token = result.token;
        const profile = hwProfile.getProfile();
        protocol.safeSend(client, {
          type: 'authSuccess', token: result.token, requestId: msg.requestId,
          version: config.get('branding.version'),
          modules: moduleManager.getStatus(),
          hardwareTier: profile?.effectiveTier || 'LOW',
          safeMode: config.get('security.safeMode') || false
        });
      } else {
        protocol.safeSend(client, { type: 'authFailed', error: result.error, cooldown: result.cooldown, requestId: msg.requestId });
      }
      return;
    }

    if (msg.type === 'tokenAuth') {
      if (auth.validateToken(msg.token, client.ip)) {
        client.authenticated = true;
        client.token = msg.token;
        const profile = hwProfile.getProfile();
        protocol.safeSend(client, {
          type: 'authSuccess', token: msg.token, requestId: msg.requestId,
          version: config.get('branding.version'),
          modules: moduleManager.getStatus(),
          hardwareTier: profile?.effectiveTier || 'LOW',
          safeMode: config.get('security.safeMode') || false
        });
      } else {
        protocol.safeSend(client, { type: 'needAuth', requestId: msg.requestId });
      }
      return;
    }

    if (!client.authenticated) return protocol.safeSend(client, { type: 'needAuth' });

    if (msg.type === 'subscribe') {
      const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channels];
      for (const ch of channels) client.subscriptions.add(ch);
      return protocol.safeSend(client, { type: 'subscribed', channels: [...client.subscriptions], requestId: msg.requestId });
    }

    if (msg.type === 'unsubscribe') {
      const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channels];
      for (const ch of channels) client.subscriptions.delete(ch);
      return protocol.safeSend(client, { type: 'unsubscribed', channels: [...client.subscriptions], requestId: msg.requestId });
    }

    const perm = permissions.check(msg.type);
    if (!perm.allowed) {
      return protocol.safeSend(client, { type: 'permissionDenied', action: msg.type, reason: perm.reason, requestId: msg.requestId });
    }

    const handlers = moduleManager.getWsHandlers();
    const handler = handlers[msg.type];
    if (handler) {
      try {
        const result = await handler(msg, client);
        if (result !== undefined) protocol.safeSend(client, { type: msg.type + 'Result', data: result, requestId: msg.requestId });
      } catch (err) {
        logger.error(`Handler error: ${msg.type}`, { error: err.message });
        watchdog.incrementErrors();
        protocol.safeSend(client, { type: 'error', error: err.message, action: msg.type, requestId: msg.requestId });
      }
    } else {
      protocol.safeSend(client, { type: 'error', error: `Unknown: ${msg.type}`, requestId: msg.requestId });
    }
  });

  ws.on('close', () => {
    protocol.stopHeartbeat(client);
    panelClients.delete(client);
    watchdog.setWsClients(panelClients.size);
    logger.info(`Panel client disconnected (${panelClients.size} remaining)`);
  });

  ws.on('error', () => {});
});

musicWss.on('connection', (ws) => {
  let role = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'register') {
      role = msg.role;
      if (role === 'player') musicModule.setPlayerSocket(ws);
      else if (role === 'remote') {
        musicModule.addRemote(ws);
        const state = musicModule.getLastState();
        if (state) ws.send(JSON.stringify({ type: 'state', data: state }));
      }
      return;
    }
    if (role === 'player') musicModule.handlePlayerMessage(msg);
    if (role === 'remote') musicModule.sendToPlayer(msg);
  });
  ws.on('close', () => {
    if (role === 'player') musicModule.clearPlayerSocket(ws);
    if (role === 'remote') musicModule.removeRemote(ws);
  });
});

function broadcastToChannel(channel, data) {
  return protocol.broadcastToSubscribers(panelClients, channel, data);
}

const origBroadcast = require('./websocket/handler');
origBroadcast.broadcastToChannel = broadcastToChannel;
origBroadcast.getSubscribers = (channel) => [...panelClients].filter(c => c.authenticated && c.subscriptions.has(channel));

async function start() {
  logger.info('VAMPJRO Remote Control Center starting...');
  const profile = await hwProfile.detect();
  logger.info(`Hardware: ${profile.details.cpu}, ${profile.details.ramGB}GB RAM, ${profile.details.storage}`);

  await moduleManager.startAll();

  const routes = moduleManager.getRoutes();
  for (const route of routes) app[route.method](route.path, route.handler);

  const port = config.get('server.port') || 3000;
  const host = config.get('server.host') || '0.0.0.0';

  server.listen(port, host, () => {
    const localIp = getLocalIp();
    console.log('');
    console.log('  VAMPJRO Remote Control Center');
    console.log('  =============================');
    console.log(`  Version:   ${config.get('branding.version')}`);
    console.log(`  Tier:      ${profile.effectiveTier}`);
    console.log('');
    console.log('  Per collegare il telefono:');
    console.log(`    1. Assicurati che il telefono sia sulla stessa rete Wi-Fi di questo PC`);
    console.log(`    2. Apri questo indirizzo dal browser del telefono:`);
    console.log(`       http://${localIp}:${port}`);
    console.log(`    3. Crea (o inserisci) il PIN quando richiesto`);
    console.log('');
    console.log(`  Pannello:  http://${localIp}:${port}`);
    console.log(`  Musica:    http://${localIp}:${port}/music.html`);
    console.log(`  Locale:    http://localhost:${port}`);
    console.log(`  Support:   ${config.get('branding.support')}`);
    console.log('');
    logger.info(`Server listening on ${host}:${port}`);
  });

  watchdog.start();
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return 'localhost';
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function shutdown() {
  logger.info('Shutting down...');
  watchdog.stop();
  for (const client of panelClients) { protocol.stopHeartbeat(client); client.ws.terminate(); }
  panelClients.clear();
  musicWss.close();
  await moduleManager.stopAll();
  logger.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});



