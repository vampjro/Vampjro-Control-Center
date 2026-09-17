'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('../core/config');
const logger = require('../core/logger');
const protocol = require('../../shared/protocol');

let ws = null;
let reconnectDelay = protocol.RECONNECT_BASE_DELAY;
let heartbeatTimer = null;
let healthReportTimer = null;
let enabled = false;

function getCredentials() {
  const clientId = config.get('backend.clientId');
  const secret = config.get('backend.secret');
  const url = config.get('backend.url');
  return { clientId, secret, url };
}

function connect() {
  const { clientId, secret, url } = getCredentials();
  if (!clientId || !secret || !url) return;

  const wsUrl = url.replace(/^http/, 'ws') + '/client';

  try { ws = new WebSocket(wsUrl); } catch (_) { scheduleReconnect(); return; }

  ws.on('open', () => {
    logger.info('[Backend] Connected');
    reconnectDelay = protocol.RECONNECT_BASE_DELAY;

    ws.send(protocol.createMessage(protocol.MessageType.CLIENT_AUTH, {
      clientId,
      secret
    }));
  });

  ws.on('message', (raw) => {
    const msg = protocol.parseMessage(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case protocol.MessageType.CLIENT_AUTH_OK:
        logger.info('[Backend] Authenticated');
        startHeartbeat();
        startHealthReporting();
        break;

      case protocol.MessageType.CLIENT_AUTH_FAIL:
        logger.warn(`[Backend] Auth failed: ${msg.error}`);
        ws.close();
        break;

      case protocol.MessageType.HEARTBEAT:
        ws.send(protocol.createMessage(protocol.MessageType.HEARTBEAT_ACK));
        break;

      case protocol.MessageType.REMOTE_COMMAND:
        handleRemoteCommand(msg);
        break;

      case protocol.MessageType.UPDATE_AVAILABLE:
        handleUpdateNotification(msg);
        break;

      case protocol.MessageType.UNPAIR:
        logger.warn('[Backend] Unpaired by owner');
        config.set('backend.clientId', null);
        config.set('backend.secret', null);
        enabled = false;
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    logger.info('[Backend] Disconnected');
    stopHeartbeat();
    stopHealthReporting();
    if (enabled) scheduleReconnect();
  });

  ws.on('error', () => {});
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, protocol.RECONNECT_MAX_DELAY);
    if (enabled) connect();
  }, reconnectDelay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(protocol.createMessage(protocol.MessageType.HEARTBEAT_ACK));
    }
  }, protocol.HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function startHealthReporting() {
  stopHealthReporting();
  const interval = config.get('backend.healthInterval') || 60000;
  healthReportTimer = setInterval(() => sendHealthReport(), interval);
  sendHealthReport();
}

function stopHealthReporting() {
  if (healthReportTimer) { clearInterval(healthReportTimer); healthReportTimer = null; }
}

function sendHealthReport() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const os = require('os');
  const report = {
    cpu: os.loadavg()[0],
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: Math.round(process.uptime()),
    version: config.get('branding.version'),
    platform: process.platform,
    nodeVersion: process.version
  };

  ws.send(protocol.createMessage(protocol.MessageType.HEALTH_REPORT, { data: report }));
}

function handleRemoteCommand(msg) {
  const allowedActions = new Set([
    protocol.RemoteAction.GET_HEALTH,
    protocol.RemoteAction.GET_SYSTEM_STATS,
    protocol.RemoteAction.GET_PROCESSES,
    protocol.RemoteAction.RESTART_SERVICE,
    protocol.RemoteAction.GET_UPDATE_STATUS,
    protocol.RemoteAction.GET_LOGS
  ]);

  if (!allowedActions.has(msg.action)) {
    ws.send(protocol.createMessage(protocol.MessageType.REMOTE_ERROR, {
      requestId: msg.requestId,
      error: 'Action not allowed'
    }));
    return;
  }

  const handler = require('../websocket/handler');
  const moduleManager = require('../core/module-manager');
  const handlers = moduleManager.getWsHandlers();

  const actionMap = {
    [protocol.RemoteAction.GET_HEALTH]: 'getSystemStats',
    [protocol.RemoteAction.GET_SYSTEM_STATS]: 'getSystemStats',
    [protocol.RemoteAction.GET_PROCESSES]: 'getProcesses',
    [protocol.RemoteAction.GET_UPDATE_STATUS]: 'getUpdateStatus',
    [protocol.RemoteAction.GET_LOGS]: 'getCrashLogs'
  };

  const handlerName = actionMap[msg.action];
  if (!handlerName || !handlers[handlerName]) {
    ws.send(protocol.createMessage(protocol.MessageType.REMOTE_ERROR, {
      requestId: msg.requestId,
      error: 'Handler not found'
    }));
    return;
  }

  if (msg.action === protocol.RemoteAction.RESTART_SERVICE) {
    logger.info('[Backend] Restart requested by owner');
    ws.send(protocol.createMessage(protocol.MessageType.REMOTE_RESULT, {
      requestId: msg.requestId,
      data: { status: 'restarting' }
    }));
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  handlers[handlerName](msg.params || {})
    .then(data => {
      ws.send(protocol.createMessage(protocol.MessageType.REMOTE_RESULT, {
        requestId: msg.requestId,
        data
      }));
    })
    .catch(err => {
      ws.send(protocol.createMessage(protocol.MessageType.REMOTE_ERROR, {
        requestId: msg.requestId,
        error: err.message
      }));
    });
}

function handleUpdateNotification(msg) {
  logger.info(`[Backend] Update available: v${msg.version}`);
  const updates = require('./updates');
  if (updates.handlePushedUpdate) {
    updates.handlePushedUpdate(msg);
  }
}

function start() {
  const { clientId, secret, url } = getCredentials();
  if (clientId && secret && url) {
    enabled = true;
    connect();
  }
}

function stop() {
  enabled = false;
  stopHeartbeat();
  stopHealthReporting();
  if (ws) {
    ws.close();
    ws = null;
  }
}

function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function getStatus() {
  return {
    enabled,
    connected: isConnected(),
    clientId: config.get('backend.clientId') || null
  };
}

function wsHandlers() {
  return {
    getBackendStatus: async () => getStatus()
  };
}

module.exports = { start, stop, wsHandlers, isConnected, getStatus };
