import { test } from 'node:test';
import assert from 'node:assert/strict';
import analysis from '../src/shared/analysis.js';
import { enrichTracks, formatAdded, formatDuration, parseDuration, parseExportify, prepareRows } from '../src/renderer/trackData.js';
import { compileFilters } from '../src/renderer/tableView.js';

test('Exportify imports quoted fields, repeated recordings, and genuine zero values', () => {
  const csv = '\ufeffTrack URI,Track Name,Artist Name(s),Duration (ms),Added At,Tempo,Key,Mode,Instrumentalness,ISRC\r\n' +
    'spotify:track:aa,"A, ""long""\ntitle",One;Two,90123,2024-03-01T13:00:00Z,120,0,0,0,ISRC01\r\n' +
    'spotify:track:aa,Again,One,,,,,,,\r\n';
  const [a, b] = prepareRows(parseExportify(csv));
  assert.equal(a.title, 'A, "long"\ntitle');
  assert.deepEqual(a.artists, ['One', 'Two']);
  assert.equal(a.instrumentalness, 0);
  assert.equal(a.isrc, 'ISRC01');
  assert.equal(a.keyModeLabel, 'C minor');
  assert.equal(b.bpm, null);
  assert.notEqual(a.rowId, b.rowId);
  assert.equal(a.uri, b.uri);
  assert.equal(a.addedTime, Date.UTC(2024, 2, 1, 13));
  assert.deepEqual(analysis.getAudioCoverage([a, b]), { audio: 1, tempo: 1, genres: 0 });
  assert.throws(() => parseExportify('Hello,World\n1,2'), /Track Name or Track URI/);
  assert.throws(() => parseExportify('Track Name\n"broken'), /quoted field/);
  assert.throws(() => parseExportify('Track URI,Track Name\n,'), /no track rows/);
});

test('enrichment preserves duplicate occurrences, order, dates, and unmatched recordings', () => {
  const base = [{ uri: 'spotify:track:x', addedBy: 'one' }, { uri: 'spotify:track:y' }, { uri: 'spotify:track:x', addedBy: 'two' }];
  const richer = [{ uri: 'spotify:track:x', bpm: 100, acousticness: 0, addedBy: 'csv' }, { uri: 'spotify:track:x', bpm: null, recordLabel: 'Label' }];
  const { tracks, matched } = enrichTracks(base, richer);
  assert.equal(matched, 2);
  assert.deepEqual(tracks.map((t) => t.addedBy), ['one', undefined, 'two']);
  assert.equal(tracks[0].bpm, 100); assert.equal(tracks[2].acousticness, 0);
  assert.equal(tracks[0].recordLabel, 'Label'); assert.equal(tracks[1], base[1]);
  assert.equal(base[0].bpm, undefined);
  assert.equal(enrichTracks(base, [{ uri: 'spotify:track:z', bpm: 12 }]).matched, 0);
});

test('duration uses the same units in the table and range filters, dates keep their sort key', () => {
  assert.equal(formatDuration(0), '0:00'); assert.equal(formatDuration(3600123), '60:00');
  assert.equal(formatDuration(null), '—'); assert.equal(formatAdded('bad date'), '—');
  assert.match(formatAdded('2024-11-09T14:15:00Z'), /2024/);
  assert.equal(formatAdded('2024-11-09'), new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date('2024-11-09')));
  assert.equal(parseDuration('1:03'), 63000); assert.equal(parseDuration('63'), 63000);
  assert.ok(Number.isNaN(parseDuration('3:74')));
  const rows = prepareRows([{ title: 'Title', addedAt: '2024-04-30T22:00:00-04:00', durationMs: 62000 },
    { title: 'Other', durationMs: 67000, addedAt: '2024-05-01T00:30:00Z' }]);
  assert.ok(rows[0].addedTime > rows[1].addedTime);
  const filters = new Map([['durationMs', { kind: 'duration', min: parseDuration('1:00'), max: parseDuration('1:04') }]]);
  assert.deepEqual(rows.filter(compileFilters('TITLE', filters)), [rows[0]]);
});

