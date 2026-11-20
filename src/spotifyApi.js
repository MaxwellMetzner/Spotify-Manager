/**
 * Browser-compatible Spotify API layer.
 */

import { getGrantedScopes, getMissingScopes, spotifyRequest } from './auth.js';
import { createLogger, nowMs } from './debug.js';
import { isSpotifyTrackUri } from './shared/playlistComparison.js';
import { canOverwritePlaylist, describeReplacement, playlistSizeError } from './shared/playlistOverwrite.js';

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
      ownerId: playlist.owner?.id,
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

async function* playlistItemPages(playlistId, { isCurrent = () => true, fields, additionalTypes = 'track' } = {}) {
  const limit = 50;
  for (let offset = 0; isCurrent(); offset += limit) {
    const path = `/playlists/${playlistId}/items`;
    const query = { offset, limit, additional_types: additionalTypes };
    let page;
    try { page = await spotifyRequest('GET', path, { ...query, fields }); }
    catch (error) {
      if (!fields || !isSpotifyStatus(error, 400)) throw error;
      // Request full items when the server rejects the field selection.
      if (!isCurrent()) return;
      fields = undefined;
      page = await spotifyRequest('GET', path, query);
    }
    if (!isCurrent()) return;
    yield page;
    if (!page.next) return;
  }
}

async function fetchPlaylistItems(playlistId, progressCb) {
  const startedAt = nowMs();
  dlog('fetchPlaylistItems:start', { playlistId });
  const all = [];
  let pageIndex = 0;
  for await (const page of playlistItemPages(playlistId)) {
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
  }
  dlog('fetchPlaylistItems:done', {
    playlistId,
    items: all.length,
    durationMs: Math.round(nowMs() - startedAt),
  });
  return all;
}

export async function fetchComparisonTracks(playlistId, isCurrent) {
  const rows = [];
  const trackFields = 'type,id,uri,name,is_local,duration_ms,artists(name),album(name)';
  const fields = `next,items(is_local,item(${trackFields}),track(${trackFields}))`;
  for await (const page of playlistItemPages(playlistId, { isCurrent, fields })) {
    for (const item of page.items || []) {
      const track = normalizePlaylistItem(item)?.track;
      // Preserve the source positions of local, unavailable, and non-track entries.
      if (!track || item.is_local || track.is_local) { rows.push(null); continue; }
      rows.push({ trackId: track.id, uri: track.uri, title: track.name, albumName: track.album?.name,
        artists: (track.artists || []).map((artist) => artist.name).filter(Boolean), durationMs: track.duration_ms });
    }
  }
  return rows;
}

async function overwriteHeader(id, userId) {
  const data = await spotifyRequest('GET', `/playlists/${encodeURIComponent(id)}`, {
    fields: 'id,name,snapshot_id,public,collaborative,owner(id,display_name)',
  });
  const target = { id: data.id, name: data.name, snapshotId: data.snapshot_id, ownerId: data.owner?.id,
    owner: data.owner?.display_name || data.owner?.id, isPublic: data.public, collaborative: data.collaborative };
  if (id !== target.id || !canOverwritePlaylist(target, userId)) throw new Error('Choose a playlist you own or can edit as a collaborator.');
  if (!target.snapshotId) throw new Error('Spotify did not provide a playlist version. Reopen the review to try again.');
  if (typeof target.isPublic === 'boolean') ensurePlaylistModifyScope(target.isPublic);
  else if (!getGrantedScopes().some((scope) => scope === 'playlist-modify-private' || scope === 'playlist-modify-public')) {
    throw new Error('Sign in again and grant Spotify permission to modify playlists.');
  }
  return target;
}

function checkPlaylistVersion(actual, expected) {
  if (actual !== expected) {
    const error = new Error('The playlist changed on Spotify. Review the current version before continuing.');
    error.playlistChanged = true;
    throw error;
  }
}

function overwriteError(error) {
  if (isSpotifyStatus(error, 403)) return 'Spotify denied edit access. Check your playlist permissions and the account signed in here.';
  if (isSpotifyStatus(error, 404)) return 'Spotify could not find this playlist for the signed-in account.';
  if (isSpotifyStatus(error, 429)) return 'Spotify is rate limiting requests. Try again after a short wait.';
  return error.message || String(error);
}

