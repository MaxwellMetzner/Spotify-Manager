import { $, escapeHtml as html } from './ui.js';

const fallbackCover = '<span class="playlist-thumb thumb-fallback" aria-hidden="true">♫</span>';

export function bindLibrary({ load, showTracks }) {
  let playlists = [], account = null, current = null, csvName = '';
  const list = $('playlistList');

  function playlistRow(playlist) {
    const image = playlist.imageUrl?.startsWith('https://')
      ? `<img class="playlist-thumb" src="${html(playlist.imageUrl)}" loading="lazy" decoding="async" alt="">`
      : fallbackCover;
    const target = playlist.id ? `data-playlist="${html(playlist.id)}"` : 'data-active-csv';
    const count = Number.isFinite(playlist.totalTracks) ? `<span class="playlist-count">${playlist.totalTracks}</span>` : '';
    return `<button type="button" class="playlist-row" ${target} title="${html(playlist.name)}" aria-current="${!playlist.id || playlist.id === current}" ${playlist.canLoad === false ? 'disabled' : ''}>${image}<span class="playlist-name">${html(playlist.name)}</span>${count}</button>`;
  }

  function render() {
    const query = $('playlistSearch').value.trim().toLowerCase();
    const rows = playlists.filter((p) => p.name.toLowerCase().includes(query)).map(playlistRow);
    if (csvName && csvName.toLowerCase().includes(query)) rows.unshift(playlistRow({ name: csvName }));
    const empty = query ? 'No matching playlists.' : account ? 'No playlists in this library.' : 'Connect Spotify to browse your playlists.';
    list.innerHTML = rows.join('') || `<p class="library-empty">${empty}</p>`;
  }
  $('playlistSearch').oninput = render;
  list.addEventListener('error', ({ target }) => {
    if (target.matches('img.playlist-thumb')) target.outerHTML = fallbackCover;
  }, true);
  list.onclick = (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-active-csv') || button.dataset.playlist === current) showTracks();
    else load(button.dataset.playlist);
  };
  render();
  return {
    setAccount(id) {
      if (id === account) return;
      playlists = []; account = id;
      $('playlistSearch').value = ''; render();
    },
    setPlaylists(next) { playlists = next; render(); },
    select(id, name) { current = id; csvName = name || ''; render(); },
  };
}
