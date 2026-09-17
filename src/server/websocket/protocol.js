const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;

function createClient(ws, info) {
  return {
    ws,
    id: Math.random().toString(36).slice(2, 10),
    ip: info?.req?.socket?.remoteAddress || 'unknown',
    authenticated: false,
    token: null,
    subscriptions: new Set(),
    lastPong: Date.now(),
    seq: 0,
    heartbeatTimer: null
  };
}

function startHeartbeat(client) {
  client.heartbeatTimer = setInterval(() => {
    if (Date.now() - client.lastPong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
      client.ws.terminate();
      return;
    }
    safeSend(client, { type: 'ping', ts: Date.now() });
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(client) {
  if (client.heartbeatTimer) {
    clearInterval(client.heartbeatTimer);
    client.heartbeatTimer = null;
  }
}

function safeSend(client, data) {
  if (client.ws.readyState === 1) {
    data.seq = ++client.seq;
    client.ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function broadcast(clients, data) {
  const json = JSON.stringify({ ...data, seq: 0 });
  let sent = 0;
  for (const client of clients) {
    if (client.ws.readyState === 1 && client.authenticated) {
      client.ws.send(json);
      sent++;
    }
  }
  return sent;
}

function broadcastToSubscribers(clients, channel, data) {
  let sent = 0;
  for (const client of clients) {
    if (client.ws.readyState === 1 && client.authenticated && client.subscriptions.has(channel)) {
      safeSend(client, data);
      sent++;
    }
  }
  return sent;
}

module.exports = { createClient, startHeartbeat, stopHeartbeat, safeSend, broadcast, broadcastToSubscribers };
