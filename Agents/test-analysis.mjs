import test from 'node:test';
import assert from 'node:assert/strict';
import analysis from '../src/shared/analysis.js';

function makeTrack(overrides = {}) {
  return {
    title: 'Song',
    artistDisplay: 'Artist',
    primaryArtist: 'Artist',
    albumName: 'Album',
    popularity: 50,
    bpm: 120,
    key: 9,
    mode: 0,
    energy: 0.5,
    danceability: 0.5,
    valence: 0.5,
    loudness: -8,
    instrumentalness: 0.1,
    acousticness: 0.2,
    speechiness: 0.05,
    liveness: 0.1,
    genres: ['dance pop'],
    genreDisplay: 'dance pop',
    uri: 'spotify:track:abc',
    ...overrides,
  };
}

test('findDuplicates identifies exact and near duplicate groups', () => {
  const tracks = [
    makeTrack({ title: 'Example Song', popularity: 10 }),
    makeTrack({ title: 'Example Song', popularity: 90 }),
    makeTrack({ title: 'Example Song - Remix' }),
  ];

  const report = analysis.findDuplicates(tracks);
  assert.equal(report.exactGroups.length, 1);
  assert.equal(report.nearGroups.length, 1);
  assert.equal(report.mergeGroups.length, 2);
  assert.equal(report.mergeGroups[0].items[0].recommendedKeep, true);
  assert.equal(report.mergeGroups[0].items[1].removeByDefault, true);

  const deduped = analysis.dedupeKeepHighestPopularity(tracks, report);
  assert.equal(deduped.length, 2);
  assert.equal(deduped.some((track) => track.popularity === 90), true);
});

test('shufflePasses retains members and length', () => {
  const tracks = [
    makeTrack({ title: 'A' }),
    makeTrack({ title: 'B' }),
    makeTrack({ title: 'C' }),
    makeTrack({ title: 'D' }),
  ];

  const shuffled = analysis.shufflePasses(tracks, 3);
  assert.equal(shuffled.length, tracks.length);
  assert.deepEqual(
    [...shuffled.map((item) => item.title)].sort(),
    [...tracks.map((item) => item.title)].sort()
  );
});

test('optimizeMixOrder returns same set of tracks', () => {
  const tracks = [
    makeTrack({ title: 'A', bpm: 110, key: 2, mode: 0 }),
    makeTrack({ title: 'B', bpm: 112, key: 3, mode: 0 }),
    makeTrack({ title: 'C', bpm: 130, key: 9, mode: 1 }),
    makeTrack({ title: 'D', bpm: 129, key: 10, mode: 1 }),
  ];

  const ordered = analysis.optimizeMixOrder(tracks);
  assert.equal(ordered.length, tracks.length);
  assert.deepEqual(
    [...ordered.map((item) => item.title)].sort(),
    [...tracks.map((item) => item.title)].sort()
  );
});

test('applyFilters supports contains, ranges, and year filters', () => {
  const tracks = [
    makeTrack({ title: 'Summer Heat', bpm: 100, energy: 0.4 }),
    makeTrack({ title: 'Winter Chill', bpm: 128, energy: 0.8 }),
  ];

  const filtered = analysis.applyFilters(tracks, [
    { field: 'title', kind: 'contains', query: 'summer' },
    { field: 'bpm', kind: 'range', min: 95, max: 105 },
    { field: 'energy', kind: 'range', min: 0.3, max: 0.5 },
  ]);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, 'Summer Heat');
});

test('applyFilters supports set and negate qualifiers', () => {
  const tracks = [
    makeTrack({ title: 'Set A', keyModeLabel: '9 minor', timeSignature: 4 }),
    makeTrack({ title: 'Set B', keyModeLabel: '10 minor', timeSignature: 3 }),
    makeTrack({ title: 'Set C', keyModeLabel: '9 major', timeSignature: 4 }),
  ];

  const filtered = analysis.applyFilters(tracks, [
    { field: 'keyModeLabel', kind: 'set', values: ['9 minor', '9 major'] },
    { field: 'timeSignature', kind: 'set', values: ['4'], negate: true },
  ]);

  assert.equal(filtered.length, 0);
});

