const { spotifyRequest } = require('./auth');

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function toCamelot(key, mode) {
  if (key === null || key === undefined || key < 0) return null;
  const major = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
  const minor = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
  const map = mode === 1 ? major : minor;
  return map[key] || null;
}

function parseYearFromDate(rawDate) {
  if (!rawDate) return null;
  const match = /^\d{4}/.exec(rawDate);
  return match ? Number(match[0]) : null;
}

async function fetchCurrentUserPlaylists() {
  let offset = 0;
  const limit = 50;
  const allItems = [];

  while (true) {
    const page = await spotifyRequest('GET', '/me/playlists', {
      limit,
      offset,
    });
    allItems.push(...(page.items || []));
    offset += limit;
    if (!page.next) break;
  }

  return allItems.map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    description: playlist.description || '',
    totalTracks: playlist.tracks?.total || 0,
    owner: playlist.owner?.display_name || playlist.owner?.id,
    collaborative: playlist.collaborative,
    isPublic: playlist.public,
    snapshotId: playlist.snapshot_id,
    imageUrl: playlist.images?.[0]?.url || null,
    href: playlist.external_urls?.spotify || null,
  }));
}

async function fetchPlaylistItems(playlistId) {
  const all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const page = await spotifyRequest('GET', `/playlists/${playlistId}/tracks`, {
      offset,
      limit,
      market: 'from_token',
      additional_types: 'track',
    });
    all.push(...(page.items || []));
    offset += limit;
    if (!page.next) break;
  }

  return all;
}

async function fetchAudioFeaturesByIds(trackIds) {
  const result = new Map();
  for (const group of chunk(trackIds, 100)) {
    const response = await spotifyRequest('GET', '/audio-features', {
      ids: group.join(','),
    });
    for (const feature of response.audio_features || []) {
      if (feature && feature.id) {
        result.set(feature.id, feature);
      }
    }
  }
  return result;
}

async function fetchArtistsByIds(artistIds) {
  const result = new Map();
  for (const group of chunk(artistIds, 50)) {
    const response = await spotifyRequest('GET', '/artists', {
      ids: group.join(','),
    });
    for (const artist of response.artists || []) {
      if (artist && artist.id) {
        result.set(artist.id, artist);
      }
    }
  }
  return result;
}

