let _broadcastToChannel = () => 0;
let _getSubscribers = () => [];
let _broadcastAll = () => 0;
let _getAuthenticatedClients = () => [];

const handler = {
  get broadcastToChannel() { return _broadcastToChannel; },
  set broadcastToChannel(fn) { _broadcastToChannel = fn; },

  get getSubscribers() { return _getSubscribers; },
  set getSubscribers(fn) { _getSubscribers = fn; },

  get broadcastAll() { return _broadcastAll; },
  set broadcastAll(fn) { _broadcastAll = fn; },

  get getAuthenticatedClients() { return _getAuthenticatedClients; },
  set getAuthenticatedClients(fn) { _getAuthenticatedClients = fn; },

  init() {},
  close() {}
};

module.exports = handler;
