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
    camelot: '8A',
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
    albumReleaseYear: 2018,
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
    makeTrack({ title: 'A', bpm: 110, camelot: '7A' }),
    makeTrack({ title: 'B', bpm: 112, camelot: '8A' }),
    makeTrack({ title: 'C', bpm: 130, camelot: '10B' }),
    makeTrack({ title: 'D', bpm: 129, camelot: '11B' }),
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
    makeTrack({ title: 'Summer Heat', albumReleaseYear: 2015, bpm: 100, energy: 0.4 }),
    makeTrack({ title: 'Winter Chill', albumReleaseYear: 2018, bpm: 128, energy: 0.8 }),
  ];

  const filtered = analysis.applyFilters(tracks, [
    { field: 'title', kind: 'contains', query: 'summer' },
    { field: 'albumReleaseYear', kind: 'yearRange', min: 2014, max: 2016 },
    { field: 'energy', kind: 'range', min: 0.3, max: 0.5 },
  ]);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, 'Summer Heat');
});

test('applyFilters supports set and negate qualifiers', () => {
  const tracks = [
    makeTrack({ title: 'Set A', camelot: '8A', timeSignature: 4 }),
    makeTrack({ title: 'Set B', camelot: '9A', timeSignature: 3 }),
    makeTrack({ title: 'Set C', camelot: '8B', timeSignature: 4 }),
  ];

  const filtered = analysis.applyFilters(tracks, [
    { field: 'camelot', kind: 'set', values: ['8A', '8B'] },
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
      albumReleaseYear: 2019,
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

  const sequenced = analysis.sequenceGenreClusters(tracks, { mode: 'club-flow', weights: {} });
  assert.equal(sequenced.length, tracks.length);
  assert.deepEqual(
    [...sequenced.map((item) => item.title)].sort(),
    [...tracks.map((item) => item.title)].sort()
  );
});

test('computeTransitionDiagnostics returns adjacency metrics', () => {
  const tracks = [
    makeTrack({ title: 'A', bpm: 110, camelot: '8A' }),
    makeTrack({ title: 'B', bpm: 114, camelot: '8B' }),
    makeTrack({ title: 'C', bpm: 128, camelot: '10A' }),
  ];

  const diagnostics = analysis.computeTransitionDiagnostics(tracks, {
    mode: 'balanced',
    weights: {},
  });
  assert.equal(diagnostics.length, 2);
  assert.equal(typeof diagnostics[0].score, 'number');
  assert.equal(typeof diagnostics[0].camelotDistance, 'number');
});
