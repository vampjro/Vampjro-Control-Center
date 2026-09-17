(function () {
  'use strict';

  const PREFIX = 'AMREMOTE_';
  let port = null;

  function connectToBackground() {
    port = chrome.runtime.connect({ name: 'amremote' });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'ws_connected') {
        window.postMessage({ type: PREFIX + 'COMMAND', command: 'getState' }, '*');
        return;
      }
      if (msg.type === 'command') {
        const { type, ...rest } = msg;
        window.postMessage({ type: PREFIX + 'COMMAND', ...rest }, '*');
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectToBackground, 1000);
    });
  }

  function send(obj) {
    if (port) {
      try { port.postMessage(obj); } catch (_) {}
    }
  }

  window.addEventListener('message', (e) => {
    const t = e.data?.type;
    if (!t || !t.startsWith(PREFIX)) return;
    const kind = t.slice(PREFIX.length);

    switch (kind) {
      case 'STATE':
        send({ type: 'state', data: e.data.data }); break;
      case 'TIME':
        send({ type: 'timeUpdate', currentTime: e.data.currentTime, duration: e.data.duration }); break;
      case 'SEARCH_RESULTS':
        send({ type: 'searchResults', requestId: e.data.requestId, results: e.data.results, error: e.data.error }); break;
      case 'ALBUM_TRACKS':
        send({ type: 'albumTracks', requestId: e.data.requestId, album: e.data.album, tracks: e.data.tracks, error: e.data.error }); break;
      case 'PLAYLIST_TRACKS':
        send({ type: 'playlistTracks', requestId: e.data.requestId, playlist: e.data.playlist, tracks: e.data.tracks, error: e.data.error }); break;
      case 'LIBRARY_DATA':
        send({ type: 'libraryData', requestId: e.data.requestId, recentlyPlayed: e.data.recentlyPlayed, recentlyAdded: e.data.recentlyAdded, playlists: e.data.playlists }); break;
      case 'LIKED_STATUS':
        send({ type: 'likedStatus', songId: e.data.songId, liked: e.data.liked }); break;
      case 'ARTIST_DATA':
        send({ type: 'artistData', requestId: e.data.requestId, artist: e.data.artist, topSongs: e.data.topSongs, albums: e.data.albums, error: e.data.error }); break;
    }
  });

  connectToBackground();
})();
