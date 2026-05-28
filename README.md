# Socieva Content Board

Content planning and tracking board for Capital.com Arabic video production.
Live at **[board.socievastudio.com](https://board.socievastudio.com)**.

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | `index.html` + `styles.css` + `app.js` (no build step) |
| Auth / token | Cloudflare Worker — client_credentials flow, exposes `/token` endpoint |
| Storage | Microsoft OneDrive via Graph API (Application permissions) |
| Hosting | GitHub Pages from `main` branch |

### File structure

```
socieva-board-main/
├── index.html    # HTML skeleton (381 lines — head + body structure only)
├── styles.css    # All CSS (304 lines)
├── app.js        # All JS logic (1709 lines)
├── CNAME         # board.socievastudio.com
└── README.md
```

### Data files on OneDrive

| File | Purpose |
|------|---------|
| `Socieva-Board/board-data.json` | Videos board cards + settings |
| `Socieva-Board/carousels-data.json` | Carousels board cards |
| `Socieva-Board/users.json` | User accounts + roles |
| `Socieva-Board/thumbnails/` | Uploaded thumbnail images |
| `Socieva-Board/videos/` | Uploaded video files |
| `Socieva-Board/carousels/` | Carousel slide images |

> **Note:** The OneDrive folder name is `Socieva-Board` (with a hyphen), matching `FOLDER_NAME` in `app.js`.

---

## Local development

No build required. Open `index.html` directly in any browser.

### Enable local mode

Local mode bypasses OneDrive entirely and stores everything in `localStorage`.
Activate it by running this once in the browser console:

```js
localStorage.setItem('sb_local_mode', '1');
location.reload();
```

Deactivate with:

```js
localStorage.removeItem('sb_local_mode');
location.reload();
```

`LOCAL_MODE` is **not** a hardcoded constant — it is read from localStorage on every page load:

```js
// app.js — line 12
const LOCAL_MODE_KEY = 'sb_local_mode';
const LOCAL_MODE = localStorage.getItem(LOCAL_MODE_KEY) === '1';
```

### Reset local data

```js
Object.keys(localStorage)
  .filter(k => k.startsWith('sb_data_'))
  .forEach(k => localStorage.removeItem(k));
location.reload();
```

---

## Production deployment

### Prerequisites

- Cloudflare Worker deployed with URL set as `TOKEN_WORKER_URL` in `app.js`.
- Microsoft Entra app registration with:
  - `Files.ReadWrite.All` (Application permission, admin-consented)
  - `Sites.ReadWrite.All` (Application permission, admin-consented)
- `sb_local_mode` **not** set in the browser's localStorage.

### Deploy

```bash
git add index.html styles.css app.js
git commit -m "your change"
git push origin main
# GitHub Pages auto-deploys in ~30 seconds
```

---

## Key constants (in app.js)

| Constant | Value | Purpose |
|----------|-------|---------|
| `LOCAL_MODE_KEY` | `'sb_local_mode'` | localStorage key for local-mode toggle |
| `TOKEN_WORKER_URL` | Cloudflare Worker URL | Issues Graph access tokens |
| `FOLDER_NAME` | `'Socieva-Board'` | Root folder name on OneDrive |
| `DATA_FILE` | `'board-data.json'` | Videos board data filename |
| `CAROUSELS_FILE` | `'carousels-data.json'` | Carousels board data filename |
| `USERS_FILE` | `'users.json'` | User accounts filename |
| `DISPLAY_URL_TTL_MS` | `45 min` | How long file preview URLs stay fresh before re-fetching |
| `CARD_COLLAPSE_LIMIT` | `3` | Cards per column before "Show more" appears |
| `SESSION_KEY` | `'sb_session_v2'` | localStorage key for the active session |
| `SESSION_DURATION_MS` | `7 days` | Session lifetime before auto-logout |

---

## Board modes

| Mode | Stages | Data file |
|------|--------|-----------|
| Videos | Script → Recording → Under editing → Ready to post → Posted | `board-data.json` |
| Carousels | Script → Working on → Ready to post → Posted | `carousels-data.json` |

---

## Roles

| Role | Capabilities |
|------|-------------|
| `admin` | Full access: add/edit/delete cards, manage users, view reports, change settings |
| `user` | Add/edit cards, upload files, view reports |

> Role enforcement is UI-side only. Backend enforcement (Worker/API proxy) is planned for a later phase.

---

## Performance notes

- **Non-blocking load**: board renders immediately after `loadData()`; OneDrive preview URLs refresh in background via `refreshDisplayUrls()`.
- **URL TTL**: each card's display URL is only re-fetched after 45 minutes (`DISPLAY_URL_TTL_MS`).
- **Concurrency cap**: Graph requests are capped at 5 parallel calls via `mapLimit(arr, 5, fn)`.
- **ETag protection**: `saveData()` sends `If-Match: <eTag>` so concurrent saves by two users return HTTP 412 instead of silently overwriting each other.
- **Auto-refresh**: board data re-fetches every 2 minutes; re-renders only if content changed (snapshot comparison).
- **Debounce**: search, channel, and segment filter inputs are debounced at 200 ms.

---

## Smoke test checklist

Run after any significant change before pushing to production.

- [ ] Login with valid credentials
- [ ] Login fails gracefully with wrong password
- [ ] First-login password change flow works
- [ ] Add new Video card, fill all fields, save
- [ ] Edit card, change stage via drag-and-drop
- [ ] Delete card → Undo restores it
- [ ] Stage filter pill filters correctly
- [ ] Search input filters by name / channel / script
- [ ] Switch to Carousels board — Videos cards do not appear
- [ ] Switch back to Videos board — Carousels cards do not appear
- [ ] Upload thumbnail image → preview appears on card
- [ ] Download thumbnail button works
- [ ] Remove thumbnail → card shows empty placeholder
- [ ] Upload video → play button appears on card
- [ ] Carousel: upload multiple slides, Download all works
- [ ] Report modal shows correct counts and percentages
- [ ] Period filter (Today / This week / This month) returns correct subset
- [ ] CSV export downloads a valid file
- [ ] Board auto-refreshes after 2 minutes without page reload
