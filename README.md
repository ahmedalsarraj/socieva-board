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

No build step is required.

## Firebase Project

Project ID:
`content-board-capital`

Storage bucket:
`content-board-capital.firebasestorage.app`

Main Firestore documents:

| Path | Purpose |
| --- | --- |
| `board/videos` | Video board metadata and settings |
| `board/videos/cards/{cardId}` | One video card per document |
| `board/carousels` | Carousel board metadata |
| `board/carousels/cards/{cardId}` | One carousel card per document |
| `board/socialAccounts` | Non-secret posting account metadata, admin-only |
| `board/postingQueue/items/{jobId}` | Posting queue and history, admin-only |
| `users/{uid}` | User profile, role, and active flag |

Storage paths:

| Path | Purpose |
| --- | --- |
| `uploads/thumbnails/` | Thumbnail and carousel image uploads |
| `uploads/videos/` | Final video uploads |

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

The app is Firebase-only. Local development still talks to the configured Firebase project, so test with non-production content when possible.

## Security Rules

Source-controlled rules live in:

```text
firestore.rules
storage.rules
firebase.json
```

Deploy rules from the Firebase CLI after review:

```bash
firebase deploy --only firestore:rules,storage
```

Keep `board/socialAccounts` and `board/postingQueue` admin-only. Board cards are stored as individual documents under `board/videos/cards` and `board/carousels/cards` so a single edit does not rewrite the whole board. Platform access tokens must not be stored in Firestore or frontend code.

## Posting

The browser only creates posting jobs and saves non-secret account metadata. Real publishing to Instagram, YouTube, or TikTok must run through Cloud Functions or another backend service that stores API tokens as backend secrets.

## Deploy

GitHub Pages deploys from `main`.

```bash
git add index.html styles.css app.js README.md firestore.rules storage.rules firebase.json
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
- Confirm Firestore has `board/videos` and `board/videos/cards/{cardId}`.
- Confirm Storage has a file under `uploads/thumbnails/`.
- Download the uploaded thumbnail from the board.
- Switch to Carousels and back to Videos.
- Confirm Reports opens and counts render.

## Migration Status

New data and new uploads use Firebase. Legacy data should stay archived until migrated content is verified in Firestore and Firebase Storage.