export async function inspectPlaylistOverwrite(id, userId, { isCurrent = () => true, onProgress } = {}) {
  if (!id || !userId) throw new Error('Sign in and choose a destination playlist.');
  try {
    const header = await overwriteHeader(id, userId);
    const entries = [];
    const detail = 'type,id,uri,name,artists(name),is_local,linked_from(uri)';
    const fields = `next,total,items(is_local,added_at,added_by(id),item(${detail}),track(${detail}))`;
    let total;
    for await (const page of playlistItemPages(encodeURIComponent(id), { isCurrent, fields, additionalTypes: 'track,episode' })) {
      if (!Array.isArray(page.items) || !Number.isInteger(page.total) || page.total < 0) {
        throw new Error('Spotify returned an incomplete track list. Reopen the review to try again.');
      }
      total = page.total;
      for (const row of page.items) {
        const item = row?.item || row?.track;
        const uri = item?.uri || (item?.type === 'track' && item.id ? 'spotify:track:' + item.id : null);
        const kind = row?.is_local || item?.is_local ? 'local' : item?.type === 'episode' ? 'episode'
          : item?.type === 'track' && isSpotifyTrackUri(uri) ? 'track' : 'unavailable';
        entries.push({ uri, originalUri: item?.linked_from?.uri, title: item?.name,
          artists: (item?.artists || []).map((artist) => artist.name).join('; '), kind,
          addedAt: row?.added_at, addedBy: row?.added_by?.id });
      }
      onProgress?.(entries.length, total);
    }
    if (!isCurrent()) return null;
    const current = await overwriteHeader(id, userId);
    checkPlaylistVersion(current.snapshotId, header.snapshotId);
    if (total !== entries.length) throw new Error('Spotify returned an incomplete track list. Reopen the review to try again.');
    return isCurrent() ? { ...current, entries } : null;
  } catch (error) { throw new Error(overwriteError(error)); }
}

export async function overwritePlaylistItems({ target, userId, uris, allowEmpty = false, onProgress }) {
  if (!target?.snapshotId || !Array.isArray(target.entries) || !Array.isArray(uris) || !uris.every(isSpotifyTrackUri) || (!uris.length && !allowEmpty)) {
    throw new Error('Review a valid track list before overwriting a playlist.');
  }
  const sizeError = playlistSizeError(uris.length);
  if (sizeError) throw new Error(sizeError);
  const { identical, appendFrom, move } = describeReplacement(target.entries, uris);
  let offset = appendFrom ?? 0, snapshotId = target.snapshotId, replace = appendFrom === null;
  let attempted = false, acknowledged = false;
  try {
    // A URI replacement has no atomic snapshot precondition. Check immediately before each batch.
    let current = await overwriteHeader(target.id, userId);
    checkPlaylistVersion(current.snapshotId, snapshotId);
    if (identical) return current;
    do {
      const body = move ? { ...move, snapshot_id: snapshotId } : { uris: uris.slice(offset, offset + 100) };
      attempted = true;
      const result = await spotifyRequest(replace ? 'PUT' : 'POST', `/playlists/${encodeURIComponent(target.id)}/items`, {}, body);
      if (!result?.snapshot_id) throw new Error('Spotify did not return a version for the submitted batch.');
      offset = move ? uris.length : offset + body.uris.length;
      acknowledged = true;
      snapshotId = result.snapshot_id;
      onProgress?.(offset, uris.length);
      replace = false;
      current = await overwriteHeader(target.id, userId);
      checkPlaylistVersion(current.snapshotId, snapshotId);
    } while (offset < uris.length);
    return current;
  } catch (error) {
    let message = overwriteError(error);
    if (acknowledged) message += ` Spotify last confirmed ${offset.toLocaleString()} of ${uris.length.toLocaleString()} entries.`;
    if (attempted) message += ' Recheck the playlist to see what Spotify applied.';
    const failure = new Error(message);
    failure.playlistMayHaveChanged = attempted || error.playlistChanged === true;
    throw failure;
  }
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
      durationMs: track.duration_ms ?? null,
      durationSeconds: Number.isFinite(track.duration_ms) ? track.duration_ms / 1000 : null,
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
  const sizeError = playlistSizeError(payload.trackUris?.length);
  if (sizeError) throw new Error(sizeError);
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

      // Replacing can recover the first write to a new playlist. Later chunks must append.
      if (chunkIndex === 0 && attemptIndex === 0 && isForbidden) {
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
