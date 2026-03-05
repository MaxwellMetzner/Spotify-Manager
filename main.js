const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  getAuthState,
  beginSpotifyLogin,
  logout,
  spotifyRequest,
  loadCurrentUser,
} = require('./src/main/auth');
const {
  fetchCurrentUserPlaylists,
  fetchPlaylistWithMetadata,
  reorderPlaylist,
  createPlaylistFromTracks,
} = require('./src/main/spotifyApi');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#0d1f22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Spotify Manager',
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('auth:state', async () => getAuthState());

  ipcMain.handle('auth:login', async () => {
    await beginSpotifyLogin();
    return getAuthState();
  });

  ipcMain.handle('auth:logout', async () => {
    logout();
    return getAuthState();
  });

  ipcMain.handle('spotify:user', async () => loadCurrentUser());

  ipcMain.handle('spotify:playlists', async () => fetchCurrentUserPlaylists());

  ipcMain.handle('spotify:playlist-details', async (_, playlistId) => {
    return fetchPlaylistWithMetadata(playlistId);
  });

  ipcMain.handle('spotify:reorder-playlist', async (_, payload) => {
    return reorderPlaylist(payload.playlistId, payload.trackUris);
  });

  ipcMain.handle('spotify:create-playlist', async (_, payload) => {
    return createPlaylistFromTracks(payload);
  });

  ipcMain.handle('spotify:request', async (_, payload) => {
    return spotifyRequest(payload.method, payload.path, payload.query, payload.body);
  });

  ipcMain.handle('config:mix-weights', async () => {
    const configPath = path.join(__dirname, 'config', 'mix-weights.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
