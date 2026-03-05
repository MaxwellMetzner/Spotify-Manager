# Spotify Manager - Agent Context

## Project Goal

Desktop Electron app to give users advanced control over Spotify playlists beyond native Spotify tooling.

## Architecture

- `main.js`: Electron main process, window bootstrapping, IPC wiring.
- `preload.js`: Secure API bridge from renderer to main process.
- `src/main/auth.js`: Spotify OAuth (Authorization Code + PKCE), token persistence, refresh.
- `src/main/spotifyApi.js`: Spotify data calls, metadata hydration, playlist reorder/create operations.
- `src/shared/analysis.js`: Shared playlist algorithms (dedupe, shuffle, mix assist, outliers, sort, filters).
- `src/renderer/index.html`: UI shell for playlist browser, tools, table, and results panels.
- `src/renderer/styles.css`: Visual design system and responsive layout.
- `src/renderer/app.js`: Frontend state, events, rendering, and action orchestration.
- `config/mix-weights.json`: Tunable Mix Assist attribute weights.

## Feature Mapping

1. Deduplication

- Detects exact duplicates by normalized title + primary artist.
- Flags near duplicates by base title (remix/edit/live tags stripped) + artist.
- Auto-dedupe action keeps highest-popularity version from exact groups.
- Includes an interactive near-duplicate modal where users uncheck versions to remove per group.

1. Shuffle

- Multi-pass Fisher-Yates shuffle (`passes` input).

1. Mix Assist

- Weighted transition cost by BPM, Camelot, energy, danceability, valence, loudness, instrumentalness, acousticness, speechiness, liveness, genre similarity.
- Greedy nearest-neighbor ordering from energetic/popular seed track.
- Weights loaded from `config/mix-weights.json` into editable JSON UI block.

1. Outliers

- Composite outlier score = audio z-score component + genre rarity + era deviation.
- UI displays score and reason hints per top outlier tracks.

1. Filter To New Playlist

- Supports contains and numeric/year range filters.
- Creates a new private playlist with currently filtered tracks.

## Metadata Coverage

Table includes playlist custom order, title, artist, album, added timestamp, BPM, Camelot, energy, danceability, valence, tempo, loudness, acousticness, instrumentalness, speechiness, liveness, key/mode, genre, release year/date, explicit flag, popularity, ISRC, URI, and analysis availability.

## Security/UX Notes

- Uses PKCE to avoid storing Spotify client secret in app package.
- Tokens persist to `.spotify-tokens.json` and are refreshable.
- External Spotify auth opens in system browser; callback handled locally.
- Renderer cannot directly access Node APIs (context isolation true).
- Metadata table now uses row virtualization for large playlists to keep UI responsive.
- Filter and weight presets persist locally in browser storage (per machine/user profile).

## Tests

- `Agents/test-analysis.mjs` validates algorithm behavior for duplicates, shuffle, filters, mix assist ordering, and outlier ranking output.

## Next Candidate Improvements

- Add dedicated near-duplicate resolution modal for keep-A/keep-B choices.
- Add confidence/availability indicators for missing audio feature data.
- Add export/import presets for filter sets and weight profiles.
- Add pagination/virtualized table for very large playlists.