async function fetchPlaylistWithMetadata(playlistId) {
  const playlist = await spotifyRequest('GET', `/playlists/${playlistId}`);
  const items = await fetchPlaylistItems(playlistId);

  const tracks = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.track?.type === 'track' && item.track.id);

  const trackIds = tracks.map(({ item }) => item.track.id);
  const artistIds = Array.from(
    new Set(
      tracks
        .flatMap(({ item }) => item.track.artists || [])
        .map((artist) => artist.id)
        .filter(Boolean)
    )
  );

  const [audioFeaturesMap, artistsMap] = await Promise.all([
    fetchAudioFeaturesByIds(trackIds),
    fetchArtistsByIds(artistIds),
  ]);

  const hydratedTracks = tracks.map(({ item, index }) => {
    const track = item.track;
    const features = audioFeaturesMap.get(track.id) || {};
    const album = track.album || {};
    const artistNames = (track.artists || []).map((a) => a.name).filter(Boolean);
    const artistGenres = Array.from(
      new Set(
        (track.artists || [])
          .flatMap((artist) => artistsMap.get(artist.id)?.genres || [])
          .map((genre) => genre.toLowerCase())
      )
    );

    const releaseDate = album.release_date || null;
    const releaseYear = parseYearFromDate(releaseDate);
    const addedAt = item.added_at || null;
    const primaryArtist = artistNames[0] || '';
    const camelot = toCamelot(features.key, features.mode);

    return {
      customOrder: index,
      playlistItemId: item.id || null,
      addedAt,
      addedBy: item.added_by?.id || null,
      isLocal: Boolean(item.is_local),
      trackId: track.id,
      uri: track.uri,
      title: track.name,
      artists: artistNames,
      artistDisplay: artistNames.join(', '),
      primaryArtist,
      artistIds: (track.artists || []).map((artist) => artist.id).filter(Boolean),
      albumId: album.id || null,
      albumName: album.name || null,
      albumType: album.album_type || null,
      albumReleaseDate: releaseDate,
      albumReleaseYear: releaseYear,
      discNumber: track.disc_number || null,
      trackNumber: track.track_number || null,
      durationMs: track.duration_ms || null,
      durationSeconds: track.duration_ms ? track.duration_ms / 1000 : null,
      explicit: Boolean(track.explicit),
      popularity: track.popularity ?? null,
      isrc: track.external_ids?.isrc || null,
      availableMarketsCount: Array.isArray(track.available_markets)
        ? track.available_markets.length
        : null,
      previewUrl: track.preview_url || null,
      linkedFromId: track.linked_from?.id || null,
      genres: artistGenres,
      genreDisplay: artistGenres.join(', '),
      acousticness: features.acousticness ?? null,
      danceability: features.danceability ?? null,
      energy: features.energy ?? null,
      instrumentalness: features.instrumentalness ?? null,
      liveness: features.liveness ?? null,
      loudness: features.loudness ?? null,
      speechiness: features.speechiness ?? null,
      valence: features.valence ?? null,
      tempo: features.tempo ?? null,
      bpm: features.tempo ?? null,
      key: features.key ?? null,
      mode: features.mode ?? null,
      keyModeLabel:
        features.key === undefined || features.key === null || features.key < 0
          ? null
          : `${features.key}${features.mode === 1 ? ' major' : ' minor'}`,
      camelot,
      timeSignature: features.time_signature ?? null,
      analysisUrl: features.analysis_url || null,
      analysisAvailable: Boolean(features.analysis_url),
      metadataSource: {
        track: true,
        playlistItem: true,
        audioFeatures: Boolean(audioFeaturesMap.get(track.id)),
        artistGenres: artistGenres.length > 0,
      },
    };
  });

  return {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description || '',
      owner: playlist.owner?.display_name || playlist.owner?.id,
      ownerId: playlist.owner?.id,
      public: playlist.public,
      collaborative: playlist.collaborative,
      snapshotId: playlist.snapshot_id,
      followers: playlist.followers?.total ?? null,
      imageUrl: playlist.images?.[0]?.url || null,
      externalUrl: playlist.external_urls?.spotify || null,
      totalTracks: hydratedTracks.length,
    },
    tracks: hydratedTracks,
  };
}

async function reorderPlaylist(playlistId, trackUris) {
  // Replace playlist with the new order in chunks of 100 items.
  const chunks = chunk(trackUris, 100);
  const first = chunks[0] || [];
  const response = await spotifyRequest('PUT', `/playlists/${playlistId}/tracks`, {}, { uris: first });
  const snapshotId = response?.snapshot_id;

  for (let index = 1; index < chunks.length; index += 1) {
    await spotifyRequest('POST', `/playlists/${playlistId}/tracks`, {}, { uris: chunks[index] });
  }

  return { snapshotId };
}

async function createPlaylistFromTracks(payload) {
  const me = await spotifyRequest('GET', '/me');
  const createBody = {
    name: payload.name,
    description: payload.description || 'Created in Spotify Manager',
    public: Boolean(payload.public),
  };

  const created = await spotifyRequest('POST', `/users/${me.id}/playlists`, {}, createBody);
  const uris = payload.trackUris || [];
  for (const uriChunk of chunk(uris, 100)) {
    await spotifyRequest('POST', `/playlists/${created.id}/tracks`, {}, { uris: uriChunk });
  }

  return {
    id: created.id,
    url: created.external_urls?.spotify || null,
    name: created.name,
  };
}

module.exports = {
  fetchCurrentUserPlaylists,
  fetchPlaylistWithMetadata,
  reorderPlaylist,
  createPlaylistFromTracks,
};
