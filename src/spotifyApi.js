/**
 * Browser-compatible Spotify API layer.
 * Replaces the Electron main-process spotifyApi module.
 */

import { spotifyRequest } from './auth.js';

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

// --------------- Playlists ---------------

export async function fetchCurrentUserPlaylists() {
  let offset = 0;
  const limit = 50;
  const allItems = [];

  while (true) {
    const page = await spotifyRequest('GET', '/me/playlists', { limit, offset });
    allItems.push(...(page.items || []));
    offset += limit;
    if (!page.next) break;
  }

  const mapped = allItems
    .filter((playlist) => {
      const looksLikePlaylist =
        (playlist?.type === 'playlist' || Boolean(playlist?.id)) &&
        typeof playlist?.name === 'string';
      return looksLikePlaylist;
    })
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description || '',
      totalTracks: Number(playlist.items?.total ?? playlist.tracks?.total ?? playlist.total ?? 0) || 0,
      owner: playlist.owner?.display_name || playlist.owner?.id,
      collaborative: playlist.collaborative,
      isPublic: playlist.public,
      snapshotId: playlist.snapshot_id,
      imageUrl: playlist.images?.[0]?.url || null,
      href: playlist.external_urls?.spotify || null,
      canLoad: Boolean(playlist.id),
    }));

  if (mapped.length && mapped.every((item) => item.totalTracks === 0 && item.canLoad)) {
    const hydrated = await Promise.all(
      mapped.map(async (item) => {
        try {
          const details = await spotifyRequest('GET', `/playlists/${item.id}`, {
            fields: 'tracks(total)',
          });
          return { ...item, totalTracks: Number(details?.tracks?.total ?? 0) || 0 };
        } catch {
          return item;
        }
      })
    );
    return hydrated;
  }

  return mapped;
}

// --------------- Playlist Items ---------------

function normalizePlaylistItem(raw) {
  const candidate = raw?.track || raw?.item;
  if (!candidate || candidate.type !== 'track') return null;
  return { ...raw, track: candidate };
}

async function fetchPlaylistItems(playlistId, progressCb) {
  const all = [];
  let offset = 0;
  const limit = 50;
  let pageIndex = 0;

  while (true) {
    let page;
    try {
      page = await spotifyRequest('GET', `/playlists/${playlistId}/items`, {
        offset, limit, additional_types: 'track',
      });
    } catch {
      page = await spotifyRequest('GET', `/playlists/${playlistId}/tracks`, {
        offset, limit, additional_types: 'track',
      });
    }

    const normalized = (page.items || []).map(normalizePlaylistItem).filter(Boolean);
    all.push(...normalized);
    pageIndex += 1;
    if (typeof progressCb === 'function') {
      progressCb({
        stage: 'playlist-items',
        message: `Fetched playlist items page ${pageIndex}`,
        loadedItems: all.length,
        totalItems: page.total || null,
      });
    }
    offset += limit;
    if (!page.next) break;
  }
  return all;
}

// --------------- Audio Features ---------------

async function fetchAudioFeaturesByIds(trackIds, progressCb) {
  const result = new Map();
  const blockedTrackIds = new Set();
  const groups = chunk(trackIds, 100);

  async function fetchGroupWithFallback(ids) {
    if (!ids.length) return;
    try {
      const response = await spotifyRequest('GET', '/audio-features', { ids: ids.join(',') });
      for (const feature of response.audio_features || []) {
        if (feature && feature.id) result.set(feature.id, feature);
      }
      return;
    } catch (error) {
      const message = String(error?.message || error);
      const isForbidden = message.includes(' 403 ') || message.includes('status" : 403');
      if (!isForbidden) throw error;
      if (ids.length > 1) {
        const midpoint = Math.floor(ids.length / 2);
        await fetchGroupWithFallback(ids.slice(0, midpoint));
        await fetchGroupWithFallback(ids.slice(midpoint));
        return;
      }
      blockedTrackIds.add(ids[0]);
    }
  }

  for (let index = 0; index < groups.length; index += 1) {
    await fetchGroupWithFallback(groups[index]);
    if (typeof progressCb === 'function') {
      const blocked = blockedTrackIds.size;
      progressCb({
        stage: 'audio-features',
        message: blocked > 0
          ? `Fetched audio features batch ${index + 1}/${groups.length} (${blocked} skipped).`
          : `Fetched audio features batch ${index + 1}/${groups.length}`,
        completedBatches: index + 1,
        totalBatches: groups.length,
        blockedTracks: blocked,
      });
    }
  }
  return result;
}

