/**
 * Browser-compatible Spotify API layer.
 */

import { getGrantedScopes, getMissingScopes, spotifyRequest } from './auth.js';
import { createLogger, nowMs } from './debug.js';

const dlog = createLogger('spotify-api');
const ENDPOINT_AVAILABILITY_KEY = 'spotifyManager.endpointAvailability.v1';
let endpointAvailabilityCache = null;

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEndpointAvailability() {
  if (endpointAvailabilityCache) {
    return endpointAvailabilityCache;
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(ENDPOINT_AVAILABILITY_KEY) || '{}');
    endpointAvailabilityCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    endpointAvailabilityCache = {};
  }

  return endpointAvailabilityCache;
}

function persistEndpointAvailability(nextValue) {
  endpointAvailabilityCache = nextValue;
  try {
    localStorage.setItem(ENDPOINT_AVAILABILITY_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the session cache only.
  }
}

function isEndpointAvailable(endpointKey) {
  return readEndpointAvailability()[endpointKey] !== false;
}

function markEndpointUnavailable(endpointKey, reason) {
  const current = readEndpointAvailability();
  if (current[endpointKey] === false) {
    return;
  }
  persistEndpointAvailability({
    ...current,
    [endpointKey]: false,
  });
  dlog('endpoint:disabled', {
    endpointKey,
    reason,
  });
}

function isSpotifyStatus(error, statusCode) {
  return String(error?.message || error).includes(`Spotify API ${statusCode}`);
}

function formatMissingScopesMessage(scopes) {
  const label = scopes.length === 1 ? 'scope' : 'scopes';
  return `Spotify authorization is missing required ${label}: ${scopes.join(', ')}. Sign out and sign in again, then approve the updated permissions.`;
}

function ensurePlaylistModifyScope(isPublic) {
  const missingScopes = getMissingScopes([isPublic ? 'playlist-modify-public' : 'playlist-modify-private']);
  if (missingScopes.length) {
    throw new Error(formatMissingScopesMessage(missingScopes));
  }
}

function formatProductLabel(product) {
  const value = String(product || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'open') return 'free/open';
  return value;
}

function formatPlaylistMutationDiagnostics(diagnostics) {
  const parts = [];
  if (diagnostics.currentUserId) {
    parts.push(`signed-in user=${diagnostics.currentUserId}`);
  }
  if (diagnostics.currentUserProduct) {
    parts.push(`product=${formatProductLabel(diagnostics.currentUserProduct)}`);
  }
  if (diagnostics.playlistOwnerId) {
    parts.push(`playlist owner=${diagnostics.playlistOwnerId}`);
  }
  if (typeof diagnostics.playlistPublic === 'boolean') {
    parts.push(`playlist public=${diagnostics.playlistPublic}`);
  }
  if (Number.isFinite(diagnostics.uriCount)) {
    parts.push(`uris=${diagnostics.uriCount}`);
  }
  if (diagnostics.grantedScopes?.length) {
    parts.push(`granted scopes=${diagnostics.grantedScopes.join(', ')}`);
  }
  if (diagnostics.sampleUris?.length) {
    parts.push(`sample uris=${diagnostics.sampleUris.join(', ')}`);
  }
  return parts.join('; ');
}

function formatPlaylistMutationHint(diagnostics) {
  const product = String(diagnostics.currentUserProduct || '').trim().toLowerCase();
  if (product && product !== 'premium') {
    return 'The signed-in Spotify account is not Premium. Since March 9, 2026, Development Mode requires Premium for the app owner and can return 403 on playlist item writes.';
  }
  return 'Spotify community reports in March 2026 show some app/account-level Development Mode restrictions returning 403 on playlist item endpoints even with correct scopes and playlist ownership.';
}

async function collectPlaylistMutationDiagnostics({ currentUser, playlistId, createdPlaylist, uris }) {
  let playlistDetails = null;
  try {
    playlistDetails = await spotifyRequest('GET', `/playlists/${playlistId}`, {
      fields: 'id,public,collaborative,owner(id)',
    });
  } catch (error) {
    dlog('collectPlaylistMutationDiagnostics:playlistLookupFailed', {
      playlistId,
      message: String(error?.message || error),
    });
  }

  return {
    currentUserId: currentUser?.id || null,
    currentUserProduct: currentUser?.product || null,
    playlistOwnerId: playlistDetails?.owner?.id || createdPlaylist?.owner?.id || null,
    playlistPublic: typeof playlistDetails?.public === 'boolean'
      ? playlistDetails.public
      : typeof createdPlaylist?.public === 'boolean'
        ? createdPlaylist.public
        : null,
    grantedScopes: getGrantedScopes(),
    uriCount: uris?.length || 0,
    sampleUris: (uris || []).slice(0, 3),
  };
}

async function waitForPlaylistMutationReady(playlistId) {
  const delays = [0, 500, 1500, 3500, 7000];
  let lastError = null;

  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index] > 0) {
      await sleep(delays[index]);
    }

    try {
      await spotifyRequest('GET', `/playlists/${playlistId}`, {
        fields: 'id,snapshot_id,public,collaborative,owner(id)',
      });
      dlog('waitForPlaylistMutationReady:ready', {
        playlistId,
        attempts: index + 1,
      });
      return true;
    } catch (error) {
      lastError = error;
      const retryable = isSpotifyStatus(error, 403) || isSpotifyStatus(error, 404) || /Spotify API 5\d\d/.test(String(error?.message || error));
      if (!retryable || index === delays.length - 1) {
        break;
      }
    }
  }

  dlog('waitForPlaylistMutationReady:notReady', {
    playlistId,
    message: String(lastError?.message || lastError),
  });
  return false;
}

