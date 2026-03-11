(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PlaylistAnalysis = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_WEIGHTS = {
    bpm: 0.26,
    harmonic: 0.22,
    energy: 0.14,
    danceability: 0.07,
    valence: 0.04,
    loudness: 0.08,
    instrumentalness: 0.02,
    acousticness: 0.02,
    speechiness: 0.02,
    liveness: 0.01,
    genre: 0.1,
  };

  const MIX_MODES = {
    'smooth-harmonic': {
      bpm: 0.28,
      harmonic: 0.24,
      energy: 0.14,
      genre: 0.1,
      loudness: 0.08,
      danceability: 0.07,
      valence: 0.04,
      instrumentalness: 0.02,
      acousticness: 0.01,
      speechiness: 0.01,
      liveness: 0.01,
    },
    'club-beat-driven': {
      bpm: 0.24,
      harmonic: 0.18,
      energy: 0.16,
      genre: 0.12,
      loudness: 0.08,
      danceability: 0.08,
      valence: 0.05,
      instrumentalness: 0.03,
      acousticness: 0.02,
      speechiness: 0.02,
      liveness: 0.02,
    },
    'quick-transition': {
      bpm: 0.3,
      harmonic: 0.15,
      energy: 0.18,
      genre: 0.08,
      loudness: 0.1,
      danceability: 0.08,
      valence: 0.04,
      instrumentalness: 0.02,
      acousticness: 0.02,
      speechiness: 0.02,
      liveness: 0.01,
    },
    generic: {
      bpm: 0.26,
      harmonic: 0.22,
      energy: 0.14,
      genre: 0.1,
      loudness: 0.08,
      danceability: 0.07,
      valence: 0.04,
      speechiness: 0.02,
      instrumentalness: 0.02,
      acousticness: 0.02,
      liveness: 0.01,
    },
  };

  const ARTIST_SPACING_PROFILES = {
    'smooth-harmonic': { lookback: 5, noOverlapBonus: 0.03, oneOverlapPenalty: -0.15, multiOverlapPenalty: -0.2 },
    'club-beat-driven': { lookback: 5, noOverlapBonus: 0.05, oneOverlapPenalty: -0.22, multiOverlapPenalty: -0.28 },
    'quick-transition': { lookback: 4, noOverlapBonus: 0.02, oneOverlapPenalty: -0.1, multiOverlapPenalty: -0.18 },
    generic: { lookback: 5, noOverlapBonus: 0.08, oneOverlapPenalty: -0.08, multiOverlapPenalty: -0.18 },
  };

  const DEFAULT_ARTIST_AVOIDANCE = {
    enabled: true,
    strength: 1,
  };

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function normalizeName(text) {
    return (text || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeBaseName(text) {
    return normalizeName(text)
      .replace(/\b(remix|mix|edit|version|live|remaster(ed)?|radio|extended)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(text) {
    return normalizeBaseName(text)
      .split(' ')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function jaccardSimilarity(aTokens, bTokens) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (!a.size && !b.size) return 1;
    const intersection = [...a].filter((token) => b.has(token)).length;
    const union = new Set([...a, ...b]).size;
    return union ? intersection / union : 0;
  }

  function duplicatePairScore(a, b) {
    const titleSimilarity = jaccardSimilarity(tokenize(a.title), tokenize(b.title));
    const durationA = Number(a.durationSeconds);
    const durationB = Number(b.durationSeconds);
    const durationDiff = Number.isFinite(durationA) && Number.isFinite(durationB)
      ? Math.abs(durationA - durationB)
      : null;
    const durationSimilarity = durationDiff === null ? 0.4 : clamp01(1 - durationDiff / 30);
    const sameIsrc = Boolean(a.isrc && b.isrc && a.isrc === b.isrc) ? 1 : 0;
    const popularityDiff = Math.abs(Number(a.popularity || 0) - Number(b.popularity || 0));
    const popularitySimilarity = clamp01(1 - popularityDiff / 100);

    const score =
      titleSimilarity * 0.5 +
      durationSimilarity * 0.25 +
      sameIsrc * 0.2 +
      popularitySimilarity * 0.05;

    return Number((score * 100).toFixed(1));
  }

  function rankDuplicateCandidate(track) {
    const popularity = Number(track.popularity || 0) / 100;
    const hasIsrc = track.isrc ? 1 : 0;
    return Number((popularity * 0.8 + hasIsrc * 0.2).toFixed(4));
  }

  function findDuplicates(tracks) {
    const exactMap = new Map();
    const nearMap = new Map();

    tracks.forEach((track, index) => {
      const primaryArtist = (track.primaryArtist || track.artistDisplay || '').toLowerCase();
      const exactKey = `${normalizeName(track.title)}__${primaryArtist}`;
      const baseKey = `${normalizeBaseName(track.title)}__${primaryArtist}`;

      if (!exactMap.has(exactKey)) exactMap.set(exactKey, []);
      exactMap.get(exactKey).push({ index, track, keepScore: rankDuplicateCandidate(track) });

      if (!nearMap.has(baseKey)) nearMap.set(baseKey, []);
      nearMap.get(baseKey).push({ index, track, keepScore: rankDuplicateCandidate(track) });
    });

    const exactGroups = Array.from(exactMap.values())
      .filter((items) => items.length > 1)
      .map((group) => {
        const sorted = [...group].sort((a, b) => b.keepScore - a.keepScore);
        const anchor = sorted[0]?.track;
        return sorted.map((entry) => ({
          ...entry,
          pairScore: anchor ? duplicatePairScore(anchor, entry.track) : 100,
        }));
      });
    const nearGroups = Array.from(nearMap.values())
      .filter((items) => items.length > 1)
      .filter((items) => {
        const uniqueNames = new Set(items.map((item) => normalizeName(item.track.title)));
        return uniqueNames.size > 1;
      })
      .map((group) => {
        const sorted = [...group].sort((a, b) => b.keepScore - a.keepScore);
        const anchor = sorted[0]?.track;
        return sorted.map((entry) => ({
          ...entry,
          pairScore: anchor ? duplicatePairScore(anchor, entry.track) : 0,
        }));
      });

    const mergeGroups = [
      ...exactGroups.map((group) => ({
        kind: 'exact',
        items: group.map((entry, itemIndex) => ({
          ...entry,
          recommendedKeep: itemIndex === 0,
          removeByDefault: itemIndex !== 0,
        })),
      })),
      ...nearGroups.map((group) => ({
        kind: 'near',
        items: group.map((entry, itemIndex) => ({
          ...entry,
          recommendedKeep: itemIndex === 0,
          removeByDefault: itemIndex !== 0,
        })),
      })),
    ];

    return {
      exactGroups,
      nearGroups,
      mergeGroups,
    };
  }

  function dedupeKeepHighestPopularity(tracks, duplicateGroups) {
    const removeIndices = new Set();

    duplicateGroups.exactGroups.forEach((group) => {
      const sorted = [...group].sort(
        (a, b) => (b.track.popularity || 0) - (a.track.popularity || 0)
      );
      sorted.slice(1).forEach((item) => removeIndices.add(item.index));
    });

    return tracks.filter((_, index) => !removeIndices.has(index));
  }

  function shufflePasses(tracks, passes) {
    const working = [...tracks];
    const totalPasses = Math.max(1, Number(passes || 1));
    for (let pass = 0; pass < totalPasses; pass += 1) {
      for (let index = working.length - 1; index > 0; index -= 1) {
        const target = Math.floor(Math.random() * (index + 1));
        [working[index], working[target]] = [working[target], working[index]];
      }
    }
    return working;
  }

  function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function featureMatch(first, second, maxDiff = 1) {
    const left = toFiniteNumber(first);
    const right = toFiniteNumber(second);
    if (left === null || right === null) return 0.5;
    if (!Number.isFinite(maxDiff) || maxDiff <= 0) return 0.5;
    return clamp01(1 - Math.abs(left - right) / maxDiff);
  }

  function bpmMatch(a, b, maxDiff = 8) {
    return featureMatch(a?.bpm ?? a?.tempo, b?.bpm ?? b?.tempo, maxDiff);
  }

  function loudnessMatch(a, b, maxDiff = 6) {
    return featureMatch(a?.loudness, b?.loudness, maxDiff);
  }

  function getGenreSet(track) {
    if (Array.isArray(track?.genres) && track.genres.length) {
      return new Set(track.genres.map((genre) => String(genre || '').trim().toLowerCase()).filter(Boolean));
    }
    const genreText = String(track?.genreDisplay || '').trim();
    if (!genreText) return new Set();
    return new Set(genreText.split(',').map((genre) => genre.trim().toLowerCase()).filter(Boolean));
  }

  function genreMatch(a, b) {
    const aSet = getGenreSet(a);
    const bSet = getGenreSet(b);
    if (!aSet.size || !bSet.size) return 0.5;
    const intersection = [...aSet].filter((genre) => bSet.has(genre)).length;
    const union = new Set([...aSet, ...bSet]).size;
    return union ? intersection / union : 0.5;
  }

  function harmonicMatch(a, b) {
    const key1 = toFiniteNumber(a?.key);
    const mode1 = toFiniteNumber(a?.mode);
    const key2 = toFiniteNumber(b?.key);
    const mode2 = toFiniteNumber(b?.mode);
    if (key1 === null || mode1 === null || key2 === null || mode2 === null) return 0.5;
    if (key1 === key2 && mode1 === mode2) return 1;
    const step = (key1 - key2 + 12) % 12;
    if ((step === 1 || step === 11) && mode1 === mode2) return 0.85;
    if (key1 === key2 && mode1 !== mode2) return 0.8;
    if ((step === 1 || step === 11) && mode1 !== mode2) return 0.65;
    return 0.2;
  }

  function getArtistSet(track) {
    const artistText = track?.artistDisplay || track?.primaryArtist || '';
    return new Set(
      String(artistText)
        .split(',')
        .map((artist) => artist.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  function getRecentArtists(tracks, lookback) {
    return tracks.slice(-lookback).flatMap((track) => [...getArtistSet(track)]);
  }

  function artistSpacingBonus(candidate, recentTracks, profile) {
    const candidateArtists = getArtistSet(candidate);
    if (!candidateArtists.size) return 0;
    const recentArtists = getRecentArtists(recentTracks, profile.lookback);
    const overlapCount = recentArtists.reduce(
      (sum, artist) => sum + (candidateArtists.has(artist) ? 1 : 0),
      0
    );
    if (overlapCount === 0) return profile.noOverlapBonus;
    if (overlapCount === 1) return profile.oneOverlapPenalty;
    return profile.multiOverlapPenalty;
  }

  function getArtistSpacingProfile(mode, override) {
    const base = ARTIST_SPACING_PROFILES[mode] || ARTIST_SPACING_PROFILES.generic;
    const normalized = {
      ...DEFAULT_ARTIST_AVOIDANCE,
      ...(override || {}),
    };
    if (!normalized.enabled) {
      return {
        ...base,
        noOverlapBonus: 0,
        oneOverlapPenalty: 0,
        multiOverlapPenalty: 0,
      };
    }
    const strength = clamp01(Number(normalized.strength ?? 1));
    return {
      ...base,
      noOverlapBonus: base.noOverlapBonus * strength,
      oneOverlapPenalty: base.oneOverlapPenalty * strength,
      multiOverlapPenalty: base.multiOverlapPenalty * strength,
    };
  }

  function pairwiseTransitionScore(a, b, weights) {
    return (
      (weights.bpm || 0) * bpmMatch(a, b) +
      (weights.harmonic || 0) * harmonicMatch(a, b) +
      (weights.energy || 0) * featureMatch(a?.energy, b?.energy) +
      (weights.genre || 0) * genreMatch(a, b) +
      (weights.loudness || 0) * loudnessMatch(a, b) +
      (weights.danceability || 0) * featureMatch(a?.danceability, b?.danceability) +
      (weights.valence || 0) * featureMatch(a?.valence, b?.valence) +
      (weights.instrumentalness || 0) * featureMatch(a?.instrumentalness, b?.instrumentalness) +
      (weights.acousticness || 0) * featureMatch(a?.acousticness, b?.acousticness) +
      (weights.speechiness || 0) * featureMatch(a?.speechiness, b?.speechiness) +
      (weights.liveness || 0) * featureMatch(a?.liveness, b?.liveness)
    );
  }

  function getModeWeights(mode, userWeights) {
    const migratedWeights = { ...(userWeights || {}) };
    if (migratedWeights.harmonic === undefined && migratedWeights.camelot !== undefined) {
      migratedWeights.harmonic = migratedWeights.camelot;
    }
    const preset = MIX_MODES[mode] || MIX_MODES.generic;
    return { ...DEFAULT_WEIGHTS, ...preset, ...migratedWeights };
  }

  function optimizeMixOrder(tracks, options) {
    if (!tracks.length) return [];
    const normalizedOptions =
      options && (options.mode || options.weights || options.artistAvoidance)
        ? options
        : { mode: 'generic', weights: options || {} };
    const mode = normalizedOptions.mode || 'generic';
    const weights = getModeWeights(mode, normalizedOptions.weights || {});
    const artistSpacing = getArtistSpacingProfile(mode, normalizedOptions.artistAvoidance);

    const available = new Set(tracks.map((_, index) => index));
    const startIndex = 0;

    const order = [startIndex];
    available.delete(startIndex);

    while (available.size) {
      const currentTrack = tracks[order[order.length - 1]];
      let bestIndex = null;
      let bestScore = -Infinity;
      const recentTracks = order.slice(-artistSpacing.lookback).map((index) => tracks[index]);

      for (const candidate of available) {
        const candidateTrack = tracks[candidate];
        const score =
          pairwiseTransitionScore(currentTrack, candidateTrack, weights) +
          artistSpacingBonus(candidateTrack, recentTracks, artistSpacing);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = candidate;
        }
      }

      order.push(bestIndex);
      available.delete(bestIndex);
    }

    let result = order.map((index) => tracks[index]);
    return result;
  }

  function buildGenreClusters(tracks) {
    const map = new Map();
    tracks.forEach((track) => {
      const key = track.genres?.[0] || 'unknown';
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(track);
    });
    return [...map.entries()].map(([genre, items]) => ({ genre, items }));
  }

  function sequenceGenreClusters(tracks, options) {
    const clusters = buildGenreClusters(tracks).sort((a, b) => b.items.length - a.items.length);
    const result = [];
    clusters.forEach((cluster) => {
      const ordered = optimizeMixOrder(cluster.items, options || { mode: 'generic', weights: {} });
      result.push(...ordered);
    });
    return result;
  }

  function computeTransitionDiagnostics(tracks, options) {
    if (!tracks || tracks.length < 2) return [];
    const normalizedOptions =
      options && (options.mode || options.weights || options.artistAvoidance)
        ? options
        : { mode: 'generic', weights: options || {} };
    const weights = getModeWeights(normalizedOptions.mode || 'generic', normalizedOptions.weights || {});
    const artistSpacing = getArtistSpacingProfile(
      normalizedOptions.mode || 'generic',
      normalizedOptions.artistAvoidance
    );
    const diagnostics = [];
    for (let index = 0; index < tracks.length - 1; index += 1) {
      const current = tracks[index];
      const next = tracks[index + 1];
      const recentTracks = tracks.slice(Math.max(0, index - artistSpacing.lookback + 1), index + 1);
      const transitionScore = pairwiseTransitionScore(current, next, weights);
      const spacingBonus = artistSpacingBonus(next, recentTracks, artistSpacing);
      diagnostics.push({
        index,
        fromTitle: current.title,
        toTitle: next.title,
        bpmDelta:
          typeof current.bpm === 'number' && typeof next.bpm === 'number'
            ? Number((next.bpm - current.bpm).toFixed(2))
            : null,
        harmonicScore: Number(harmonicMatch(current, next).toFixed(3)),
        genreScore: Number(genreMatch(current, next).toFixed(3)),
        artistSpacingBonus: Number(spacingBonus.toFixed(3)),
        transitionScore: Number(transitionScore.toFixed(3)),
        score: Number((transitionScore + spacingBonus).toFixed(3)),
      });
    }
    return diagnostics;
  }

  function zScore(values, value) {
    if (!values.length || typeof value !== 'number') return 0;
    const mean = values.reduce((sum, current) => sum + current, 0) / values.length;
    const variance =
      values.reduce((sum, current) => sum + Math.pow(current - mean, 2), 0) / values.length;
    const sd = Math.sqrt(variance) || 1;
    return Math.abs((value - mean) / sd);
  }

  function detectOutliers(tracks) {
    const numericFields = [
      'bpm',
      'energy',
      'danceability',
      'valence',
      'loudness',
      'instrumentalness',
      'acousticness',
      'speechiness',
      'liveness',
    ];

    const fieldValues = {};
    numericFields.forEach((field) => {
      fieldValues[field] = tracks
        .map((track) => track[field])
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
    });

    const genreCounts = new Map();
    tracks.forEach((track) => {
      (track.genres || []).forEach((genre) => {
        const key = genre.toLowerCase();
        genreCounts.set(key, (genreCounts.get(key) || 0) + 1);
      });
    });

    return tracks
      .map((track, index) => {
        const numericOutlier = numericFields.reduce((sum, field) => {
          return sum + Math.min(3, zScore(fieldValues[field], track[field]));
        }, 0);

        let genreRarity = 0;
        (track.genres || []).forEach((genre) => {
          const count = genreCounts.get(genre.toLowerCase()) || 0;
          if (count > 0) genreRarity += 1 / count;
        });

        const score = numericOutlier * 0.7 + genreRarity * 0.3;
        const weighted = {
          audio: numericOutlier * 0.7,
          genre: genreRarity * 0.3,
        };
        let dominant = 'audio';
        if (weighted.genre > weighted[dominant]) dominant = 'genre';

        let strongestReason =
          'Energy, BPM, loudness, and mood traits are farther from the playlist average than most tracks.';
        if (dominant === 'genre') {
          strongestReason = 'Genre tags are rare compared with the rest of the playlist.';
        }

        const reasons = [];
        if (genreRarity > 0.75) reasons.push('Genre profile is uncommon in this playlist.');
        if (numericOutlier > numericFields.length * 0.25)
          reasons.push('Audio profile (energy/tempo/mood) is far from playlist average.');

        if (!reasons.length) {
          reasons.push(strongestReason);
        }

        return {
          index,
          track,
          outlierScore: Number(score.toFixed(3)),
          reasons,
          strongestReason,
        };
      })
      .sort((a, b) => b.outlierScore - a.outlierScore);
  }

  function toComparable(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (Array.isArray(value)) return value.join(', ').toLowerCase();
    const maybeDate = Date.parse(value);
    if (!Number.isNaN(maybeDate) && String(value).includes('-')) return maybeDate;
    return String(value).toLowerCase();
  }

  function sortTracks(tracks, field, direction) {
    const dir = direction === 'desc' ? -1 : 1;
    return [...tracks].sort((a, b) => {
      const va = toComparable(a[field]);
      const vb = toComparable(b[field]);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function applyFilters(tracks, filters) {
    return tracks.filter((track) => {
      for (const filter of filters || []) {
        if (!filter.field) continue;
        const value = track[filter.field];
        let passed = true;

        if (filter.kind === 'range') {
          passed = true;
          if (typeof value !== 'number') {
            passed = false;
          } else {
            if (filter.min !== '' && value < Number(filter.min)) passed = false;
            if (filter.max !== '' && value > Number(filter.max)) passed = false;
          }
        }
        if (filter.kind === 'contains') {
          const stringValue = Array.isArray(value)
            ? value.join(', ').toLowerCase()
            : String(value || '').toLowerCase();
          passed = stringValue.includes(String(filter.query || '').toLowerCase());
        }
        if (filter.kind === 'set') {
          const selected = new Set((filter.values || []).map((item) => String(item).toLowerCase()));
          if (!selected.size) {
            passed = true;
          } else {
            passed = selected.has(String(value ?? '').toLowerCase());
          }
        }

        if (filter.negate) {
          passed = !passed;
        }
        if (!passed) {
          return false;
        }
      }
      return true;
    });
  }

  return {
    DEFAULT_WEIGHTS,
    MIX_MODES,
    findDuplicates,
    duplicatePairScore,
    dedupeKeepHighestPopularity,
    shufflePasses,
    optimizeMixOrder,
    sequenceGenreClusters,
    computeTransitionDiagnostics,
    detectOutliers,
    sortTracks,
    applyFilters,
    getModeWeights,
  };
});
