# Spotify Manager - Agent Context

## Project Goal

Browser-based webapp to give users advanced control over Spotify playlists beyond native Spotify tooling. Originally an Electron desktop app, migrated to a static webapp in v0.2.0.

## Architecture

- `index.html`: Root webapp entry point. Loads Tabulator, analysis.js, and app.js (ES module).
- `src/auth.js`: Browser PKCE authentication using Web Crypto API, localStorage for tokens/config, sessionStorage for PKCE state.
- `src/spotifyApi.js`: Browser Spotify API layer (playlists, audio features, artists, reorder, create). Imports `spotifyRequest` from auth.js.
- `src/shared/analysis.js`: Shared playlist algorithms (dedupe, shuffle, mix assist, outliers, sort, filters). UMD module, exposed via `window.PlaylistAnalysis`.
- `src/renderer/styles.css`: Visual design system and responsive layout.
- `src/renderer/app.js`: Frontend state, events, rendering, and action orchestration. ES module importing from `../auth.js` and `../spotifyApi.js`.
- `config/mix-weights.json`: Tunable Mix Assist attribute weights fetched at startup.

### Legacy Electron Files (no longer used)

- `main.js`, `preload.js`, `src/main/auth.js`, `src/main/spotifyApi.js`: Still present in repo but unused by the webapp.
- `src/renderer/index.html`: Superseded by root `index.html`.

## Feature Mapping

1. Deduplication

- Detects exact duplicates by normalized title + primary artist.
- Flags near duplicates by base title (remix/edit/live tags stripped) + artist.
- Auto-dedupe action keeps highest-popularity version from exact groups.
- Includes an interactive near-duplicate modal where users uncheck versions to remove per group.
- Near-duplicate groups now include smart scoring (title similarity, duration delta, ISRC, popularity) and recommended keep candidates.

1. Shuffle

- Single-pass Fisher-Yates shuffle (button on Home tab).

1. Mix Assist

- Weighted transition cost by BPM, Camelot, energy, danceability, valence, loudness, instrumentalness, acousticness, speechiness, liveness, genre similarity.
- Greedy nearest-neighbor ordering from energetic/popular seed track.
- Weights loaded from `config/mix-weights.json` into editable JSON UI block.
- Supports mix modes (`balanced`, `club-flow`, `energy-ramp`, `chill-arc`) and genre cluster sequencing mode.

1. Outliers

- Composite outlier score = audio z-score component + genre rarity + era deviation.
- UI displays score and reason hints per top outlier tracks.
- Includes direct remove-top-outliers action.

1. Filter To New Playlist

- Supports contains and numeric/year range filters.
- Creates a new private playlist with currently filtered tracks.

## Metadata Coverage

Table includes playlist custom order, title, artist, album, added timestamp, BPM, Camelot, energy, danceability, valence, tempo, loudness, acousticness, instrumentalness, speechiness, liveness, key/mode, genre, release year/date, explicit flag, popularity, ISRC, URI, and analysis availability.

## Security/UX Notes

- Uses PKCE to avoid storing Spotify client secret (no backend needed).
- Tokens persist to localStorage (`spotifyManager.tokens`) and support automatic refresh.
- Setup config (Client ID, redirect URI) stored in localStorage (`spotifyManager.setup`).
- Weight presets stored in localStorage (`spotifyManager.weightPresets.v2`).
- Served via `npx serve . -l 3000` (or any static file server).
- Metadata table uses row virtualization for large playlists.
- Filter and weight presets persist locally in browser storage.
- First-run setup wizard guides Spotify app creation and stores Client ID + redirect URI in localStorage.
- Setup button on main page only shown when Client ID is not configured.
- Selection mode: single-click selects one row; shift/ctrl for range/multi-select.
- Spotify mode shows limited default columns (order, title, artists, album, album date, added at, added by, duration); CSV mode shows all available columns.
- Loading overlay displayed while playlist data is being fetched.
- Column picker defers visibility changes until modal close to avoid lag.
- Ribbon tabs use pointer cursor for better affordance.
- Playlist list and transition/dedupe/outlier results fill their containers.
- Filter popup uses deferred execution to avoid immediate close on header right-click.
- Operation history supports undo/redo and dry-run diff preview before committing playlist writes.
- Transition diagnostics panel reports adjacent-track blend metrics.
- Bulk operations can run current strategy across multiple playlists and create output playlists.
- Playlist metadata loading reports staged progress updates in the UI.
- Main workflow UI is organized as a ribbon-style tabbed interface (`Home`, `Mix`, `Analyze`) with table-first layout.

## Tests

- `Agents/test-analysis.mjs`: Validates algorithm behavior for duplicates, shuffle, filters, mix assist ordering, outlier ranking, genre sequencing, and transition diagnostics.
- `Agents/test-auth.mjs`: Unit tests for browser auth module (setup state, token storage, PKCE helpers, spotifyRequest).
- `Agents/test-spotifyApi.mjs`: Unit tests for browser API module (playlist fetching, audio features, reorder, create).

## Next Candidate Improvements

- Remove legacy Electron files (main.js, preload.js, src/main/) once webapp is fully validated.
- Add confidence/availability indicators for missing audio feature data.
- Add export/import presets for filter sets and weight profiles.
