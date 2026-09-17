(function () {
  'use strict';

  const WS_URL = 'ws://localhost:3000/music';
  let ws = null;
  let reconnectDelay = 1000;
  let contentPort = null;

  function connect() {
    try { ws = new WebSocket(WS_URL); } catch (_) { scheduleReconnect(); return; }

    ws.onopen = () => {
      console.log('[AM Remote BG] WebSocket connected');
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'register', role: 'player' }));
      sendToContent({ type: 'ws_connected' });
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'command') {
          sendToContent(msg);
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      console.log('[AM Remote BG] WebSocket disconnected, reconnecting...');
      sendToContent({ type: 'ws_disconnected' });
      scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      connect();
    }, reconnectDelay);
  }

  function sendToServer(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function sendToContent(msg) {
    if (contentPort) {
      try { contentPort.postMessage(msg); } catch (_) { contentPort = null; }
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'amremote') return;

    contentPort = port;
    console.log('[AM Remote BG] Content script connected');

    if (ws && ws.readyState === WebSocket.OPEN) {
      port.postMessage({ type: 'ws_connected' });
    }

    port.onMessage.addListener((msg) => {
      sendToServer(msg);
    });

    port.onDisconnect.addListener(() => {
      console.log('[AM Remote BG] Content script disconnected');
      contentPort = null;
    });
  });

  connect();
})();
