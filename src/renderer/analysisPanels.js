import { $, escapeHtml as html, notify, readObject } from './ui.js';

const analysis = globalThis.PlaylistAnalysis;
const labels = { bpm: 'Tempo (BPM)', harmonic: 'Musical key', loudness: 'Loudness', instrumentalness: 'Instrumentalness',
  acousticness: 'Acousticness', speechiness: 'Speechiness', energy: 'Energy', danceability: 'Danceability',
  valence: 'Valence', liveness: 'Liveness', genre: 'Genre' };
const modeText = {
  'club-beat-driven': 'Prioritize close tempos, with a smaller role for key and loudness.',
  'smooth-harmonic': 'Balance tempo with compatible keys on the circle of fifths.',
  'acoustic-flow': 'Use tempo alongside acoustic, instrumental, and spoken texture.',
};
const presetKey = 'spotifyManager.weightPresets.v2';
const pageSize = 24;

function paginate(id, count, page, change) {
  const pages = Math.ceil(count / pageSize);
  const host = $(id);
  host.innerHTML = pages > 1 ? `<span>Page ${page + 1} of ${pages}</span><button class="btn small" data-step="-1" aria-label="Previous page" ${page === 0 ? 'disabled' : ''}>←</button><button class="btn small" data-step="1" aria-label="Next page" ${page + 1 === pages ? 'disabled' : ''}>→</button>` : '';
  host.onclick = (e) => { const button = e.target.closest('[data-step]'); if (button) change(page + Number(button.dataset.step)); };
}

function gate(id, title, text) {
  const host = $(id);
  host.hidden = !title;
  if (title) host.innerHTML = `<h3>${html(title)}</h3><p>${html(text)}</p><div class="inline"><button class="btn small" data-action="import">Import CSV</button><a class="text-btn" href="https://exportify.net/" target="_blank" rel="noopener noreferrer">Open Exportify ↗</a></div>`;
}

