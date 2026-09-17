const logger = require('../core/logger');
const { exec } = require('child_process');

// Apple Music here is the web player (music.apple.com) controlled through
// the browser extension in src/extension/, which matches that exact URL —
// there is no native Windows app being launched.
const APPLE_MUSIC_URL = 'https://music.apple.com';

function openWebPlayer() {
  try {
    exec(`start "" "${APPLE_MUSIC_URL}"`, err => {
      if (err) logger.error('Failed to open Apple Music web player', { error: err.message });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

let playerSocket = null;
let lastState = null;
const musicRemotes = new Set();

function setPlayerSocket(ws) {
  playerSocket = ws;
  logger.info('Apple Music player connected');
}

function clearPlayerSocket(ws) {
  if (playerSocket === ws) {
    playerSocket = null;
    logger.info('Apple Music player disconnected');
  }
}

function addRemote(ws) {
  musicRemotes.add(ws);
}

function removeRemote(ws) {
  musicRemotes.delete(ws);
}

function handlePlayerMessage(msg) {
  if (msg.type === 'state') lastState = msg.data;
  const json = JSON.stringify(msg);
  for (const remote of musicRemotes) {
    if (remote.readyState === 1) remote.send(json);
  }
}

function sendToPlayer(msg) {
  if (playerSocket && playerSocket.readyState === 1) {
    playerSocket.send(JSON.stringify({ type: 'command', ...msg }));
    return true;
  }
  return false;
}

function getLastState() { return lastState; }
function isPlayerConnected() { return playerSocket && playerSocket.readyState === 1; }

function health() {
  return {
    playerConnected: isPlayerConnected(),
    remoteCount: musicRemotes.size,
    hasState: !!lastState
  };
}

function wsHandlers() {
  return {
    musicCommand: async (msg) => {
      const sent = sendToPlayer(msg.data || msg);
      if (!sent) throw new Error('Apple Music player not connected');
      return { sent: true };
    },
    getMusicStatus: () => ({
      connected: isPlayerConnected(),
      state: lastState
    }),
    openMusicPlayer: () => openWebPlayer()
  };
}

function stop() {
  musicRemotes.clear();
  playerSocket = null;
  lastState = null;
}

module.exports = {
  setPlayerSocket, clearPlayerSocket, addRemote, removeRemote,
  handlePlayerMessage, sendToPlayer, getLastState, isPlayerConnected,
  health, wsHandlers, stop
};
