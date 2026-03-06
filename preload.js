const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotifyManager', {
  authState: () => ipcRenderer.invoke('auth:state'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('spotify:user'),
  getPlaylists: () => ipcRenderer.invoke('spotify:playlists'),
  getPlaylistDetails: (playlistId) => ipcRenderer.invoke('spotify:playlist-details', playlistId),
  getPlaylistDetailsWithProgress: (playlistId) =>
    ipcRenderer.invoke('spotify:playlist-details-with-progress', playlistId),
  reorderPlaylist: (playlistId, trackUris) =>
    ipcRenderer.invoke('spotify:reorder-playlist', { playlistId, trackUris }),
  createPlaylist: (payload) => ipcRenderer.invoke('spotify:create-playlist', payload),
  request: (method, path, query, body) =>
    ipcRenderer.invoke('spotify:request', { method, path, query, body }),
  getMixWeights: () => ipcRenderer.invoke('config:mix-weights'),
  getSetupState: () => ipcRenderer.invoke('setup:state'),
  writeSetupEnv: (payload) => ipcRenderer.invoke('setup:write-env', payload),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  onPlaylistProgress: (listener) => {
    const wrapped = (_, payload) => listener(payload);
    ipcRenderer.on('spotify:playlist-progress', wrapped);
    return () => ipcRenderer.off('spotify:playlist-progress', wrapped);
  },
});
