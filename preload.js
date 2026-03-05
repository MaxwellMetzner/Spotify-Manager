const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotifyManager', {
  authState: () => ipcRenderer.invoke('auth:state'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('spotify:user'),
  getPlaylists: () => ipcRenderer.invoke('spotify:playlists'),
  getPlaylistDetails: (playlistId) => ipcRenderer.invoke('spotify:playlist-details', playlistId),
  reorderPlaylist: (playlistId, trackUris) =>
    ipcRenderer.invoke('spotify:reorder-playlist', { playlistId, trackUris }),
  createPlaylist: (payload) => ipcRenderer.invoke('spotify:create-playlist', payload),
  request: (method, path, query, body) =>
    ipcRenderer.invoke('spotify:request', { method, path, query, body }),
  getMixWeights: () => ipcRenderer.invoke('config:mix-weights'),
});