// --------------- Artist Genres ---------------

async function fetchArtistsByIds(artistIds, progressCb) {
  const result = new Map();
  const groups = chunk(artistIds, 50);
  for (let index = 0; index < groups.length; index += 1) {
    const response = await spotifyRequest('GET', '/artists', { ids: groups[index].join(',') });
    for (const artist of response.artists || []) {
      if (artist && artist.id) result.set(artist.id, artist);
    }
    if (typeof progressCb === 'function') {
      progressCb({
        stage: 'artist-genres',
        message: `Fetched artist metadata batch ${index + 1}/${groups.length}`,
        completedBatches: index + 1,
        totalBatches: groups.length,
      });
    }
  }
  return result;
}

// --------------- Full Playlist with Metadata ---------------

export async function fetchPlaylistWithMetadata(playlistId, progressCb) {
  if (typeof progressCb === 'function') {
    progressCb({ stage: 'start', message: 'Loading playlist header...' });
  }

  const playlist = await spotifyRequest('GET', `/playlists/${playlistId}`);

  if (typeof progressCb === 'function') {
    progressCb({
      stage: 'playlist-header',
      message: `Playlist loaded: ${playlist.name}`,
      totalTracks: playlist?.tracks?.total ?? null,
    });
  }

  const items = await fetchPlaylistItems(playlistId, progressCb);

  const tracks = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.track?.type === 'track' && item.track.id);

  const trackIds = tracks.map(({ item }) => item.track.id);
  const artistIds = Array.from(
    new Set(
      tracks.flatMap(({ item }) => item.track.artists || []).map((a) => a.id).filter(Boolean)
    )
  );

  if (typeof progressCb === 'function') {
    progressCb({
      stage: 'enrichment-start',
      message: `Enriching ${trackIds.length} tracks with audio and artist metadata...`,
    });
  }

  let audioFeaturesMap = new Map();
  let artistsMap = new Map();

  const [audioFeaturesResult, artistsResult] = await Promise.allSettled([
    fetchAudioFeaturesByIds(trackIds, progressCb),
    fetchArtistsByIds(artistIds, progressCb),
  ]);

  if (audioFeaturesResult.status === 'fulfilled') audioFeaturesMap = audioFeaturesResult.value;
  if (artistsResult.status === 'fulfilled') artistsMap = artistsResult.value;

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
    const camelot = toCamelot(features.key, features.mode);

    return {
      customOrder: index,
      playlistItemId: item.id || null,
      addedAt: item.added_at || null,
      addedBy: item.added_by?.id || null,
      isLocal: Boolean(item.is_local),
      trackId: track.id,
      uri: track.uri,
      title: track.name,
      artists: artistNames,
      artistDisplay: artistNames.join(', '),
      primaryArtist: artistNames[0] || '',
      artistIds: (track.artists || []).map((a) => a.id).filter(Boolean),
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
      availableMarketsCount: Array.isArray(track.available_markets) ? track.available_markets.length : null,
      previewUrl: track.preview_url || null,
      linkedFromId: track.linked_from?.id || null,
      genres: artistGenres,
      genreDisplay: artistGenres.length ? artistGenres.join(', ') : null,
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
      recordLabel: null,
      metadataSource: {
        track: true,
        playlistItem: true,
        audioFeatures: Boolean(audioFeaturesMap.get(track.id)),
        artistGenres: artistGenres.length > 0,
      },
    };
  });

  const result = {
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

  if (typeof progressCb === 'function') {
    progressCb({
      stage: 'complete',
      message: `Finished loading ${hydratedTracks.length} tracks.`,
      totalTracks: hydratedTracks.length,
    });
  }

  return result;
}

// --------------- Playlist Mutations ---------------

export async function reorderPlaylist(playlistId, trackUris) {
  const chunks = chunk(trackUris, 100);
  const first = chunks[0] || [];
  const response = await spotifyRequest('PUT', `/playlists/${playlistId}/tracks`, {}, { uris: first });
  const snapshotId = response?.snapshot_id;

  for (let index = 1; index < chunks.length; index += 1) {
    await spotifyRequest('POST', `/playlists/${playlistId}/tracks`, {}, { uris: chunks[index] });
  }

  return { snapshotId };
}

export async function createPlaylistFromTracks(payload) {
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
