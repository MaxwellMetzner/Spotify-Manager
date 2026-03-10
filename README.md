# IMPORTANT: Spotify Export Blocked

> NOTE: Exporting playlists to Spotify is currently blocked by Spotify (their platform/API).
> This is an external restriction and not caused by this app. See project issue tracker or
> release notes for updates and recommended workarounds.

# Spotify Manager (Electron)

Spotify Manager is a desktop Electron app for advanced playlist editing and analysis beyond native Spotify playlist tools.

## What it does

- First-run setup wizard walks through Spotify app creation and can generate `.env` automatically.
- Sign in with Spotify using OAuth Authorization Code + PKCE.
- Browse your playlist library.
- Load playlist tracks with expanded metadata, including:
  - Track details: title, artists, album, explicit, popularity, duration, added at.
  - Audio feature details: tempo/BPM, key, mode, danceability, energy, valence, loudness, acousticness, instrumentalness, speechiness, liveness, time signature.
  - Derived fields: Camelot key, release year, genre tags from artists, custom order index.
- Sort directly in-table by clicking column headers.
- Right-click headers for quick filters; active filters are shown as chips.
- Resize and reorder columns in the table.
- Select row(s) and remove songs from the working playlist view.
- Deduplicate exact duplicates and review near duplicates.
- Smart near-duplicate scoring and recommended keep candidate ranking.
- Shuffle tracks one or more passes.
- Mix Assist ordering with configurable weights in `config/mix-weights.json`.
- Multi-objective mix modes (`balanced`, `club-flow`, `energy-ramp`, `chill-arc`) and genre sequencing.
- Outlier detection with explainable score based on audio profile, era deviation, and genre rarity.
- Filter tracks by metadata and create a new playlist from filtered results.
- Undo/redo action history.
- Transition diagnostics for adjacent tracks in current order (Mix tab).
- Bulk operations across selected playlists:
  - `Mix Assist Copy`: creates a new playlist per selected source playlist, ordered by current mix settings.
  - `Filtered Copy`: creates a new playlist per selected source playlist using current filters.

## Metadata expectations

- Spotify developer access is required to authenticate and create/export playlists.
- Spotify's current API responses may not include all historical metadata fields consistently for every track.
- For richer metadata workflows (for example CSV imports produced by Exportify), use:
  - `https://exportify.net/` to export playlist CSVs.
  - The app's CSV import to load that metadata into the local workflow.

## Spotify API research notes

This app uses Spotify Web API and OAuth2 flows based on Spotify docs:

- Use Authorization Code with PKCE for desktop apps where client secret should not be embedded.
- Required scopes:
  - `playlist-read-private`
  - `playlist-read-collaborative`
  - `playlist-modify-private`
  - `playlist-modify-public`
  - `user-read-private`
- Core endpoints used:
  - `GET /me`
  - `GET /me/playlists`
  - `GET /playlists/{playlist_id}`
  - `GET /playlists/{playlist_id}/items`
  - `GET /audio-features?ids=...`
  - `GET /artists?ids=...`
  - `PUT /playlists/{playlist_id}/items` and `POST /playlists/{playlist_id}/items`
  - `POST /me/playlists`

## Setup

1. Create a Spotify app in the Spotify Developer Dashboard.
1. Add redirect URI to your Spotify app settings (must match exactly):
  - `http://127.0.0.1:3000/api/auth/spotify/callback`
1. Create `.env` from `.env.example` and fill values.
1. Install dependencies:

```powershell
npm install
```

1. Run:

```powershell
npm start
```

## Testing

Run algorithm tests:

```powershell
npm test
```

Tests are located in `Agents/test-analysis.mjs` per project instruction.

## Notes

- Spotify may return null for some audio fields on certain tracks.
- This project is local-first; no backend server is required.
- Export creates a new playlist in Spotify using the current visible table order.