test('detectOutliers ranks unusual item higher', () => {
  const normal = Array.from({ length: 8 }).map((_, index) =>
    makeTrack({
      title: `Normal ${index}`,
      bpm: 118 + index,
      energy: 0.55,
      genres: ['dance pop'],
    })
  );

  const outlier = makeTrack({
    title: 'Old Slow Jazz',
    bpm: 72,
    energy: 0.12,
    albumReleaseYear: 1992,
    genres: ['bebop'],
  });

  const ranked = analysis.detectOutliers([...normal, outlier]);
  assert.equal(ranked[0].track.title, 'Old Slow Jazz');
  assert.equal(typeof ranked[0].outlierScore, 'number');
});

test('duplicatePairScore rewards closer duplicate candidates', () => {
  const original = makeTrack({
    title: 'Example Song',
    durationSeconds: 180,
    isrc: 'USABC123',
    popularity: 70,
  });
  const close = makeTrack({
    title: 'Example Song (Remix)',
    durationSeconds: 182,
    isrc: 'USABC123',
    popularity: 68,
  });
  const far = makeTrack({
    title: 'Totally Different',
    durationSeconds: 260,
    isrc: 'ZZZZ9999',
    popularity: 10,
  });

  const closeScore = analysis.duplicatePairScore(original, close);
  const farScore = analysis.duplicatePairScore(original, far);
  assert.equal(closeScore > farScore, true);
});

test('sequenceGenreClusters preserves track set', () => {
  const tracks = [
    makeTrack({ title: 'House 1', genres: ['house'], bpm: 124 }),
    makeTrack({ title: 'House 2', genres: ['house'], bpm: 126 }),
    makeTrack({ title: 'Hip Hop 1', genres: ['hip hop'], bpm: 92 }),
    makeTrack({ title: 'Hip Hop 2', genres: ['hip hop'], bpm: 95 }),
  ];

  const sequenced = analysis.sequenceGenreClusters(tracks, { mode: 'club-beat-driven', weights: {} });
  assert.equal(sequenced.length, tracks.length);
  assert.deepEqual(
    [...sequenced.map((item) => item.title)].sort(),
    [...tracks.map((item) => item.title)].sort()
  );
});

test('computeTransitionDiagnostics returns adjacency metrics', () => {
  const tracks = [
    makeTrack({ title: 'A', bpm: 110, key: 9, mode: 0 }),
    makeTrack({ title: 'B', bpm: 114, key: 10, mode: 0 }),
    makeTrack({ title: 'C', bpm: 128, key: 0, mode: 1 }),
  ];

  const diagnostics = analysis.computeTransitionDiagnostics(tracks, {
    mode: 'generic',
    weights: {},
  });
  assert.equal(diagnostics.length, 2);
  assert.equal(typeof diagnostics[0].score, 'number');
  assert.equal(typeof diagnostics[0].harmonicScore, 'number');
  assert.equal(typeof diagnostics[0].artistSpacingBonus, 'number');
});

test('artist avoidance can be disabled in transition diagnostics', () => {
  const tracks = [
    makeTrack({ title: 'A', artistDisplay: 'Artist One' }),
    makeTrack({ title: 'B', artistDisplay: 'Artist One' }),
  ];

  const diagnostics = analysis.computeTransitionDiagnostics(tracks, {
    mode: 'generic',
    weights: {},
    artistAvoidance: { enabled: false, strength: 1 },
  });

  assert.equal(diagnostics[0].artistSpacingBonus, 0);
});

test('mix mode defaults expose the expected preset names and weights', () => {
  assert.deepEqual(Object.keys(analysis.MIX_MODES), [
    'smooth-harmonic',
    'club-beat-driven',
    'quick-transition',
    'generic',
  ]);
  assert.equal(analysis.DEFAULT_WEIGHTS.genre, 0.1);
  assert.equal(analysis.DEFAULT_WEIGHTS.harmonic, 0.22);
  assert.equal(analysis.MIX_MODES['smooth-harmonic'].harmonic, 0.24);
  assert.equal(analysis.MIX_MODES['club-beat-driven'].bpm, 0.24);
  assert.equal(analysis.MIX_MODES['quick-transition'].energy, 0.18);
  assert.equal(analysis.MIX_MODES.generic.liveness, 0.01);
});

test('detectOutliers returns original working index for removal actions', () => {
  const tracks = [
    makeTrack({ title: 'A' }),
    makeTrack({ title: 'B', bpm: 70, energy: 0.1, genres: ['bebop'] }),
  ];

  const ranked = analysis.detectOutliers(tracks);
  assert.ok(ranked.every((item) => Number.isInteger(item.index)));
  assert.equal(ranked.find((item) => item.track.title === 'B')?.index, 1);
});
