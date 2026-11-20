import { createPlaylistFromTracks, inspectPlaylistOverwrite, overwritePlaylistItems } from '../spotifyApi.js';
import { canOverwritePlaylist, describeReplacement, originalPlaylistCsv, playlistSizeError } from '../shared/playlistOverwrite.js';
import { $, notify, showDialog, status } from './ui.js';

const count = (n) => n.toLocaleString();
const tracks = (n) => count(n) + (n === 1 ? ' track' : ' tracks');

export function bindSpotifySave({ context, updatePlaylist }) {
  const chooser = $('exportReviewModal'), confirmation = $('overwriteConfirmModal');
  const mode = $('exportMode'), destination = $('overwriteTarget'), range = $('overwriteRange');
  const nameInput = $('exportPlaylistName'), submit = $('confirmExportBtn');
  const cancel = $('overwriteCancel'), confirm = $('confirmOverwriteBtn'), recheck = $('recheckOverwriteBtn');
  let review, target, backupUrl, phase = 'idle', version = 0;
  const proposal = () => review.full && range.value === 'full' ? review.full : review;
  function discard() {
    if (chooser.open || confirmation.open) return;
    version++;
    phase = 'idle';
    review = target = null;
    if (backupUrl) URL.revokeObjectURL(backupUrl);
    backupUrl = null;
    $('overwriteBackup').removeAttribute('href');
  }
  function renderChooser() {
    const overwriting = mode.value === 'overwrite', busy = phase !== 'choose';
    const selected = proposal(), name = nameInput.value.trim();
    $('exportNameField').hidden = overwriting;
    $('overwriteTargetField').hidden = !overwriting;
    $('overwriteRangeField').hidden = !overwriting || !review.full;
    nameInput.disabled = overwriting || busy;
    mode.disabled = range.disabled = destination.disabled = busy;
    for (const button of chooser.querySelectorAll('[data-close]')) button.disabled = phase === 'creating';
    $('exportReviewSummary').textContent = overwriting
      ? selected.sourceDescription + (selected.skipped ? ' Skipping ' + tracks(selected.skipped) + ' without a Spotify track URI.' : '')
      : review.summary;
    let error = playlistSizeError((overwriting ? selected : review).uris.length);
    if (overwriting) {
      if (destination.options.length === 1) error = 'Your library has no owned or collaborative playlists available for overwrite.';
      else if (!selected.uris.length && !review.allowEmpty) error = 'This selection has no tracks with a valid Spotify URI.';
    } else if (!review.uris.length) error = 'No visible tracks have valid Spotify URIs.';
    else if (!name) error = 'Enter a playlist name.';
    else if (context().playlists.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) error = 'Choose a name that is not already in your library.';
    status('exportNameError', error, !!error);
    submit.textContent = overwriting ? 'Review overwrite' : 'Create private playlist';
    submit.disabled = busy || !!error || (overwriting && !destination.value);
  }
  function open(next) {
    if (chooser.open || confirmation.open) return;
    discard();
    review = { ...next, sourceDescription: next.sourceDescription || tracks(next.uris.length) + ' in the selected order.' };
    phase = 'choose';
    const { user, playlists } = context();
    const choices = playlists.filter((p) => canOverwritePlaylist(p, user?.id));
    const labels = choices.map((p) => [p.name, p.owner].filter(Boolean).join(' · '));
    const used = new Set(), duplicate = new Set();
    for (const label of labels) { if (used.has(label)) duplicate.add(label); used.add(label); }
    destination.replaceChildren(new Option('Choose a playlist…', ''));
    choices.forEach((p, i) => destination.add(new Option(labels[i] + (duplicate.has(labels[i]) ? ' · ' + p.id : ''), p.id)));
    destination.value = choices.some((p) => p.id === review.preferredId) ? review.preferredId : '';
    range.replaceChildren();
    if (review.full) {
      range.add(new Option('Whole working playlist · ' + tracks(review.full.uris.length), 'full'));
      range.add(new Option('Filtered tracks in displayed order · ' + tracks(review.uris.length), 'filtered'));
    }
    mode.value = 'create';
    nameInput.value = review.name;
    renderChooser();
    showDialog('exportReviewModal');
  }
  function renderConfirmation(selected) {
    const diff = describeReplacement(target.entries, selected.uris);
    const n = selected.uris.length;
    $('overwriteConfirmTitle').textContent = diff.identical ? 'Already up to date' : n ? 'Overwrite this playlist?' : 'Clear this playlist?';
    const link = $('overwritePlaylistLink');
    link.textContent = target.name;
    link.href = 'https://open.spotify.com/playlist/' + encodeURIComponent(target.id);
    $('overwriteOwner').textContent = [target.owner && 'Owned by ' + target.owner,
      target.collaborative && 'Collaborative', typeof target.isPublic === 'boolean' && (target.isPublic ? 'Public' : 'Private')].filter(Boolean).join(' · ');
    $('overwriteSource').textContent = selected.sourceDescription;
    $('overwriteBefore').textContent = count(target.entries.length);
    $('overwriteAfter').textContent = count(n);
    $('overwriteAdded').textContent = count(diff.added);
    $('overwriteRemoved').textContent = count(diff.removed);
    let impact;
    if (diff.identical) impact = 'The entries and their order already match.';
    else if (!n) impact = 'Every entry will be removed from this playlist.';
    else if (diff.appendFrom !== null) impact = 'The existing order matches. Only the ' + tracks(diff.added) + ' at the end will be added.';
    else if (diff.move) impact = 'Spotify will move the tracks into order, preserving their added dates and contributor credits.';
    else if (!diff.removed && !diff.added) impact = 'The same tracks will be saved in a different order.';
    else impact = 'The updated playlist will include ' + tracks(diff.kept) + ' from its current contents.';
    if (diff.removedNames.length) impact += ' Removing ' + diff.removedNames.join(', ') + (diff.removed > diff.removedNames.length ? ' and ' + count(diff.removed - diff.removedNames.length) + ' more' : '') + '.';
    $('overwriteImpact').textContent = impact;
    const warnings = [];
    if (review.preferredId === target.id && review.baseSnapshot && review.baseSnapshot !== target.snapshotId)
      warnings.push('This playlist changed on Spotify after you opened the working copy.');
    if (selected.skipped) warnings.push(tracks(selected.skipped) + ' without a valid Spotify URI will be skipped.');
    if (diff.episodes) warnings.push(count(diff.episodes) + (diff.episodes === 1 ? ' podcast episode will' : ' podcast episodes will') + ' be removed.');
    if (diff.unavailable) warnings.push(count(diff.unavailable) + (diff.unavailable === 1 ? ' local or unavailable entry will' : ' local or unavailable entries will') + ' be removed.');
    if (diff.appendFrom === null && diff.kept && !diff.move) warnings.push('Spotify may give re-added tracks new added dates and credit your account.');
    if (!diff.move && !diff.identical && n - (diff.appendFrom || 0) > 100) warnings.push('Spotify will save this list in batches of up to 100 tracks. An interruption can leave a partial playlist.');
    $('overwriteWarnings').textContent = warnings.join('\n');
    $('overwriteWarnings').hidden = !warnings.length;
    if (!backupUrl) {
      backupUrl = URL.createObjectURL(new Blob([originalPlaylistCsv(target.entries)], { type: 'text/csv;charset=utf-8' }));
      $('overwriteBackup').href = backupUrl;
      $('overwriteBackup').download = (target.name.replace(/[<>:"/\\|?*]/g, '_') || 'playlist') + ' - original.csv';
    }
    cancel.disabled = false;
    cancel.textContent = diff.identical ? 'Done' : 'Cancel';
    confirm.hidden = diff.identical;
    confirm.textContent = n ? 'Yes, overwrite playlist' : 'Yes, clear playlist';
    confirm.disabled = false;
    recheck.hidden = true;
    status('overwriteStatus');
  }
  async function readDestination(dialog) {
    const ticket = ++version;
    const isCurrent = () => version === ticket && dialog.open;
    const first = dialog === chooser, statusId = first ? 'exportNameError' : 'overwriteStatus';
    phase = 'reading';
    if (first) renderChooser();
    else recheck.disabled = true;
    status(statusId, 'Reading the current playlist from Spotify…');
    try {
      const result = await inspectPlaylistOverwrite(destination.value, context().user?.id, { isCurrent,
        onProgress: (n, total) => { if (isCurrent()) status(statusId, 'Read ' + count(n) + ' of ' + count(total) + ' entries…'); },
      });
      if (!isCurrent() || !result) return;
      target = result;
      const cached = context().playlists.find((p) => p.id === target.id);
      if (cached?.snapshotId !== target.snapshotId || cached?.totalTracks !== target.entries.length) {
        const { entries, ...header } = target;
        updatePlaylist({ ...header, totalTracks: entries.length });
      }
      phase = 'confirm';
      renderConfirmation(proposal());
      if (first) { chooser.close(); showDialog('overwriteConfirmModal'); }
      const focus = confirmation.scrollHeight > confirmation.clientHeight ? $('overwriteConfirmTitle') : cancel;
      focus.focus({ preventScroll: true });
      confirmation.scrollTop = 0;
    } catch (e) {
      if (!isCurrent()) return;
      phase = first ? 'choose' : 'failed';
      if (first) renderChooser();
      status(statusId, e.message, true);
    } finally { recheck.disabled = false; }
  }
  $('exportForm').onsubmit = async (event) => {
    event.preventDefault();
    if (phase !== 'choose' || submit.disabled) return;
    if (mode.value === 'overwrite') { await readDestination(chooser); return; }
    const name = nameInput.value.trim(), { user } = context();
    phase = 'creating';
    renderChooser();
    status('exportNameError', 'Creating your private playlist…');
    try {
      const saved = await createPlaylistFromTracks({ name, description: 'Created with Spotify Manager', public: false, trackUris: review.uris });
      updatePlaylist({ ...saved, name: saved.name || name, ownerId: user?.id, owner: user?.display_name || user?.id, isPublic: false, canLoad: true });
      chooser.close();
      notify('Saved “' + name + '” to Spotify.');
    } catch (e) { phase = 'choose'; renderChooser(); status('exportNameError', e.message, true); }
  };
  confirm.onclick = async () => {
    if (phase !== 'confirm' || confirm.hidden || !confirmation.open) return;
    phase = 'writing';
    cancel.disabled = confirm.disabled = true;
    status('overwriteStatus', 'Checking the playlist version on Spotify…');
    const { uris } = proposal();
    try {
      const saved = await overwritePlaylistItems({ target, uris, userId: context().user?.id, allowEmpty: review.allowEmpty,
        onProgress: (n, total) => status('overwriteStatus', 'Spotify confirmed ' + count(n) + ' of ' + count(total) + ' entries.'),
      });
      updatePlaylist({ ...saved, totalTracks: uris.length });
      confirmation.close();
      notify('Updated “' + saved.name + '” on Spotify.');
    } catch (e) {
      phase = 'failed';
      if (e.playlistMayHaveChanged) updatePlaylist({ id: target.id, name: target.name, snapshotId: null, totalTracks: null });
      cancel.disabled = false;
      confirm.hidden = true;
      recheck.hidden = false;
      status('overwriteStatus', e.message, true);
      recheck.focus();
    }
  };
  recheck.onclick = () => { if (phase === 'failed') readDestination(confirmation); };
  mode.onchange = range.onchange = destination.onchange = nameInput.oninput = renderChooser;
  chooser.onclose = confirmation.onclose = discard;
  chooser.oncancel = confirmation.oncancel = (event) => { if (phase === 'writing' || phase === 'creating') event.preventDefault(); };
  return { open };
}
