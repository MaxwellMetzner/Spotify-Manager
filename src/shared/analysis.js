(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PlaylistAnalysis = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_WEIGHTS = {
    bpm: 0.24,
    camelot: 0.24,
    energy: 0.12,
    danceability: 0.1,
    valence: 0.07,
    loudness: 0.06,
    instrumentalness: 0.05,
    acousticness: 0.04,
    speechiness: 0.03,
    liveness: 0.02,
    genre: 0.03,
  };

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
      .replace(/\b(remix|mix|edit|version|live|remaster(ed)?)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findDuplicates(tracks) {
    const exactMap = new Map();
    const nearMap = new Map();

    tracks.forEach((track, index) => {
      const primaryArtist = (track.primaryArtist || track.artistDisplay || '').toLowerCase();
      const exactKey = `${normalizeName(track.title)}__${primaryArtist}`;
      const baseKey = `${normalizeBaseName(track.title)}__${primaryArtist}`;

      if (!exactMap.has(exactKey)) exactMap.set(exactKey, []);
      exactMap.get(exactKey).push({ index, track });

      if (!nearMap.has(baseKey)) nearMap.set(baseKey, []);
      nearMap.get(baseKey).push({ index, track });
    });

    const exactGroups = Array.from(exactMap.values()).filter((items) => items.length > 1);
    const nearGroups = Array.from(nearMap.values())
      .filter((items) => items.length > 1)
      .filter((items) => {
        const uniqueNames = new Set(items.map((item) => normalizeName(item.track.title)));
        return uniqueNames.size > 1;
      });

    return {
      exactGroups,
      nearGroups,
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

  function parseCamelot(camelot) {
    if (!camelot || typeof camelot !== 'string') return null;
    const clean = camelot.trim().toUpperCase();
    const num = Number(clean.slice(0, -1));
    const letter = clean.slice(-1);
    if (!Number.isFinite(num) || num < 1 || num > 12 || !['A', 'B'].includes(letter)) return null;
    return { number: num, mode: letter };
  }

  function camelotDistance(a, b) {
    const first = parseCamelot(a);
    const second = parseCamelot(b);
    if (!first || !second) return 0.5;
    const step = Math.min(
      (first.number - second.number + 12) % 12,
      (second.number - first.number + 12) % 12
    );
    const wheelPenalty = step / 6;
    const modePenalty = first.mode === second.mode ? 0 : step <= 1 ? 0.08 : 0.2;
    return Math.min(1, wheelPenalty + modePenalty);
  }

  function normalizeFeature(tracks, field) {
    const values = tracks
      .map((track) => track[field])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (!values.length) return { min: 0, max: 1 };
    return { min: Math.min(...values), max: Math.max(...values) };
  }

  function distanceForField(a, b, stats, field) {
    const first = a[field];
    const second = b[field];
    if (typeof first !== 'number' || typeof second !== 'number') return 0.5;
    const { min, max } = stats[field];
    if (max === min) return 0;
    return Math.abs((first - min) / (max - min) - (second - min) / (max - min));
  }

  function genreDistance(a, b) {
    const aSet = new Set((a.genres || []).map((g) => g.toLowerCase()));
    const bSet = new Set((b.genres || []).map((g) => g.toLowerCase()));
    if (!aSet.size && !bSet.size) return 0.5;
    if (!aSet.size || !bSet.size) return 0.7;
    const intersection = [...aSet].filter((genre) => bSet.has(genre)).length;
    const union = new Set([...aSet, ...bSet]).size;
    return 1 - intersection / union;
  }

  function transitionCost(a, b, stats, weights) {
    return (
      (weights.bpm || 0) * distanceForField(a, b, stats, 'bpm') +
      (weights.camelot || 0) * camelotDistance(a.camelot, b.camelot) +
      (weights.energy || 0) * distanceForField(a, b, stats, 'energy') +
      (weights.danceability || 0) * distanceForField(a, b, stats, 'danceability') +
      (weights.valence || 0) * distanceForField(a, b, stats, 'valence') +
      (weights.loudness || 0) * distanceForField(a, b, stats, 'loudness') +
      (weights.instrumentalness || 0) * distanceForField(a, b, stats, 'instrumentalness') +
      (weights.acousticness || 0) * distanceForField(a, b, stats, 'acousticness') +
      (weights.speechiness || 0) * distanceForField(a, b, stats, 'speechiness') +
      (weights.liveness || 0) * distanceForField(a, b, stats, 'liveness') +
      (weights.genre || 0) * genreDistance(a, b)
    );
  }

  function computeTrackStats(tracks) {
    return {
      bpm: normalizeFeature(tracks, 'bpm'),
      energy: normalizeFeature(tracks, 'energy'),
      danceability: normalizeFeature(tracks, 'danceability'),
      valence: normalizeFeature(tracks, 'valence'),
      loudness: normalizeFeature(tracks, 'loudness'),
      instrumentalness: normalizeFeature(tracks, 'instrumentalness'),
      acousticness: normalizeFeature(tracks, 'acousticness'),
      speechiness: normalizeFeature(tracks, 'speechiness'),
      liveness: normalizeFeature(tracks, 'liveness'),
    };
  }

  function optimizeMixOrder(tracks, userWeights) {
    if (!tracks.length) return [];
    const weights = { ...DEFAULT_WEIGHTS, ...(userWeights || {}) };
    const stats = computeTrackStats(tracks);

    const available = new Set(tracks.map((_, index) => index));
    const startIndex = tracks.reduce((best, track, index) => {
      const bestScore = (tracks[best].energy || 0) + (tracks[best].popularity || 0) / 100;
      const score = (track.energy || 0) + (track.popularity || 0) / 100;
      return score > bestScore ? index : best;
    }, 0);

    const order = [startIndex];
    available.delete(startIndex);

    while (available.size) {
      const currentTrack = tracks[order[order.length - 1]];
      let bestIndex = null;
      let bestDistance = Infinity;

      for (const candidate of available) {
        const candidateTrack = tracks[candidate];
        const cost = transitionCost(currentTrack, candidateTrack, stats, weights);
        if (cost < bestDistance) {
          bestDistance = cost;
          bestIndex = candidate;
        }
      }

      order.push(bestIndex);
      available.delete(bestIndex);
    }

    return order.map((index) => tracks[index]);
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

    const years = tracks
      .map((track) => track.albumReleaseYear)
      .filter((year) => Number.isFinite(year));

    const genreCounts = new Map();
    tracks.forEach((track) => {
      (track.genres || []).forEach((genre) => {
        const key = genre.toLowerCase();
        genreCounts.set(key, (genreCounts.get(key) || 0) + 1);
      });
    });

    return tracks
      .map((track) => {
        const numericOutlier = numericFields.reduce((sum, field) => {
          return sum + Math.min(3, zScore(fieldValues[field], track[field]));
        }, 0);

        let genreRarity = 0;
        (track.genres || []).forEach((genre) => {
          const count = genreCounts.get(genre.toLowerCase()) || 0;
          if (count > 0) genreRarity += 1 / count;
        });

        const eraOutlier = Number.isFinite(track.albumReleaseYear)
          ? Math.min(3, zScore(years, track.albumReleaseYear))
          : 0;

        const score = numericOutlier * 0.55 + genreRarity * 0.25 + eraOutlier * 0.2;
        const reasons = [];
        if (eraOutlier > 1.5) reasons.push('Release year differs strongly from playlist core era.');
        if (genreRarity > 0.75) reasons.push('Genre profile is uncommon in this playlist.');
        if (numericOutlier > numericFields.length * 0.25)
          reasons.push('Audio profile (energy/tempo/mood) is far from playlist average.');

        return {
          track,
          outlierScore: Number(score.toFixed(3)),
          reasons,
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

  function sortTracks(tracks, field, direction = 'asc') {
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
        if (filter.kind === 'range') {
          if (typeof value !== 'number') return false;
          if (filter.min !== '' && value < Number(filter.min)) return false;
          if (filter.max !== '' && value > Number(filter.max)) return false;
        }
        if (filter.kind === 'yearRange') {
          const year = track.albumReleaseYear;
          if (!Number.isFinite(year)) return false;
          if (filter.min !== '' && year < Number(filter.min)) return false;
          if (filter.max !== '' && year > Number(filter.max)) return false;
        }
        if (filter.kind === 'contains') {
          const stringValue = Array.isArray(value)
            ? value.join(', ').toLowerCase()
            : String(value || '').toLowerCase();
          if (!stringValue.includes(String(filter.query || '').toLowerCase())) return false;
        }
      }
      return true;
    });
  }

  return {
    DEFAULT_WEIGHTS,
    findDuplicates,
    dedupeKeepHighestPopularity,
    shufflePasses,
    optimizeMixOrder,
    detectOutliers,
    sortTracks,
    applyFilters,
  };
});
