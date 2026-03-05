# Spotify Manager (Electron)

Spotify Manager is a desktop Electron app for advanced playlist editing and analysis beyond native Spotify playlist tools.

## What it does

- Sign in with Spotify using OAuth Authorization Code + PKCE.
- Browse your playlist library.
- Load playlist tracks with expanded metadata, including:
  - Track details: title, artists, album, explicit, popularity, duration, ISRC, added at.
  - Audio feature details: tempo/BPM, key, mode, danceability, energy, valence, loudness, acousticness, instrumentalness, speechiness, liveness, time signature.
  - Derived fields: Camelot key, release year, genre tags from artists, custom order index.
- Sort by any metadata field, including custom order.
- Deduplicate exact duplicates and review near duplicates.
- Shuffle tracks one or more passes.
- Mix Assist ordering with configurable weights in `config/mix-weights.json`.
- Outlier detection with explainable score based on audio profile, era deviation, and genre rarity.
- Filter tracks by metadata and create a new playlist from filtered results.

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
  - `GET /playlists/{playlist_id}/tracks`
  - `GET /audio-features?ids=...`
  - `GET /artists?ids=...`
  - `PUT /playlists/{playlist_id}/tracks` and `POST /playlists/{playlist_id}/tracks`
  - `POST /users/{user_id}/playlists`

## Setup

1. Create a Spotify app in the Spotify Developer Dashboard.
1. Add redirect URI to your Spotify app settings (must match exactly):
   - `http://127.0.0.1:8888/callback`
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
