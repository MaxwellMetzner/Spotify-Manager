import { $, escapeHtml as html, notify, readObject, showDialog } from './ui.js';

export function bindLibrary({ load, showTracks }) {
  let playlists = [], account = null, current = null, csvName = '', folderTarget = null;
  let folders = {}, collapsed = new Set();
  const storageKey = () => 'spotifyManager.localFolders.v1.' + account;
  function playlistRow(playlist) {
    const image = playlist.imageUrl?.startsWith('https://')
      ? `<img class="playlist-thumb" src="${html(playlist.imageUrl)}" loading="lazy" decoding="async" alt="">`
      : '<span class="playlist-thumb thumb-fallback" aria-hidden="true">♫</span>';
    return `<div class="playlist-row"><button data-playlist="${html(playlist.id)}" title="${html(playlist.name)}" aria-current="${playlist.id === current}" ${playlist.canLoad === false ? 'disabled' : ''}>${image}<span class="playlist-name">${html(playlist.name)}</span><span class="playlist-count">${Number.isFinite(playlist.totalTracks) ? playlist.totalTracks : ''}</span></button><button data-folder="${html(playlist.id)}" title="Move to a local folder" aria-label="Organize ${html(playlist.name)}">⋯</button></div>`;
  }
  function render() {
    const query = $('playlistSearch').value.trim().toLowerCase();
    const groups = new Map(), loose = [];
    for (const playlist of playlists) {
      const folder = folders[playlist.id] || '';
      if (!(playlist.name + ' ' + folder).toLowerCase().includes(query)) continue;
      if (!folder) loose.push(playlist);
      else {
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push(playlist);
      }
    }
    const parts = [];
    if (csvName && csvName.toLowerCase().includes(query)) parts.push(`<div class="playlist-row"><button data-active-csv aria-current="true"><span class="playlist-thumb thumb-fallback" aria-hidden="true">♫</span><span class="playlist-name">${html(csvName)}</span></button></div>`);
    for (const name of [...groups.keys()].sort((a,b) => a.localeCompare(b))) {
      parts.push(`<details class="folder-group" data-name="${html(name)}" ${query || !collapsed.has(name) ? 'open' : ''}><summary>${html(name)} <span class="playlist-count">${groups.get(name).length}</span></summary>${groups.get(name).map(playlistRow).join('')}</details>`);
    }
    parts.push(...loose.map(playlistRow));
    $('playlistList').innerHTML = parts.join('') || `<p class="library-empty">${query ? 'No matching playlists.' : account ? 'No playlists in this library.' : 'Connect Spotify to browse your playlists.'}</p>`;
  }
  $('playlistSearch').oninput = render;
  $('playlistList').addEventListener('toggle', ({ target }) => {
    if (!target.matches('.folder-group') || !target.isConnected || $('playlistSearch').value) return;
    target.open ? collapsed.delete(target.dataset.name) : collapsed.add(target.dataset.name);
  }, true);
  $('playlistList').onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-active-csv') || (button.dataset.playlist && button.dataset.playlist === current)) return showTracks();
    if (button.dataset.playlist) return load(button.dataset.playlist);
    folderTarget = playlists.find((p) => p.id === button.dataset.folder);
    if (!folderTarget || !account) return;
    const select = $('folderSelect');
    select.replaceChildren(new Option('Unfiled playlists', ''));
    for (const name of [...new Set(Object.values(folders))].sort()) select.add(new Option(name, 'folder:' + name));
    select.add(new Option('Create a local folder…', 'new'));
    select.value = folders[folderTarget.id] ? 'folder:' + folders[folderTarget.id] : '';
    $('folderPlaylist').textContent = folderTarget.name;
    $('folderName').value = '';
    $('newFolderField').hidden = true;
    showDialog('folderDialog');
  };
  $('folderSelect').onchange = () => { $('newFolderField').hidden = $('folderSelect').value !== 'new'; if (!$('newFolderField').hidden) $('folderName').focus(); };
  $('folderForm').onsubmit = (event) => {
    event.preventDefault();
    const choice = $('folderSelect').value;
    const name = choice === 'new' ? $('folderName').value.trim() : choice.slice(7);
    if (choice === 'new' && !name) { $('folderName').focus(); return; }
    const next = { ...folders };
    if (name) next[folderTarget.id] = name; else delete next[folderTarget.id];
    try { localStorage.setItem(storageKey(), JSON.stringify(next)); }
    catch { return notify('This browser could not save the folder.', true); }
    folders = next; collapsed.delete(name);
    $('folderDialog').close(); render();
  };
  render();
  return {
    setAccount(id) {
      if (id === account) return;
      playlists = []; account = id; collapsed.clear();
      folders = id ? readObject(storageKey()) : {};
      $('playlistSearch').value = ''; render();
    },
    setPlaylists(next) { playlists = next; render(); },
    select(id, name) { current = id; csvName = name || ''; render(); },
  };
}
