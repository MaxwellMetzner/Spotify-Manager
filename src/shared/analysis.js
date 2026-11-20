(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PlaylistAnalysis = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_WEIGHTS = {
    bpm: 0.68, harmonic: 0.10, loudness: 0.06, instrumentalness: 0.05,
    acousticness: 0.04, speechiness: 0.04, energy: 0.02, danceability: 0.01,
    valence: 0, liveness: 0, genre: 0,
  };

  const MIX_MODES = {
    'club-beat-driven': DEFAULT_WEIGHTS,
    'smooth-harmonic': {
      ...DEFAULT_WEIGHTS, bpm: 0.48, harmonic: 0.30, loudness: 0.07,
      instrumentalness: 0.05, acousticness: 0.04, speechiness: 0.04, energy: 0.02, danceability: 0,
    },
    'acoustic-flow': {
      ...DEFAULT_WEIGHTS, bpm: 0.42, harmonic: 0.08, loudness: 0.10,
      acousticness: 0.15, instrumentalness: 0.13, speechiness: 0.10, energy: 0.02, danceability: 0,
    },
  };

  // Scales keep small changes in tightly clustered playlists from looking exceptional.
  const OUTLIER_FIELDS = {
    bpm: ['Tempo', 4], loudness: ['Loudness', 1.8],
    acousticness: ['Acousticness', 0.09], instrumentalness: ['Instrumentalness', 0.10],
    speechiness: ['Speechiness', 0.06], energy: ['Energy', 0.12],
    danceability: ['Danceability', 0.12], valence: ['Valence', 0.15], liveness: ['Liveness', 0.13],
  };
  const MIN_OUTLIER_SAMPLE = 6;
  const WEIGHT_FIELDS = Object.keys(DEFAULT_WEIGHTS);
  const measuredFields = Object.keys(OUTLIER_FIELDS);

  function resolveMode(mode) {
    if (mode === 'quick-transition' || mode === 'generic') return 'club-beat-driven';
    return Object.hasOwn(MIX_MODES, mode) ? mode : 'club-beat-driven';
  }

  // Largest remainders keep whole percentages exact, including old fractional presets.
  function weightPercentages(weights = {}, fixedField = null, fixedPercent = 0, fallback = DEFAULT_WEIGHTS) {
    const keys = WEIGHT_FIELDS.filter((key) => key !== fixedField);
    const fixed = Math.max(0, Math.min(100, Math.round(fixedPercent) || 0));
    const budget = fixedField ? 100 - fixed : 100;
    const clean = (key, source) => Math.max(0, Number(source[key] ?? (key === 'harmonic' ? source.camelot : 0)) || 0);
    let values = keys.map((key) => clean(key, weights));
    if (!values.some(Boolean)) values = keys.map((key) => clean(key, fallback));
    if (!values.some(Boolean)) values.fill(1);
    const sum = values.reduce((a, b) => a + b, 0);
    const shares = values.map((value) => value * budget / sum);
    const rounded = shares.map(Math.floor);
    const remainder = budget - rounded.reduce((a, b) => a + b, 0);
    const ranked = keys.map((_, i) => i).sort((a, b) => (shares[b] - rounded[b]) - (shares[a] - rounded[a]));
    ranked.slice(0, remainder).forEach((i) => { rounded[i] += 1; });
    const result = Object.fromEntries(keys.map((key, i) => [key, rounded[i]]));
    if (fixedField) result[fixedField] = fixed;
    return result;
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function normalizeName(text) {
    return String(text || '').normalize('NFKC')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
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
    const durationA = a.durationSeconds;
    const durationB = b.durationSeconds;
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
      const title = normalizeName(track.title);
      const exactKey = title && primaryArtist ? `${title}__${primaryArtist}` : track.uri;
      if (!exactKey) return;
      const entry = { index, track, keepScore: rankDuplicateCandidate(track) };

      if (!exactMap.has(exactKey)) exactMap.set(exactKey, []);
      exactMap.get(exactKey).push(entry);

      const baseTitle = normalizeBaseName(track.title);
      if (!baseTitle || !primaryArtist) return;
      const baseKey = `${baseTitle}__${primaryArtist}`;
      if (!nearMap.has(baseKey)) nearMap.set(baseKey, []);
      nearMap.get(baseKey).push(entry);
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

  function featureValue(track, field) {
    const value = field === 'bpm' ? track.bpm ?? track.tempo : track[field];
    if (!Number.isFinite(value)) return null;
    if (field === 'bpm') return value > 0 ? value : null;
    if (field === 'loudness') return value;
    return value >= 0 && value <= 1 ? value : null;
  }

  function tonalKey(track) {
    const { key, mode } = track;
    if (!Number.isInteger(key) || key < 0 || key > 11 || (mode !== 0 && mode !== 1)) return null;
    // Map minor keys to their relative major before measuring distance in fifths.
    return ((key + (mode === 0 ? 3 : 0)) * 7) % 12;
  }

  function prepareTrack(track) {
    const profile = {};
    for (const field of measuredFields) profile[field] = featureValue(track, field);
    profile.harmonic = tonalKey(track);
    const genres = track.genres || String(track.genreDisplay || '').split(',');
    profile.genre = new Set(genres.map((g) => g.trim().toLowerCase()).filter(Boolean));
    const artists = track.artists?.length ? track.artists : String(track.artistDisplay || track.primaryArtist || '').split(/[;,]/);
    profile.artists = artists.map((artist) => artist.trim().toLowerCase()).filter(Boolean);
    return profile;
  }

  function hasFactor(profile, key) {
    return key === 'genre' ? profile.genre.size > 0 : profile[key] !== null;
  }

  function comparableFactors(tracks) {
    const counts = Object.fromEntries(WEIGHT_FIELDS.map((key) => [key, 0]));
    for (const track of tracks) {
      const profile = prepareTrack(track);
      for (const key of WEIGHT_FIELDS) if (hasFactor(profile, key)) counts[key]++;
    }
    return counts;
  }

  function getAudioCoverage(tracks) {
    let audio = 0, tempo = 0, genres = 0;
    for (const track of tracks) {
      if (featureValue(track, 'bpm') !== null) tempo++;
      if (tonalKey(track) !== null || measuredFields.some((key) => featureValue(track, key) !== null)) audio++;
      if (track.genres?.length || track.genreDisplay) genres++;
    }
    return { audio, tempo, genres };
  }

  function featureFit(a, b, key) {
    const x = a[key], y = b[key];
    if (x === null || y === null) return null;
    if (key === 'bpm') {
      const ratio = Math.max(x, y) / Math.min(x, y);
      const direct = 1 - (ratio - 1) / 0.14;
      const halfTime = 0.86 - Math.abs(ratio / 2 - 1) / 0.10;
      return clamp01(Math.max(direct, halfTime));
    }
    if (key === 'harmonic') {
      const steps = Math.abs(x - y);
      return [1, 0.85, 0.55, 0.35, 0.22, 0.15, 0.10][Math.min(steps, 12 - steps)];
    }
    if (key === 'genre') {
      if (!x.size || !y.size) return null;
      let shared = 0;
      for (const tag of x) if (y.has(tag)) shared++;
      return shared / (x.size + y.size - shared);
    }
    return clamp01(1 - Math.abs(x - y) / (key === 'loudness' ? 9 : 1));
  }

  function getModeWeights(mode, overrides = {}) {
    const preset = MIX_MODES[resolveMode(mode)];
    const merged = { ...preset, ...overrides };
    if (overrides.camelot !== undefined && overrides.harmonic === undefined) merged.harmonic = overrides.camelot;
    const percentages = weightPercentages(merged, null, 0, preset);
    return Object.fromEntries(Object.entries(percentages).map(([key, value]) => [key, value / 100]));
  }

  function mixSettings(options = {}) {
    const weights = getModeWeights(options.mode, options.weights || (options.mode ? {} : options));
    const factors = Object.entries(weights).filter(([, weight]) => weight > 0);
    const spacing = options.artistAvoidance?.enabled === false ? 0 : clamp01(options.artistAvoidance?.strength ?? 0.35);
    return { factors, spacing };
  }

  function pairFit(first, second, factors) {
    let total = 0, coverage = 0;
    for (const [field, weight] of factors) {
      const fit = featureFit(first, second, field);
      if (fit === null) continue;
      total += fit * weight;
      coverage += weight;
    }
    return { fit: coverage ? total / coverage : null, coverage };
  }

  function recentArtists(profiles) {
    return new Set(profiles.flatMap((profile) => profile.artists));
  }

  function artistPenalty(track, recent, strength) {
    return track.artists.some((artist) => recent.has(artist)) ? -0.10 * strength : 0;
  }

  // Large lists inspect a moving neighborhood on the highest-weight dimension.
  // Removing from both sorted neighbor lists is constant-time and preserves deterministic ties.
  function candidateWindow(profiles, field) {
    const value = (i) => field === 'genre' ? [...profiles[i].genre][0] || '' : profiles[i][field] ?? Infinity;
    const sorted = profiles.map((_, i) => i).sort((a, b) => {
      const x = value(a), y = value(b);
      return x < y ? -1 : x > y ? 1 : a - b;
    });
    const prev = new Int32Array(sorted.length), next = new Int32Array(sorted.length);
    sorted.forEach((id, i) => { prev[id] = sorted[i - 1] ?? -1; next[id] = sorted[i + 1] ?? -1; });
    return (id) => {
      const candidates = [];
      let left = prev[id], right = next[id];
      if (left >= 0) next[left] = right;
      if (right >= 0) prev[right] = left;
      while (candidates.length < 80 && (left >= 0 || right >= 0)) {
        if (left >= 0) { candidates.push(left); left = prev[left]; }
        if (right >= 0) { candidates.push(right); right = next[right]; }
      }
      return candidates;
    };
  }

  function optimizeMixOrder(tracks, options) {
    if (tracks.length < 2) return tracks.slice();
    const { factors, spacing } = mixSettings(options);
    const allProfiles = tracks.map(prepareTrack);
    const counts = Object.fromEntries(factors.map(([key]) => [key, 0]));
    for (const profile of allProfiles) {
      for (const [key] of factors) if (hasFactor(profile, key)) counts[key]++;
    }
    const comparable = factors.filter(([key]) => counts[key] >= 2);
    if (!comparable.length) return tracks.slice();
    const measured = [], profiles = [];
    allProfiles.forEach((profile, index) => {
      if (comparable.some(([key]) => hasFactor(profile, key))) { measured.push(index); profiles.push(profile); }
    });
    const available = new Set(profiles.map((_, i) => i));
    const dominant = [...comparable].sort((a, b) => b[1] - a[1])[0][0];
    const nearby = profiles.length > 384 ? candidateWindow(profiles, dominant) : null;
    const order = [0];
    available.delete(0);
    while (available.size) {
      const current = order[order.length - 1];
      const recent = recentArtists(order.slice(-4).map((i) => profiles[i]));
      let best = -1, high = -Infinity;
      for (const i of nearby ? nearby(current) : available) {
        const { fit, coverage } = pairFit(profiles[current], profiles[i], factors);
        // Weakly evidenced matches should not outrank a well-matched measured pair.
        const score = fit === null ? -1 : fit * coverage + 0.35 * (1 - coverage) + artistPenalty(profiles[i], recent, spacing);
        if (score > high || (score === high && i < best)) { best = i; high = score; }
      }
      order.push(best);
      available.delete(best);
    }
    // Keep tracks without comparable evidence in their original slots.
    const result = tracks.slice();
    measured.forEach((index, i) => { result[index] = tracks[measured[order[i]]]; });
    return result;
  }

  function sequenceGenreClusters(tracks, options) {
    const clusters = new Map();
    for (const track of tracks) {
      const key = track.genres?.[0]?.toLowerCase() || '';
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(track);
    }
    return [...clusters.values()].sort((a, b) => b.length - a.length).flatMap((group) => optimizeMixOrder(group, options));
  }

  function computeTransitionDiagnostics(tracks, options, start = 0, limit = Infinity) {
    const { factors, spacing } = mixSettings(options);
    const end = Math.min(tracks.length - 1, start + limit);
    if (start >= end) return [];
    const offset = Math.max(0, start - 3);
    const profiles = tracks.slice(offset, end + 1).map(prepareTrack);
    const result = [];
    for (let i = start; i < end; i++) {
      const at = i - offset, a = profiles[at], b = profiles[at + 1];
      const { fit, coverage } = pairFit(a, b, factors);
      const penalty = artistPenalty(b, recentArtists(profiles.slice(Math.max(0, at - 3), at + 1)), spacing);
      const score = fit === null ? null : clamp01(fit + penalty);
      result.push({
        index: i, fromTitle: tracks[i].title, toTitle: tracks[i + 1].title,
        bpmDelta: a.bpm !== null && b.bpm !== null ? b.bpm - a.bpm : null,
        halfTime: a.bpm !== null && b.bpm !== null && Math.abs(Math.max(a.bpm, b.bpm) / Math.min(a.bpm, b.bpm) / 2 - 1) < 0.08,
        harmonicScore: featureFit(a, b, 'harmonic'), genreScore: featureFit(a, b, 'genre'),
        artistSpacingBonus: penalty, transitionScore: fit, score, coverage,
        quality: coverage < 0.40 ? 'limited' : score >= 0.80 ? 'smooth' : score >= 0.55 ? 'moderate' : 'rough',
      });
    }
    return result;
  }

  function quantile(sorted, fraction) {
    const position = (sorted.length - 1) * fraction, low = Math.floor(position);
    return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
  }

  function displayMetric(field, value) {
    if (field === 'bpm') return `${Number(value.toFixed(1))} BPM`;
    if (field === 'loudness') return `${Number(value.toFixed(1))} dB`;
    return `${Math.round(value * 100)}%`;
  }

  function analyzeOutliers(tracks) {
    const baselines = [];
    for (const [field, [label, floor]] of Object.entries(OUTLIER_FIELDS)) {
      const values = tracks.map((track) => featureValue(track, field)).filter((v) => v !== null).sort((a, b) => a - b);
      if (values.length < MIN_OUTLIER_SAMPLE) continue;
      const center = quantile(values, 0.5);
      const mad = quantile(values.map((v) => Math.abs(v - center)).sort((a, b) => a - b), 0.5);
      const iqr = quantile(values, 0.75) - quantile(values, 0.25);
      baselines.push({ field, label, center, scale: Math.max(floor, mad * 1.4826, iqr / 1.349) });
    }
    const genreCounts = new Map();
    let tagged = 0;
    tracks.forEach((track) => {
      const tags = new Set((track.genres || []).map((tag) => tag.toLowerCase()));
      if (tags.size) tagged++;
      for (const tag of tags) genreCounts.set(tag, (genreCounts.get(tag) || 0) + 1);
    });

    const rows = [];
    tracks.forEach((track, index) => {
      const evidence = [];
      for (const { field, label, center, scale } of baselines) {
        const value = featureValue(track, field);
        if (value === null) continue;
        let distance = Math.abs(value - center);
        // Spotify sometimes measures the same pulse at half or double time.
        if (field === 'bpm') distance = Math.min(distance, Math.abs(value * 2 - center), Math.abs(value / 2 - center));
        const deviation = distance / scale;
        if (deviation < 2.5) continue;
        const reason = `${label} is ${displayMetric(field, value)}, ${value > center ? 'above' : 'below'} the playlist median of ${displayMetric(field, center)}.`;
        evidence.push({ field, deviation, reason });
      }
      evidence.sort((a, b) => b.deviation - a.deviation);
      const strong = evidence.some((item) => item.deviation >= 3.5 && !['energy', 'danceability', 'valence', 'liveness'].includes(item.field));
      if (!strong && evidence.length < 2) return;
      const reasons = evidence.slice(0, 3).map((item) => item.reason);
      const rare = (track.genres || []).find((g) => tagged >= 8 && genreCounts.get(g.toLowerCase()) / tagged <= 0.1);
      if (rare) reasons.push(`“${rare}” appears on ${genreCounts.get(rare.toLowerCase())} of ${tagged} tagged tracks.`);
      rows.push({ index, track, outlierScore: evidence[0].deviation + 0.35 * (evidence[1]?.deviation || 0), strongestReason: reasons[0], reasons });
    });
    return { rows: rows.sort((a, b) => b.outlierScore - a.outlierScore), fieldsCompared: baselines.length, minimum: MIN_OUTLIER_SAMPLE };
  }

  function detectOutliers(tracks) {
    return analyzeOutliers(tracks).rows;
  }

  function canAssessOutliers(tracks) {
    if (tracks.length < MIN_OUTLIER_SAMPLE) return false;
    for (const field of measuredFields) {
      let count = 0;
      for (const track of tracks) {
        if (featureValue(track, field) !== null) count++;
        if (count === MIN_OUTLIER_SAMPLE) return true;
      }
    }
    return false;
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
    getModeWeights, resolveMode, weightPercentages, getAudioCoverage, comparableFactors, analyzeOutliers, canAssessOutliers,
  };
});