test('an edited weight stays fixed and every preset sums to 100 including boundary and legacy inputs', () => {
  for (const preset of Object.values(analysis.MIX_MODES)) {
    const normal = analysis.weightPercentages(preset);
    assert.ok(normal.bpm > normal.harmonic && normal.bpm > normal.acousticness);
    assert.equal(Object.values(normal).reduce((a,b) => a + b), 100);
    for (const field of Object.keys(normal)) for (const value of [0, 1, 27, 99, 100]) {
      const live = analysis.weightPercentages(normal, field, value, preset);
      assert.equal(live[field], value);
      assert.equal(Object.values(live).reduce((a,b) => a + b), 100);
    }
  }
  assert.deepEqual(analysis.weightPercentages({}), analysis.weightPercentages(analysis.DEFAULT_WEIGHTS));
  assert.equal(analysis.weightPercentages({ camelot: 4, bpm: 1 }).harmonic, 80);
  assert.equal(analysis.weightPercentages({ bpm: 100 }, 'bpm', 70).bpm, 70);
  assert.equal(analysis.resolveMode('quick-transition'), 'club-beat-driven');
});

test('transitions use available weighted evidence, display coverage, and recognize related musical keys', () => {
  const rows = [{ bpm: 100, key: 0, mode: 1 }, { bpm: 100, key: 9, mode: 0 }, {}, { bpm: 172 }];
  const [match, empty] = analysis.computeTransitionDiagnostics(rows, {});
  assert.equal(match.harmonicScore, 1);
  assert.equal(match.quality, 'smooth'); assert.ok(match.coverage < 1);
  assert.equal(empty.score, null); assert.equal(empty.quality, 'limited');
  const [half] = analysis.computeTransitionDiagnostics([{ tempo: 80 }, { tempo: 160 }]);
  assert.equal(half.halfTime, true);
  assert.deepEqual(analysis.computeTransitionDiagnostics(rows, {}, 1, 1), [empty]);
});

test('sequencing favors tempo, keeps unmeasured slots, and returns each occurrence exactly once at scale', () => {
  const small = [{ bpm: 120 }, { bpm: 150 }, {}, { bpm: 121 }];
  assert.deepEqual(analysis.optimizeMixOrder(small, {}), [small[0], small[3], small[2], small[1]]);
  const none = [{ valence: 0.2 }, { valence: 0.8 }];
  assert.deepEqual(analysis.optimizeMixOrder(none), none);
  const many = Array.from({ length: 1200 }, (_, i) => ({ rowId: i, bpm: 80 + (i * 17) % 90, genres: [i % 2 ? 'a' : 'b'] }));
  for (const sequence of [analysis.optimizeMixOrder(many), analysis.sequenceGenreClusters(many)]) {
    assert.equal(sequence.length, many.length);
    assert.equal(new Set(sequence.map((row) => row.rowId)).size, many.length);
  }
});

test('outlier flags require evidence and explain magnitude and direction against a robust baseline', () => {
  const normal = Array.from({ length: 18 }, (_, i) => ({ bpm: 120 + i % 3, acousticness: .20, genres: ['house'] }));
  const odd = { bpm: 167, acousticness: .92, genres: ['folk'] };
  const rows = analysis.detectOutliers([...normal, odd]);
  assert.deepEqual(rows.map((r) => r.index), [18]);
  assert.ok(rows[0].reasons.some((r) => r.includes('167 BPM') && r.includes('above') && r.includes('median')));
  assert.ok(rows[0].reasons.some((r) => r.includes('1 of 19')));
  assert.deepEqual(analysis.detectOutliers([...normal, { bpm: 60, genres: ['rare', 'unusual'] }, {}]), []);
  assert.deepEqual(analysis.detectOutliers([{ bpm: 101 }, { bpm: 200 }]), []);
  assert.equal(analysis.analyzeOutliers([...normal.map(() => ({})), odd]).fieldsCompared, 0);
  assert.equal(analysis.canAssessOutliers(normal.map(() => ({ key: 2, mode: 1 }))), false);
  assert.equal(analysis.canAssessOutliers(normal), true);
  assert.deepEqual(analysis.detectOutliers([...normal.map(() => ({ valence: .5 })), { valence: 1 }]), []);
  assert.deepEqual(analysis.detectOutliers([...normal.map(() => ({ bpm: 120 })), { bpm: 119.5 }]), []);
  assert.deepEqual(analysis.detectOutliers(normal.map((_, i) => ({ bpm: i % 2 ? 92 : 132 }))), []);
});

test('duplicate review distinguishes international titles and unlabelled recordings', () => {
  const rows = [
    { title: '静かな夜', primaryArtist: 'Example' }, { title: '青い月', primaryArtist: 'Example' },
    { uri: 'spotify:track:a' }, { uri: 'spotify:track:b' }, { uri: 'spotify:track:a' },
  ];
  const report = analysis.findDuplicates(rows);
  assert.deepEqual(report.exactGroups.map((group) => group.map((entry) => entry.index)), [[2, 4]]);
  assert.equal(report.nearGroups.length, 0);
});
