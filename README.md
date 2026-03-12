# Spotify Manager

Spotify Manager is a static browser app for advanced Spotify playlist editing and analysis. It is designed to run on GitHub Pages or any other static host without an application server.

## Hosting Model

- No backend server is required.
- Spotify OAuth runs directly in the browser with Authorization Code + PKCE.
- Setup values, tokens, and granted scopes are stored in browser storage.
- The app can run from GitHub Pages, Netlify, Cloudflare Pages, or a local static server.

## What it does

- First-run setup wizard walks through Spotify app creation and stores your Client ID locally in the browser.
- Sign in with Spotify using OAuth Authorization Code + PKCE.
- Browse your playlist library.
- Load playlist tracks with expanded metadata, including:
  - Track details: title, artists, album, explicit, popularity, duration, added at.
  - Audio feature details: tempo/BPM, key, mode, danceability, energy, valence, loudness, acousticness, instrumentalness, speechiness, liveness, time signature.
  - Local workflow fields: custom order index and CSV-provided genre tags.
- Sort directly in-table by clicking column headers.
- Right-click headers for quick filters; active filters are shown as chips.
- Resize and reorder columns in the table.
- Select rows and remove songs from the working playlist view.
- Deduplicate exact duplicates and review near duplicates.
- Shuffle tracks one or more passes.
- Mix Assist ordering with configurable weights in `config/mix-weights.json`.
- Genre sequencing for CSV-backed workflows.
- Outlier detection with explainable scoring based on audio profile and genre rarity.
- Filter tracks by metadata and create a new playlist from filtered results.
- Undo and redo action history.
- Transition diagnostics for adjacent tracks in the current order.

## Metadata expectations

- Spotify developer access is required to authenticate and create or export playlists.
- Spotify API responses may not include every metadata field for every track.
- For richer metadata workflows, export a playlist CSV from `https://exportify.net/` and import it into the app.

## Spotify API scopes

The app uses these Spotify Web API scopes:

- `playlist-read-private`
- `playlist-read-collaborative`
- `playlist-modify-private`
- `playlist-modify-public`
- `user-read-private`

## Local preview

Run a local static server:

```powershell
npm start
```

This serves the repo at `http://127.0.0.1:3000/`.

## GitHub Pages deployment

This repo includes a GitHub Actions workflow that publishes the repository directly to GitHub Pages.

1. Push the repository to GitHub.
1. Open `Settings` -> `Pages` in the GitHub repo.
1. Set `Source` to `GitHub Actions`.
1. Push to `main`, or run the `Deploy GitHub Pages` workflow manually.
1. Wait for the deployment to finish.
1. Open the site at `https://<your-user>.github.io/<your-repo>/`.
1. In Spotify Developer Dashboard, add this exact redirect URI:

```text
https://<your-user>.github.io/<your-repo>/api/auth/spotify/callback
```

1. Open the deployed site.
1. Click `Setup Spotify Config`.
1. Paste your Spotify Client ID and save.

## Manual static deployment

If you want to deploy without GitHub Actions, publish the repository as a static site and keep these paths intact:

- `index.html`
- `src/renderer/`
- `api/auth/spotify/callback/`
- `config/`

## Testing

Run the test suite with Node:

```powershell
npm test
```

## Deployment notes

- GitHub Pages serves project sites under a path prefix like `/Spotify-Manager/`; the app now resolves redirect and callback URLs relative to that prefix.
- Tabulator is loaded from jsDelivr CDN so `node_modules` does not need to be deployed.
- The callback route is a real static page at `api/auth/spotify/callback/index.html`, so Spotify can redirect directly back into the app.

## Notes

- Spotify may return null for some audio fields on certain tracks.
- Export creates a new playlist in Spotify using the current visible table order.