// --------------- Playlists ---------------

export async function fetchCurrentUserPlaylists() {
  const startedAt = nowMs();
  dlog('fetchCurrentUserPlaylists:start');
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

  const playlistsNeedingHydration = mapped.filter(
    (item) => item.canLoad && (!Number.isFinite(item.totalTracks) || item.totalTracks === 0)
  );

  if (playlistsNeedingHydration.length) {
    const hydrated = await Promise.all(
      mapped.map(async (item) => {
        if (!playlistsNeedingHydration.some((candidate) => candidate.id === item.id)) {
          return item;
        }
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
    dlog('fetchCurrentUserPlaylists:done', {
      count: hydrated.length,
      durationMs: Math.round(nowMs() - startedAt),
      hydratedMissingCounts: true,
    });
    return hydrated;
  }

  dlog('fetchCurrentUserPlaylists:done', {
    count: mapped.length,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return mapped;
}

// --------------- Playlist Items ---------------

function normalizePlaylistItem(raw) {
  const candidate = raw?.track || raw?.item;
  if (!candidate || candidate.type !== 'track') return null;
  return { ...raw, track: candidate };
}

async function fetchPlaylistItems(playlistId, progressCb) {
  const startedAt = nowMs();
  dlog('fetchPlaylistItems:start', { playlistId });
  const all = [];
  let offset = 0;
  const limit = 50;
  let pageIndex = 0;

  while (true) {
    const page = await spotifyRequest('GET', `/playlists/${playlistId}/items`, {
      offset, limit, additional_types: 'track',
    });

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
  dlog('fetchPlaylistItems:done', {
    playlistId,
    items: all.length,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return all;
}

// --------------- Audio Features ---------------

async function fetchAudioFeaturesByIds(trackIds, progressCb) {
  const startedAt = nowMs();
  dlog('fetchAudioFeaturesByIds:start', { count: trackIds.length });
  const result = new Map();
  const blockedTrackIds = new Set();

  if (!isEndpointAvailable('audioFeatures')) {
    progressCb?.({
      stage: 'audio-features',
      message: 'Skipping audio features because Spotify previously returned 403 for this endpoint.',
      blockedTracks: trackIds.length,
    });
    return result;
  }

  const groups = chunk(trackIds, 100);

  async function fetchGroupWithFallback(ids) {
    if (!ids.length) return;
    try {
      const response = await spotifyRequest('GET', '/audio-features', { ids: ids.join(',') });
      for (const feature of response.audio_features || []) {
        if (feature && feature.id) result.set(feature.id, feature);
      }
      return true;
    } catch (error) {
      const message = String(error?.message || error);
      const isForbidden = message.includes(' 403 ') || message.includes('status" : 403');
      if (!isForbidden) throw error;
      markEndpointUnavailable('audioFeatures', message);
      ids.forEach((id) => blockedTrackIds.add(id));
      progressCb?.({
        stage: 'audio-features',
        message: 'Spotify blocked audio feature lookup. Continuing without BPM/energy metadata.',
        blockedTracks: blockedTrackIds.size,
      });
      dlog('fetchAudioFeaturesByIds:forbiddenBatch', {
        blocked: ids.length,
        totalBlocked: blockedTrackIds.size,
      });
      return false;
    }
  }

  for (let index = 0; index < groups.length; index += 1) {
    const completed = await fetchGroupWithFallback(groups[index]);
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
    if (completed === false) {
      break;
    }
  }
  dlog('fetchAudioFeaturesByIds:done', {
    resolved: result.size,
    blocked: blockedTrackIds.size,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return result;
}

// --------------- Full Playlist with Metadata ---------------

export async function fetchPlaylistWithMetadata(playlistId, progressCb) {
  const startedAt = nowMs();
  dlog('fetchPlaylistWithMetadata:start', { playlistId });
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
  if (typeof progressCb === 'function') {
    progressCb({
      stage: 'enrichment-start',
      message: `Enriching ${trackIds.length} tracks with audio metadata...`,
    });
  }

  let audioFeaturesMap = new Map();
  const [audioFeaturesResult] = await Promise.allSettled([
    fetchAudioFeaturesByIds(trackIds, progressCb),
  ]);

  if (audioFeaturesResult.status === 'fulfilled') audioFeaturesMap = audioFeaturesResult.value;

  const hydratedTracks = tracks.map(({ item, index }) => {
    const track = item.track;
    const features = audioFeaturesMap.get(track.id) || {};
    const album = track.album || {};
    const artistNames = (track.artists || []).map((a) => a.name).filter(Boolean);

    const releaseDate = album.release_date || null;

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
      timeSignature: features.time_signature ?? null,
      analysisUrl: features.analysis_url || null,
      analysisAvailable: Boolean(features.analysis_url),
      recordLabel: null,
      metadataSource: {
        track: true,
        playlistItem: true,
        audioFeatures: Boolean(audioFeaturesMap.get(track.id)),
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

  dlog('fetchPlaylistWithMetadata:done', {
    playlistId,
    tracks: hydratedTracks.length,
    durationMs: Math.round(nowMs() - startedAt),
  });

  return result;
}

export async function createPlaylistFromTracks(payload) {
  ensurePlaylistModifyScope(Boolean(payload.public));
  const currentUser = await spotifyRequest('GET', '/me');

  const createBody = {
    name: payload.name,
    description: payload.description || 'Created in Spotify Manager',
    public: Boolean(payload.public),
  };

  const created = await spotifyRequest('POST', '/me/playlists', {}, createBody);
  await waitForPlaylistMutationReady(created.id);
  const uris = payload.trackUris || [];
  const uriChunks = chunk(uris, 100);

  for (let index = 0; index < uriChunks.length; index += 1) {
    const uriChunk = uriChunks[index];
    await addTracksChunkWithRetry(created.id, uriChunk, index, uriChunks.length, {
      currentUser,
      createdPlaylist: created,
    });
  }

  return {
    id: created.id,
    url: created.external_urls?.spotify || null,
    name: created.name,
    totalTracks: uris.length,
  };
}

async function addTracksChunkWithRetry(playlistId, uris, chunkIndex, totalChunks, context = {}) {
  const attempts = [0, 500, 1500, 3500, 7000];
  let lastError = null;

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
    if (attempts[attemptIndex] > 0) {
      await sleep(attempts[attemptIndex]);
    }

    try {
      await spotifyRequest('POST', `/playlists/${playlistId}/items`, {}, { uris });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const isForbidden = isSpotifyStatus(error, 403);
      const isRateLimited = isSpotifyStatus(error, 429);
      const isServerError = /Spotify API 5\d\d/.test(message);

      if (attemptIndex === attempts.length - 1) {
        break;
      }

      if (attemptIndex === 0 && isForbidden) {
        await waitForPlaylistMutationReady(playlistId);
        try {
          await spotifyRequest('PUT', `/playlists/${playlistId}/items`, {}, { uris });
          return;
        } catch (putError) {
          lastError = putError;
          if (!isSpotifyStatus(putError, 403)) {
            throw putError;
          }
        }
      }

      if (!isForbidden && !isRateLimited && !isServerError) {
        throw error;
      }
    }
  }

  const diagnostics = await collectPlaylistMutationDiagnostics({
    currentUser: context.currentUser,
    playlistId,
    createdPlaylist: context.createdPlaylist,
    uris,
  });
  const diagnosticsText = formatPlaylistMutationDiagnostics(diagnostics);
  const hint = formatPlaylistMutationHint(diagnostics);
  dlog('addTracksChunkWithRetry:failed', {
    playlistId,
    chunkIndex,
    totalChunks,
    lastError: String(lastError?.message || lastError),
    diagnostics,
  });

  throw new Error(
        `Playlist created but adding items failed at chunk ${chunkIndex + 1}/${totalChunks}: ${String(lastError?.message || lastError)} Diagnostics: ${diagnosticsText}. ${hint}`
  );
}
