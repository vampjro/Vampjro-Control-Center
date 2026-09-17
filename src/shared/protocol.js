'use strict';

const CLIENT_ID_LENGTH = 16;
const PAIRING_CODE_LENGTH = 6;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;

const MessageType = {
  // Connection
  HELLO: 'hello',
  HELLO_ACK: 'helloAck',
  HEARTBEAT: 'heartbeat',
  HEARTBEAT_ACK: 'heartbeatAck',

  // Pairing
  PAIR_REQUEST: 'pairRequest',
  PAIR_CHALLENGE: 'pairChallenge',
  PAIR_RESPONSE: 'pairResponse',
  PAIR_SUCCESS: 'pairSuccess',
  PAIR_REJECTED: 'pairRejected',
  UNPAIR: 'unpair',

  // Client ↔ Backend
  CLIENT_REGISTER: 'clientRegister',
  CLIENT_REGISTERED: 'clientRegistered',
  CLIENT_AUTH: 'clientAuth',
  CLIENT_AUTH_OK: 'clientAuthOk',
  CLIENT_AUTH_FAIL: 'clientAuthFail',

  // Health reporting (Client → Backend)
  HEALTH_REPORT: 'healthReport',
  HEALTH_ACK: 'healthAck',

  // Remote management (Owner → Backend → Client)
  REMOTE_COMMAND: 'remoteCommand',
  REMOTE_RESULT: 'remoteResult',
  REMOTE_ERROR: 'remoteError',

  // Owner ↔ Backend
  OWNER_AUTH: 'ownerAuth',
  OWNER_AUTH_OK: 'ownerAuthOk',
  OWNER_AUTH_FAIL: 'ownerAuthFail',
  CLIENT_LIST: 'clientList',
  CLIENT_LIST_RESULT: 'clientListResult',
  CLIENT_STATUS: 'clientStatus',
  CLIENT_STATUS_RESULT: 'clientStatusResult',

  // Updates (Owner → Backend → Client)
  UPDATE_AVAILABLE: 'updateAvailable',
  UPDATE_STATUS: 'updateStatus',
  UPDATE_ACK: 'updateAck',

  // Audit
  AUDIT_EVENT: 'auditEvent',

  // Audit
  AUDIT_QUERY: 'auditQuery',
  AUDIT_QUERY_RESULT: 'auditQueryResult',

  // Error
  ERROR: 'error'
};

const RemoteAction = {
  GET_HEALTH: 'getHealth',
  GET_SYSTEM_STATS: 'getSystemStats',
  GET_PROCESSES: 'getProcesses',
  RESTART_SERVICE: 'restartService',
  GET_UPDATE_STATUS: 'getUpdateStatus',
  TRIGGER_UPDATE: 'triggerUpdate',
  GET_LOGS: 'getLogs'
};

const ClientState = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  UPDATING: 'updating',
  ERROR: 'error'
};

const ReleaseChannel = {
  STABLE: 'stable',
  BETA: 'beta',
  DEV: 'dev'
};

const AuditAction = {
  CLIENT_PAIRED: 'client_paired',
  CLIENT_UNPAIRED: 'client_unpaired',
  REMOTE_COMMAND_SENT: 'remote_command_sent',
  UPDATE_PUSHED: 'update_pushed',
  UPDATE_INSTALLED: 'update_installed',
  OWNER_LOGIN: 'owner_login',
  SETTINGS_CHANGED: 'settings_changed'
};

function generateClientId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = require('crypto').randomBytes(CLIENT_ID_LENGTH);
  for (let i = 0; i < CLIENT_ID_LENGTH; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

function generatePairingCode() {
  const bytes = require('crypto').randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += (bytes[i] % 10).toString();
  }
  return code;
}

function createMessage(type, payload) {
  return JSON.stringify({
    type,
    ts: Date.now(),
    ...payload
  });
}

function parseMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg.type) return null;
    return msg;
  } catch {
    return null;
  }
}

module.exports = {
  CLIENT_ID_LENGTH,
  PAIRING_CODE_LENGTH,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_DELAY,
  MessageType,
  RemoteAction,
  ClientState,
  ReleaseChannel,
  AuditAction,
  generateClientId,
  generatePairingCode,
  createMessage,
  parseMessage
};