export function bindAnalysisPanels({ visibleTracks, workingTracks, hasPlaylist, removeRows, sequence, initialWeights }) {
  const mode = $('mixModeSelect'), sliders = $('mixWeightSliders');
  const presets = readObject(presetKey);
  let weights, gesture, transitionPage = 0, outlierPage = 0, duplicatePage = 0;
  let availableFactors = {}, mixRows = [], outliers = null, duplicateEntries = null, marked = new Set();

  sliders.innerHTML = Object.entries(labels).map(([key, label]) =>
    `<label class="slider-row"><span>${label}</span><input data-weight="${key}" type="range" min="0" max="100" step="1"><output></output></label>`
  ).join('');
  function showWeights(next) {
    weights = next;
    for (const input of sliders.querySelectorAll('input')) {
      const pct = weights[input.dataset.weight];
      input.value = pct;
      input.nextElementSibling.value = pct + '%';
      input.setAttribute('aria-valuetext', pct + '%');
    }
    const leading = Object.entries(next).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const rest = 100 - leading.reduce((sum, [, value]) => sum + value, 0);
    if (rest) leading.push(['other', rest]);
    $('weightBar').innerHTML = leading.map(([, value], i) => `<i class="weight-color-${i}" style="width:${value}%"></i>`).join('');
    $('weightLegend').innerHTML = leading.map(([key, value], i) =>
      `<span><i class="weight-color-${i}"></i>${key === 'other' ? 'Other' : labels[key]} ${value}%</span>`
    ).join('');
    const comparable = Object.keys(next).some((key) => next[key] > 0 && availableFactors[key] >= 2);
    $('mixAssistBtn').disabled = !comparable;
    $('modeHint').textContent = modeText[mode.value] + (!comparable && mixRows.length >= 2 ? ' Choose a weight measured on at least two tracks to apply an order.' : '');
  }
  function setMode() {
    gesture = null;
    showWeights(analysis.weightPercentages(analysis.MIX_MODES[mode.value]));
    renderTransitions();
  }
  function options() {
    return { mode: mode.value, weights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / 100])),
      artistAvoidance: { enabled: $('artistAvoidanceEnabled').checked, strength: Number($('artistAvoidanceStrength').value) / 100 } };
  }
  mode.onchange = setMode;
  sliders.onpointerdown = () => { gesture = { ...weights }; };
  sliders.oninput = ({ target }) => {
    if (!target.dataset.weight) return;
    showWeights(analysis.weightPercentages(gesture || weights, target.dataset.weight, Number(target.value), analysis.MIX_MODES[mode.value]));
  };
  sliders.onchange = () => { gesture = null; renderTransitions(); };
  function artistControls() {
    const strength = $('artistAvoidanceStrength');
    strength.disabled = !$('artistAvoidanceEnabled').checked;
    $('artistAvoidanceStrengthValue').value = strength.disabled ? 'Off' : strength.value + '%';
  }
  $('artistAvoidanceEnabled').onchange = () => { artistControls(); renderTransitions(); };
  $('artistAvoidanceStrength').oninput = artistControls;
  $('artistAvoidanceStrength').onchange = () => renderTransitions();
  function presetList(selected = '') {
    const select = $('weightPresetSelect');
    select.replaceChildren(new Option('Choose a preset', ''));
    for (const name of Object.keys(presets).sort()) select.add(new Option(name, name));
    select.value = selected;
  }
  function savePresets(name = '') {
    try { localStorage.setItem(presetKey, JSON.stringify(presets)); } catch { notify('Browser storage is unavailable for presets.', true); }
    presetList(name);
  }
  $('saveWeightPresetBtn').onclick = () => {
    const name = $('weightPresetName').value.trim();
    if (!name) return notify('Enter a name for these weights.', true);
    Object.defineProperty(presets, name, { value: options(), writable: true, configurable: true, enumerable: true });
    savePresets(name);
  };
  function restoreOptions(preset) {
    gesture = null;
    mode.value = analysis.resolveMode(preset.mode);
    showWeights(analysis.weightPercentages(preset.weights, null, 0, analysis.MIX_MODES[mode.value]));
    $('artistAvoidanceEnabled').checked = preset.artistAvoidance?.enabled ?? true;
    $('artistAvoidanceStrength').value = Math.round(100 * (preset.artistAvoidance?.strength ?? 0.35));
    artistControls(); renderTransitions();
  }
  $('loadWeightPresetBtn').onclick = () => {
    const preset = presets[$('weightPresetSelect').value];
    if (!preset || !preset.weights) return notify('Choose a saved preset.', true);
    restoreOptions(preset);
  };
  $('deleteWeightPresetBtn').onclick = () => {
    const name = $('weightPresetSelect').value;
    if (name) { delete presets[name]; savePresets(); }
  };
  showWeights(analysis.weightPercentages(initialWeights || analysis.DEFAULT_WEIGHTS));
  presetList();
  $('mixAssistBtn').onclick = () => sequence('mix', options());
  $('genreSequenceBtn').onclick = () => sequence('genre', options());

  function renderTransitions() {
    if ($('mixView').hidden || $('mixTools').hidden) return;
    const n = Math.max(0, mixRows.length - 1);
    transitionPage = Math.min(transitionPage, Math.max(0, Math.ceil(n / pageSize) - 1));
    const rows = analysis.computeTransitionDiagnostics(mixRows, options(), transitionPage * pageSize, pageSize);
    const grades = { smooth: 'Smooth', moderate: 'Moderate', rough: 'Abrupt', limited: 'Limited data' };
    $('transitionCount').textContent = n.toLocaleString() + ' pairs';
    $('transitionResults').innerHTML = rows.map((row) => {
      const delta = row.bpmDelta;
      const details = [delta === null ? 'Tempo unavailable' : (delta > 0 ? '+' : '') + Number(delta.toFixed(1)) + ' BPM'];
      if (row.halfTime) details.push('Half/double-time match');
      if (row.artistSpacingBonus < 0) details.push('Recent artist repeat');
      if (row.quality === 'limited') details.push('Partial measurements');
      const percent = (value) => value === null ? 'Unavailable' : Math.round(value * 100) + '%';
      const breakdown = [
        ['Pair fit', percent(row.transitionScore)], ['Key compatibility', percent(row.harmonicScore)],
        ['Genre overlap', percent(row.genreScore)], ['Artist adjustment', Math.round(row.artistSpacingBonus * 100) + ' points'],
        ['Comparable weight', percent(row.coverage)],
      ].map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>').join('');
      return `<div class="diagnostic transition ${row.quality}"><span class="transition-index">${row.index + 1}</span><div><strong>${html(row.fromTitle || 'Untitled')} → ${html(row.toTitle || 'Untitled')}</strong><details class="pair-details"><summary>${details.join(' · ')}</summary><dl>${breakdown}</dl></details></div><span class="quality">${grades[row.quality]}${row.quality === 'limited' ? '' : '<br>' + Math.round(row.score * 100) + '/100'}</span></div>`;
    }).join('') || '<p class="empty-result">Two visible tracks are needed for a transition.</p>';
    paginate('transitionPager', n, transitionPage, (p) => { transitionPage = p; renderTransitions(); });
  }

  function showMix() {
    mixRows = visibleTracks();
    transitionPage = 0;
    const { audio, tempo, genres } = analysis.getAudioCoverage(mixRows);
    const usable = audio >= 2 || genres >= 2;
    $('mixTools').hidden = !usable;
    availableFactors = analysis.comparableFactors(mixRows);
    showWeights(weights);
    $('genreSequenceBtn').disabled = genres < 2;
    $('genreSequenceBtn').title = genres < 2 ? 'Requires genre tags on at least two visible tracks' : 'Sequence within each primary genre';
    if (!usable && hasPlaylist() && mixRows.length < 2) {
      gate('mixGate', 'Two visible tracks needed', 'Check the tracklist and its filters, or open a longer playlist.');
    } else if (audio < 2) {
      gate('mixGate', 'Add audio features for Mix Assist', 'Import an Exportify CSV with tempo or other audio features on at least two tracks to compare transitions.');
    } else gate('mixGate', '', '');
    $('mixCoverage').textContent = tempo + ' / ' + mixRows.length + ' with BPM';
    renderTransitions();
  }

  function renderOutliers() {
    const report = outliers;
    const n = report?.rows.length || 0;
    const entries = report?.rows.slice(outlierPage * pageSize, (outlierPage + 1) * pageSize) || [];
    let empty = 'Scan to compare tracks with this playlist.';
    if (report) empty = report.fieldsCompared ? 'No tracks met the outlier threshold.' : 'At least six tracks need values for the same audio feature.';
    $('outliersResult').innerHTML = entries.length
      ? `<p class="small-meta">${n} flagged · ${report.fieldsCompared} features compared</p>` + entries.map((item) =>
        `<article class="diagnostic"><strong>${html(item.track.title || 'Untitled')}</strong><p>${html(item.track.artistDisplay)}</p><ul>${item.reasons.map((r) => '<li>' + html(r) + '</li>').join('')}</ul><button class="text-btn" data-remove="${item.track.rowId}">Remove track</button></article>`
      ).join('') : '<p class="empty-result">' + empty + '</p>';
    paginate('outlierPager', n, outlierPage, (p) => { outlierPage = p; renderOutliers(); });
  }
  function renderDuplicates() {
    const n = duplicateEntries?.length || 0;
    const entries = duplicateEntries?.slice(duplicatePage * pageSize, (duplicatePage + 1) * pageSize) || [];
    let group = -1;
    $('dedupeResults').innerHTML = entries.map(({ groupIndex, kind, entry }) => {
      const heading = group !== groupIndex ? `<p class="small-meta">${kind === 'exact' ? 'Exact match' : 'Possible match'} · Group ${groupIndex + 1}</p>` : '';
      group = groupIndex;
      return heading + `<label class="duplicate-choice"><input type="checkbox" data-row="${entry.track.rowId}" ${marked.has(entry.track.rowId) ? 'checked' : ''}><span><strong>${html(entry.track.title || 'Untitled')}</strong> · ${html(entry.track.artistDisplay)}${entry.recommendedKeep ? ' · Suggested keep' : ''}<small>Track ${entry.track.customOrder}${kind === 'near' ? ' · Match ' + entry.pairScore + '%' : ''}</small></span></label>`;
    }).join('') || `<p class="empty-result">${duplicateEntries ? 'No duplicate recordings found.' : 'Scan to find recordings that may appear more than once.'}</p>`;
    $('applyDedupeSelectionsBtn').hidden = !n;
    $('applyDedupeSelectionsBtn').disabled = !marked.size;
    $('applyDedupeSelectionsBtn').textContent = 'Remove checked (' + marked.size + ')';
    paginate('duplicatePager', n, duplicatePage, (p) => { duplicatePage = p; renderDuplicates(); });
  }
  $('dedupeResults').onchange = ({ target }) => {
    if (!target.matches('[data-row]')) return;
    const id = Number(target.dataset.row);
    target.checked ? marked.add(id) : marked.delete(id);
    renderDuplicates();
  };
  $('applyDedupeSelectionsBtn').onclick = () => removeRows([...marked]);
  function scanDuplicates() {
    const { mergeGroups } = analysis.findDuplicates(workingTracks());
    duplicateEntries = mergeGroups.flatMap((group, groupIndex) => group.items.map((entry) => ({ entry, groupIndex, kind: group.kind })));
    marked = new Set(duplicateEntries.filter(({ entry }) => entry.removeByDefault).map(({ entry }) => entry.track.rowId));
    duplicatePage = 0; renderDuplicates();
  }
  $('analyzeDuplicatesBtn').onclick = () => {
    scanDuplicates();
    notify(duplicateEntries.length ? 'Review the checked recordings before removing them.' : 'Duplicate scan complete.');
  };
  $('outliersBtn').onclick = () => {
    outliers = analysis.analyzeOutliers(workingTracks()); outlierPage = 0; renderOutliers();
    notify('Outlier scan complete. ' + outliers.rows.length + ' flagged.');
  };
  $('outliersResult').onclick = (event) => {
    const button = event.target.closest('[data-remove]');
    if (button) removeRows([Number(button.dataset.remove)]);
  };
  function showAnalyzer() {
    const tracks = workingTracks(), { audio } = analysis.getAudioCoverage(tracks);
    const enoughMeasurements = analysis.canAssessOutliers(tracks);
    $('analysisTools').hidden = !hasPlaylist();
    $('outliersBtn').disabled = !enoughMeasurements;
    $('analyzeDuplicatesBtn').disabled = tracks.length < 2;
    if (!hasPlaylist() || !audio) gate('analysisGate', 'Audio data for outliers', 'Import an Exportify CSV to compare track features. Duplicate scanning uses track titles and artists.');
    else gate('analysisGate', '', '');
    renderOutliers(); renderDuplicates();
    if (hasPlaylist() && !enoughMeasurements) $('outliersResult').textContent = 'Outlier detection needs six tracks with a shared numerical audio feature.';
  }
  return {
    showMix, showAnalyzer, options, restoreOptions,
    invalidate(refreshOpenReports = false) {
      const rescanDuplicates = refreshOpenReports && duplicateEntries !== null;
      outliers = refreshOpenReports && outliers ? analysis.analyzeOutliers(workingTracks()) : null;
      duplicateEntries = null; marked.clear(); mixRows = []; outlierPage = duplicatePage = transitionPage = 0;
      if (rescanDuplicates) scanDuplicates();
    },
  };
}
