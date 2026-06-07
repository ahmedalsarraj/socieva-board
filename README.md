# Content Board

Internal content planning board for Capital.com Arabic production.

Live domain:
`board.socievastudio.com`

## Architecture

| Layer | Technology |
| --- | --- |
| Frontend | Static `index.html`, `styles.css`, `app.js` |
| Hosting | GitHub Pages |
| Auth | Firebase Authentication, Email/Password |
| Database | Cloud Firestore |
| File storage | Firebase Storage |
| Legacy fallback | OneDrive / Microsoft Graph remains in code for migration and rollback |

No build step is required.

## Firebase Project

Project ID:
`content-board-capital`

Storage bucket:
`content-board-capital.firebasestorage.app`

Main Firestore documents:

| Path | Purpose |
| --- | --- |
| `board/videos` | Video board cards and settings |
| `board/carousels` | Carousel board cards |
| `users/{uid}` | User profile, role, and active flag |

Storage paths:

| Path | Purpose |
| --- | --- |
| `uploads/thumbnails/` | Thumbnail and carousel image uploads |
| `uploads/videos/` | Final video uploads |
| `system/` | Reserved for admin/system files |

## Users And Roles

Users must exist in both Firebase Authentication and Firestore.

1. Create the login account in Firebase Authentication.
2. Copy the Firebase Auth UID.
3. Create a Firestore document at `users/{uid}`.

Example:

```js
{
  email: "user@example.com",
  displayName: "User Name",
  role: "user",
  active: true
}
```

Roles:

| Role | Capabilities |
| --- | --- |
| `admin` | Manage board, settings, reports, roles, and active users |
| `user` | Use the board and upload/download files |

Set `active: false` to disable access without deleting the Firebase Auth account.

Adding new users is done from Firebase Console. Role changes can be done either from Firebase Console or from board Settings by an admin.

## Local Development

Start a local static server:

```bash
python3 -m http.server 4173
```

Open:

```text
http://localhost:4173
```

Firebase Auth must allow `localhost` as an authorized domain. Firebase usually includes it by default.

### Local Mode

Local mode bypasses Firebase and OneDrive, and stores test data in `localStorage`.

Enable:

```js
localStorage.setItem('sb_local_mode', '1');
location.reload();
```

Disable:

```js
localStorage.removeItem('sb_local_mode');
location.reload();
```

Reset local test data:

```js
Object.keys(localStorage)
  .filter(k => k.startsWith('sb_data_'))
  .forEach(k => localStorage.removeItem(k));
location.reload();
```

## Storage Provider Switch

Firebase is the default provider.

To force legacy OneDrive fallback in a browser:

```js
localStorage.setItem('sb_storage_provider', 'onedrive');
location.reload();
```

To return to Firebase:

```js
localStorage.removeItem('sb_storage_provider');
location.reload();
```

## Deploy

GitHub Pages deploys from `main`.

```bash
git add index.html styles.css app.js README.md
git commit -m "Connect board to Firebase"
git push origin main
```

After deploy, confirm Firebase Authentication authorized domains include:

```text
board.socievastudio.com
```

Firebase Console path:
Authentication -> Settings -> Authorized domains

## Smoke Test

Run this after deployment:

- Login as admin.
- Open Settings and confirm users/roles are visible.
- Login as a normal user in another browser/incognito window.
- Confirm normal user cannot see Settings.
- Create a new video card.
- Upload a small thumbnail.
- Save the card.
- Confirm Firestore has `board/videos`.
- Confirm Storage has a file under `uploads/thumbnails/`.
- Download the uploaded thumbnail from the board.
- Switch to Carousels and back to Videos.
- Confirm Reports opens and counts render.

## Migration Status

New data and new uploads use Firebase.

Existing OneDrive files are not migrated automatically. A migration tool is still needed to:

1. Read legacy OneDrive board data.
2. Download each legacy file.
3. Upload it to Firebase Storage.
4. Rewrite card file references.
5. Save the migrated cards to Firestore.

Do not delete OneDrive data until migration is verified.
