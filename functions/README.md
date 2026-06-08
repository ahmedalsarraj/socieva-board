# Posting queue worker (Cloud Functions)

Backend half of the Posting feature. The browser only ever queues jobs to
`board/postingQueue` and stores non-secret account metadata in
`board/socialAccounts` — this worker is what actually talks to the platforms,
because that's the only place an access token should live.

## What's here

| File | Status | Notes |
| --- | --- | --- |
| `index.js` | ✅ working | Scheduled sweep (`processPostingQueue`, every 5 min) + on-demand admin trigger (`processPostingQueueNow`) |
| `src/instagram.js` | ✅ working | Full Graph API flow: image / video (Reels) / carousel container creation, polling, publish |
| `src/youtube.js` | 🚧 stub | Needs OAuth (client id/secret + refresh token) — see file for the planned resumable-upload flow |
| `src/tiktok.js` | 🚧 stub | Needs Content Posting API approval from TikTok — see file |

Jobs that target an unimplemented platform fail loudly (with a clear error
message recorded on the job) rather than silently appearing to succeed.

## One-time setup

```bash
cd functions
npm install

# Store the Instagram token as a secret — never in code, .env, or Firestore.
# A single shared long-lived token (instagram_basic + instagram_content_publish)
# is enough as long as it covers both connected IG business accounts.
firebase functions:secrets:set INSTAGRAM_ACCESS_TOKEN
```

## Deploy

```bash
firebase deploy --only functions
```

## Watching it run

```bash
firebase functions:log
```

Or, for fast iteration without waiting up to 5 minutes for the schedule, call
the on-demand trigger from an admin-authenticated browser session:

```js
const fn = firebase.functions().httpsCallable('processPostingQueueNow');
const result = await fn();
console.log(result.data); // {checked, processed}
```

## How a job moves through the system

1. Admin picks a "Ready to post" card in the Posting overlay, fills the
   compose modal, hits Publish/Schedule → `confirmPostingCompose()` in `app.js`
   writes a job to `board/postingQueue` with `status: 'queued' | 'scheduled'`.
2. This worker wakes up (scheduled or on-demand), finds due jobs
   (`queued`, or `scheduled` with `scheduledAt <= now`), flips them to
   `publishing` (so a second overlapping run can't double-post), then
   dispatches each destination to its platform publisher.
3. Results are folded back into the job: `status` becomes `published` /
   `partial` / `failed`, plus `publishedAt`, `error`, and a `results` array
   with one entry per destination (`{accountId, platform, ok, publishedId|error}`).
4. `renderPostingQueue()` in `app.js` already knows how to render `scheduled`
   / `published` / `failed` states — `partial` will currently fall through to
   whatever the default status styling is; you may want to add an explicit
   case for it in `postingStatusLabel()`.

## Things to double check before relying on this in production

- **Media URL freshness** — `refreshMediaUrl()` in `src/instagram.js` is a
  stub that just returns the cached `thumbDisplayUrl` / `vidDisplayUrl` from
  the card. Those are Firebase Storage download URLs that the app's own code
  notes can expire (~45 min TTL). The 5-minute sweep interval keeps this safe
  in practice, but if jobs can sit `scheduled` for hours/days, wire this up to
  `admin.storage()` to mint a fresh URL right before publishing.
- **`ACCOUNT_PLATFORM` in `index.js`** is a hand-maintained mirror of
  `POSTING_ACCOUNTS` in `app.js`. If you add/remove/rename posting accounts,
  update both, or — better — add a `platform` field to each
  `board/socialAccounts` entry so this file can read it instead of duplicating
  the list.
- **Token rotation** — long-lived Instagram tokens last ~60 days. Set a
  reminder to refresh `INSTAGRAM_ACCESS_TOKEN` before it expires (a failed
  `OAuthException` from the Graph API is the symptom you'd see in the logs/job
  errors if it lapses).
