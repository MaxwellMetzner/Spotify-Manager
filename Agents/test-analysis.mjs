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
