# Socieva Content Board

Content planning and tracking board for Capital.com Arabic video production.
Live at **[board.socievastudio.com](https://board.socievastudio.com)**.

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Single-file `index.html` (HTML + CSS + JS, no build step) |
| Auth / token | Cloudflare Worker — client_credentials flow, exposes `/token` endpoint |
| Storage | Microsoft OneDrive via Graph API (Application permissions) |
| Hosting | GitHub Pages from `main` branch |

### Data files on OneDrive

| File | Purpose |
|------|---------|
| `Socieva Board/board-data.json` | Videos board cards + settings |
| `Socieva Board/carousels-data.json` | Carousels board cards |
| `Socieva Board/board-users.json` | User accounts + roles |
| `Socieva Board/thumbnails/` | Uploaded thumbnail images |
| `Socieva Board/videos/` | Uploaded video files |
| `Socieva Board/carousels/` | Carousel slide images |

---

## Local development

No build required. Open `index.html` directly in any browser.

1. Set `LOCAL_MODE = true` at the top of the `<script>` block.
2. Data is stored in `localStorage` under keys prefixed `sb_data_`.
3. OneDrive / Graph API calls are skipped entirely in local mode.

```js
// Near top of <script> in index.html
const LOCAL_MODE = true;   // ← flip to false for production
```

To reset local state, run in the browser console:

```js
Object.keys(localStorage).filter(k=>k.startsWith('sb_data_')).forEach(k=>localStorage.removeItem(k));
location.reload();
```

---

## Production deployment

### Prerequisites

- Cloudflare Worker deployed with `TOKEN_WORKER_URL` pointing to it.
- Microsoft Entra app registration with:
  - `Files.ReadWrite.All` (Application permission, admin-consented)
  - `Sites.ReadWrite.All` (Application permission, admin-consented)
- `LOCAL_MODE = false` in `index.html`.

### Deploy

```bash
git add index.html
git commit -m "your change"
git push origin main
# GitHub Pages auto-deploys in ~30 seconds
```

---

## Key constants (in index.html)

| Constant | Default | Purpose |
|----------|---------|---------|
| `LOCAL_MODE` | `false` | Bypass OneDrive, use localStorage |
| `TOKEN_WORKER_URL` | Cloudflare Worker URL | Issues Graph access tokens |
| `FOLDER_NAME` | `'Socieva Board'` | Root folder on OneDrive |
| `DATA_FILE` | `'board-data.json'` | Videos board data filename |
| `CAROUSELS_FILE` | `'carousels-data.json'` | Carousels board data filename |
| `DISPLAY_URL_TTL_MS` | `45 min` | How long file preview URLs stay fresh |
| `CARD_COLLAPSE_LIMIT` | `3` | Cards per column before "Show more" |

---

## Board modes

| Mode | Stages | File |
|------|--------|------|
| Videos | Script → Recording → Under editing → Ready to post → Posted | `board-data.json` |
| Carousels | Script → Working on → Ready to post → Posted | `carousels-data.json` |

---

## Roles

| Role | Capabilities |
|------|-------------|
| `admin` | Full access: add/edit/delete cards, manage users, view reports |
| `editor` | Add/edit cards, upload files |
| `viewer` | Read-only |

---

## Performance notes

- **Non-blocking load**: board renders immediately after `loadData()`; OneDrive preview URLs refresh in background via `refreshDisplayUrls()`.
- **URL TTL**: each card's display URL is only re-fetched after 45 minutes (`DISPLAY_URL_TTL_MS`).
- **Concurrency cap**: Graph requests are capped at 5 parallel calls (`mapLimit`).
- **ETag protection**: `saveData()` sends `If-Match: <eTag>` so concurrent saves by two users return HTTP 412 instead of silently overwriting each other.
- **Auto-refresh**: board data re-fetches every 2 minutes; renders only if content changed (snapshot comparison).

---

## Smoke test checklist

Run after any significant change before pushing to production.

- [ ] Login with valid credentials
- [ ] Login fails gracefully with wrong password
- [ ] Add new Video card, fill all fields, save
- [ ] Edit card, change stage via drag-and-drop
- [ ] Delete card → Undo restores it
- [ ] Stage filter pill filters correctly
- [ ] Search input filters by name
- [ ] Switch to Carousels board — Videos cards do not appear
- [ ] Switch back to Videos board — Carousels cards do not appear
- [ ] Upload thumbnail image → preview appears on card
- [ ] Download thumbnail button works
- [ ] Remove thumbnail → card shows empty placeholder
- [ ] Upload video → play button appears on card
- [ ] Report modal shows correct counts and percentages
- [ ] Period filter (Today / This week / This month) returns correct subset
- [ ] CSV export downloads a valid file
- [ ] Board auto-refreshes after 2 minutes without page reload
