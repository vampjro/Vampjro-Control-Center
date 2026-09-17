(function () {
  'use strict';

  const PREFIX = 'AMREMOTE_';
  let mk = null;

  function post(type, data) {
    window.postMessage({ type: PREFIX + type, ...data }, '*');
  }

  function waitForMusicKit() {
    const poll = setInterval(() => {
      try {
        const instance = window.MusicKit && MusicKit.getInstance();
        if (instance) {
          clearInterval(poll);
          mk = instance;
          console.log('[AM Remote] MusicKit agganciato');
          setup();
        }
      } catch (_) {}
    }, 500);
  }

  function artworkUrl(urlTemplate, size) {
    if (!urlTemplate) return '';
    return urlTemplate.replace('{w}', size).replace('{h}', size);
  }

  function buildNowPlaying() {
    const np = mk.nowPlayingItem;
    if (!np) return null;
    return {
      title: np.title || np.attributes?.name || '',
      artist: np.artistName || np.attributes?.artistName || '',
      album: np.albumName || np.attributes?.albumName || '',
      artwork: artworkUrl(np.artworkURL || np.attributes?.artwork?.url, 600),
      duration: (np.attributes?.durationInMillis || 0) / 1000,
      id: np.id,
      type: np.type
    };
  }

  function buildQueue() {
    try {
      const items = mk.queue.items || mk.queue._queueItems || [];
      return items.map((item, i) => ({
        index: i,
        title: item.title || item.attributes?.name || '',
        artist: item.artistName || item.attributes?.artistName || '',
        album: item.albumName || item.attributes?.albumName || '',
        artwork: artworkUrl(item.artworkURL || item.attributes?.artwork?.url, 120),
        id: item.id
      }));
    } catch (_) {
      return [];
    }
  }

  function buildFullState() {
    return {
      playbackState: mk.playbackState,
      nowPlaying: buildNowPlaying(),
      currentTime: mk.currentPlaybackTime || 0,
      duration: mk.currentPlaybackDuration || 0,
      volume: mk.volume,
      shuffleMode: mk.shuffleMode,
      repeatMode: mk.repeatMode,
      queue: buildQueue(),
      queuePosition: mk.queue?.position ?? -1
    };
  }

  function sendState() { post('STATE', { data: buildFullState() }); }
  function sendTime() {
    post('TIME', {
      currentTime: mk.currentPlaybackTime || 0,
      duration: mk.currentPlaybackDuration || 0
    });
  }

  function setup() {
    ['playbackStateDidChange', 'nowPlayingItemDidChange', 'playbackVolumeDidChange',
     'queueItemsDidChange', 'queuePositionDidChange', 'shuffleModeDidChange',
     'repeatModeDidChange', 'playbackDurationDidChange'
    ].forEach(ev => mk.addEventListener(ev, () => sendState()));
    mk.addEventListener('playbackTimeDidChange', () => sendTime());

    mk.addEventListener('nowPlayingItemDidChange', () => {
      const np = mk.nowPlayingItem;
      if (np?.id) checkLiked(np.id);
    });

    window.addEventListener('message', onCommand);
    sendState();
    const np = mk.nowPlayingItem;
    if (np?.id) checkLiked(np.id);
  }

  function formatSong(s) {
    return {
      id: s.id, type: 'song',
      title: s.attributes?.name || '',
      artist: s.attributes?.artistName || '',
      album: s.attributes?.albumName || '',
      artwork: artworkUrl(s.attributes?.artwork?.url, 120),
      duration: (s.attributes?.durationInMillis || 0) / 1000
    };
  }

  function formatAlbum(a) {
    return {
      id: a.id, type: a.type || 'album',
      name: a.attributes?.name || '',
      artist: a.attributes?.artistName || '',
      artwork: artworkUrl(a.attributes?.artwork?.url, 200),
      trackCount: a.attributes?.trackCount || 0
    };
  }

  function formatLibraryItem(item) {
    return {
      id: item.id,
      type: item.type,
      name: item.attributes?.name || '',
      artist: item.attributes?.artistName || '',
      artwork: artworkUrl(item.attributes?.artwork?.url, 200),
      trackCount: item.attributes?.trackCount || 0
    };
  }

  function formatArtistItem(a) {
    return {
      id: a.id, type: 'artist',
      name: a.attributes?.name || '',
      artwork: artworkUrl(a.attributes?.artwork?.url, 200),
      genres: (a.attributes?.genreNames || []).join(', ')
    };
  }

  // --- Like ---
  async function checkLiked(songId) {
    try {
      const res = await mk.api.music('/v1/me/ratings/songs/' + songId);
      const liked = res.data?.data?.[0]?.attributes?.value === 1;
      post('LIKED_STATUS', { songId, liked });
    } catch (_) {
      post('LIKED_STATUS', { songId, liked: false });
    }
  }

  async function toggleLike(songId) {
    try {
      const checkRes = await mk.api.music('/v1/me/ratings/songs/' + songId);
      const isLiked = checkRes.data?.data?.[0]?.attributes?.value === 1;
      if (isLiked) {
        await fetch('https://api.music.apple.com/v1/me/ratings/songs/' + songId, {
          method: 'DELETE',
          headers: {
            'Authorization': 'Bearer ' + mk.developerToken,
            'Music-User-Token': mk.musicUserToken
          }
        });
        post('LIKED_STATUS', { songId, liked: false });
      } else {
        await fetch('https://api.music.apple.com/v1/me/ratings/songs/' + songId, {
          method: 'PUT',
          headers: {
            'Authorization': 'Bearer ' + mk.developerToken,
            'Music-User-Token': mk.musicUserToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ type: 'rating', attributes: { value: 1 } })
        });
        post('LIKED_STATUS', { songId, liked: true });
      }
    } catch (err) {
      console.error('[AM Remote] toggleLike error', err);
    }
  }

  // --- Search ---
  async function doSearch(term, requestId) {
    try {
      const res = await mk.api.music(
        '/v1/catalog/{{storefrontId}}/search',
        { term, types: 'songs,albums,artists', limit: 20 }
      );
      const r = res.data?.results || {};
      post('SEARCH_RESULTS', {
        requestId,
        results: {
          songs: (r.songs?.data || []).map(formatSong),
          albums: (r.albums?.data || []).map(formatAlbum),
          artists: (r.artists?.data || []).map(formatArtistItem)
        }
      });
    } catch (err) {
      console.error('[AM Remote] Search error', err);
      post('SEARCH_RESULTS', { requestId, results: { songs: [], albums: [], artists: [] }, error: String(err) });
    }
  }

  // --- Album tracks ---
  async function fetchAlbumTracks(albumId, requestId) {
    try {
      const isLibrary = albumId.startsWith('l.');
      const endpoint = isLibrary
        ? '/v1/me/library/albums/' + albumId
        : '/v1/catalog/{{storefrontId}}/albums/' + albumId;
      const res = await mk.api.music(endpoint, { include: 'tracks' });
      const album = res.data?.data?.[0];
      const tracks = album?.relationships?.tracks?.data || [];
      post('ALBUM_TRACKS', {
        requestId,
        album: {
          id: album.id, type: album.type,
          name: album.attributes?.name || '',
          artist: album.attributes?.artistName || '',
          artwork: artworkUrl(album.attributes?.artwork?.url, 600),
          trackCount: album.attributes?.trackCount || 0
        },
        tracks: tracks.map((t, i) => ({
          id: t.id, type: 'song',
          title: t.attributes?.name || '',
          artist: t.attributes?.artistName || '',
          trackNumber: t.attributes?.trackNumber || (i + 1),
          duration: (t.attributes?.durationInMillis || 0) / 1000
        }))
      });
    } catch (err) {
      console.error('[AM Remote] getAlbumTracks error', err);
      post('ALBUM_TRACKS', { requestId, error: String(err) });
    }
  }

  // --- Playlist tracks ---
  async function fetchPlaylistTracks(playlistId, requestId) {
    try {
      const isLibrary = playlistId.startsWith('p.');
      const endpoint = isLibrary
        ? '/v1/me/library/playlists/' + playlistId
        : '/v1/catalog/{{storefrontId}}/playlists/' + playlistId;
      const res = await mk.api.music(endpoint, { include: 'tracks' });
      const pl = res.data?.data?.[0];
      const tracks = pl?.relationships?.tracks?.data || [];
      post('PLAYLIST_TRACKS', {
        requestId,
        playlist: {
          id: pl.id, type: pl.type,
          name: pl.attributes?.name || '',
          artist: pl.attributes?.curatorName || pl.attributes?.description?.standard || '',
          artwork: artworkUrl(pl.attributes?.artwork?.url, 600),
          trackCount: tracks.length
        },
        tracks: tracks.map((t, i) => ({
          id: t.id, type: 'song',
          title: t.attributes?.name || '',
          artist: t.attributes?.artistName || '',
          trackNumber: i + 1,
          duration: (t.attributes?.durationInMillis || 0) / 1000
        }))
      });
    } catch (err) {
      console.error('[AM Remote] getPlaylistTracks error', err);
      post('PLAYLIST_TRACKS', { requestId, error: String(err) });
    }
  }

  // --- Artist ---
  async function fetchArtist(artistId, requestId) {
    try {
      const res = await mk.api.music(
        '/v1/catalog/{{storefrontId}}/artists/' + artistId,
        { include: 'top-songs,albums' }
      );
      const artist = res.data?.data?.[0];
      const topSongs = artist?.relationships?.['top-songs']?.data || [];
      const albums = artist?.relationships?.albums?.data || [];
      post('ARTIST_DATA', {
        requestId,
        artist: {
          id: artist.id,
          name: artist.attributes?.name || '',
          artwork: artworkUrl(artist.attributes?.artwork?.url, 600),
          genres: (artist.attributes?.genreNames || []).join(', ')
        },
        topSongs: topSongs.map(formatSong),
        albums: albums.map(formatAlbum)
      });
    } catch (err) {
      console.error('[AM Remote] getArtist error', err);
      post('ARTIST_DATA', { requestId, error: String(err) });
    }
  }

  async function searchArtistByName(name, requestId) {
    try {
      const s = await mk.api.music('/v1/catalog/{{storefrontId}}/search', {
        term: name, types: 'artists', limit: 1
      });
      const artists = s.data?.results?.artists?.data || [];
      if (artists.length) {
        await fetchArtist(artists[0].id, requestId);
      } else {
        post('ARTIST_DATA', { requestId, error: 'not found' });
      }
    } catch (err) {
      post('ARTIST_DATA', { requestId, error: String(err) });
    }
  }

  // --- Library ---
  async function fetchLibrary(requestId) {
    const results = { recentlyPlayed: [], recentlyAdded: [], playlists: [] };
    try {
      const r = await mk.api.music('/v1/me/recent/played', { limit: 20 });
      results.recentlyPlayed = (r.data?.data || [])
        .filter(i => ['albums','playlists','library-albums','library-playlists'].includes(i.type))
        .map(formatLibraryItem);
    } catch (_) {}
    try {
      const r = await mk.api.music('/v1/me/library/recently-added', { limit: 20 });
      results.recentlyAdded = (r.data?.data || []).map(formatLibraryItem);
    } catch (_) {}
    try {
      const r = await mk.api.music('/v1/me/library/playlists', { limit: 50 });
      results.playlists = (r.data?.data || []).map(formatLibraryItem);
    } catch (_) {}
    post('LIBRARY_DATA', { requestId, ...results });
  }

  // --- Command handler ---
  function onCommand(e) {
    if (e.data?.type !== PREFIX + 'COMMAND') return;
    const msg = e.data;
    switch (msg.command) {
      case 'play': mk.play(); break;
      case 'pause': mk.pause(); break;
      case 'next': mk.skipToNextItem(); break;
      case 'previous': mk.skipToPreviousItem(); break;
      case 'seek': mk.seekToTime(msg.time); break;
      case 'setVolume': mk.volume = msg.volume; break;
      case 'setShuffle': mk.shuffleMode = msg.mode; break;
      case 'setRepeat': mk.repeatMode = msg.mode; break;
      case 'search': doSearch(msg.term, msg.requestId); break;
      case 'playSong':
        mk.setQueue({ song: msg.id }).then(() => mk.play()).catch(e => console.error('[AM Remote]', e));
        break;
      case 'playAlbum':
        mk.setQueue({ album: msg.id }).then(() => mk.play()).catch(e => console.error('[AM Remote]', e));
        break;
      case 'playAlbumFrom':
        mk.setQueue({ album: msg.albumId }).then(() => {
          if (msg.trackIndex > 0) return mk.playAt(msg.trackIndex);
          return mk.play();
        }).catch(e => console.error('[AM Remote]', e));
        break;
      case 'playPlaylist':
        mk.setQueue({ playlist: msg.id }).then(() => mk.play()).catch(e => console.error('[AM Remote]', e));
        break;
      case 'playPlaylistFrom':
        mk.setQueue({ playlist: msg.playlistId }).then(() => {
          if (msg.trackIndex > 0) return mk.playAt(msg.trackIndex);
          return mk.play();
        }).catch(e => console.error('[AM Remote]', e));
        break;
      case 'playNext':
        try { mk.playNext({ song: msg.id }); } catch (_) {
          try { mk.queue.prepend({ song: msg.id }); } catch (e) { console.error('[AM Remote]', e); }
        }
        break;
      case 'playLater':
        try { mk.playLater({ song: msg.id }); } catch (_) {
          try { mk.queue.append({ song: msg.id }); } catch (e) { console.error('[AM Remote]', e); }
        }
        break;
      case 'toggleLike': toggleLike(msg.id); break;
      case 'checkLiked': checkLiked(msg.id); break;
      case 'getAlbumTracks': fetchAlbumTracks(msg.id, msg.requestId); break;
      case 'getPlaylistTracks': fetchPlaylistTracks(msg.id, msg.requestId); break;
      case 'getArtist': fetchArtist(msg.id, msg.requestId); break;
      case 'searchArtist': searchArtistByName(msg.name, msg.requestId); break;
      case 'getLibrary': fetchLibrary(msg.requestId); break;
      case 'skipTo':
        mk.playAt(msg.index).catch(e => console.error('[AM Remote]', e));
        break;
      case 'removeFromQueue':
        try { mk.queue.remove(msg.index); } catch (e) { console.error('[AM Remote]', e); }
        break;
      case 'getState': sendState(); break;
    }
  }

  waitForMusicKit();
})();
