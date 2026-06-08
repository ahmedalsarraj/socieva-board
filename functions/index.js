/**
 * Backend publishing worker for the Socieva Studio "Posting" feature.
 *
 * The browser (app.js / openPosting / confirmPostingCompose) only ever:
 *   - writes non-secret account metadata to  board/socialAccounts  (igUserId, connected)
 *   - writes posting jobs to                 board/postingQueue    ({status: 'queued' | 'scheduled', ...})
 *
 * It never sees or stores platform access tokens. This worker is the only
 * thing that holds the real Instagram access token (as a Firebase secret —
 * see "Setup" below) and the only thing that calls the Graph API.
 *
 * Flow:
 *   1. A scheduled function wakes up every few minutes.
 *   2. It reads board/postingQueue, finds jobs that are due:
 *        - status === 'queued'                       → publish now
 *        - status === 'scheduled' && scheduledAt <= now → publish now
 *   3. For each due job it dispatches to a per-platform publisher
 *      (Instagram is implemented; YouTube/TikTok are stubs — see src/).
 *   4. It writes the result back: status → 'published' | 'failed' | 'partial',
 *      plus publishedAt / error / per-destination results.
 *
 * ---------------------------------------------------------------------------
 * SETUP
 * ---------------------------------------------------------------------------
 * 1. Install deps:
 *      cd functions && npm install
 *
 * 2. Store the Instagram access token as a Firebase secret (NOT in code,
 *    NOT in .env, NOT in Firestore — this is the one place it should live
 *    until it's loaded into the function's memory at runtime):
 *
 *      firebase functions:secrets:set INSTAGRAM_ACCESS_TOKEN
 *
 *    (Paste the long-lived token when prompted. One shared token is fine if
 *    it already has instagram_basic + instagram_content_publish permissions
 *    across both connected IG business accounts — see the chat discussion
 *    that led to this file for why a single shared token was chosen over a
 *    per-account map.)
 *
 * 3. Deploy:
 *      firebase deploy --only functions
 *
 * 4. Watch logs:
 *      firebase functions:log
 * ---------------------------------------------------------------------------
 */

const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {logger} = require('firebase-functions');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

const {publishToInstagram} = require('./src/instagram');
const {publishToYoutube} = require('./src/youtube');
const {publishToTiktok} = require('./src/tiktok');

admin.initializeApp();
const db = admin.firestore();

// Declared here so Cloud Functions injects it at runtime without it ever
// touching source control, Firestore, or the browser.
const INSTAGRAM_ACCESS_TOKEN = defineSecret('INSTAGRAM_ACCESS_TOKEN');

const QUEUE_DOC = db.collection('board').doc('postingQueue');
const ACCOUNTS_DOC = db.collection('board').doc('socialAccounts');

// Mirrors POSTING_ACCOUNTS in app.js just enough to know which platform an
// account id belongs to. Keep this in sync if accounts are added/removed —
// or, better, fold platform into the socialAccounts doc so both sides read
// from the same source (see TODO below).
const ACCOUNT_PLATFORM = {
  ig_news: 'instagram',
  ig_arabic: 'instagram',
  youtube: 'youtube',
  tiktok: 'tiktok'
};
// TODO: once each board/socialAccounts entry stores its own `platform` field,
// replace ACCOUNT_PLATFORM with a lookup against that document so this file
// doesn't need to be hand-synced with app.js's POSTING_ACCOUNTS list.

const PUBLISHERS = {
  instagram: publishToInstagram,
  youtube: publishToYoutube,
  tiktok: publishToTiktok
};

/**
 * Decide whether a queue entry is ready to go out right now.
 */
function isJobDue(job, now) {
  if (job.status === 'queued') return true;
  if (job.status === 'scheduled') return typeof job.scheduledAt === 'number' && job.scheduledAt <= now;
  return false; // already published / failed / publishing
}

/**
 * Publish one job to all of its selected destinations and fold the
 * per-destination outcomes into a single status for the job.
 */
async function runJob(job, secrets, accountsMeta) {
  const destinations = Array.isArray(job.destinations) ? job.destinations : [];
  const results = [];

  for (const accountId of destinations) {
    const platform = ACCOUNT_PLATFORM[accountId];
    const publisher = platform && PUBLISHERS[platform];
    if (!publisher) {
      results.push({accountId, platform: platform || 'unknown', ok: false, error: 'No publisher registered for this destination'});
      continue;
    }
    try {
      const accountMeta = accountsMeta[accountId] || {};
      const publishedId = await publisher({job, accountId, accountMeta, secrets});
      results.push({accountId, platform, ok: true, publishedId});
    } catch (e) {
      logger.error(`[posting] ${accountId} (${platform}) failed for job ${job.id}`, e);
      results.push({accountId, platform, ok: false, error: e.message || String(e)});
    }
  }

  const okCount = results.filter(r => r.ok).length;
  const status = okCount === 0 ? 'failed' : (okCount === results.length ? 'published' : 'partial');
  const error = results.filter(r => !r.ok).map(r => `${r.accountId}: ${r.error}`).join(' · ') || null;

  return {
    ...job,
    status,
    results,
    error,
    publishedAt: okCount > 0 ? Date.now() : (job.publishedAt || null)
  };
}

/**
 * Core queue sweep — pulled out of the scheduled trigger so it can also be
 * invoked on demand (see processPostingQueueNow below) for fast manual testing
 * without waiting for the schedule to tick.
 */
async function sweepQueue(secrets) {
  const [queueSnap, accountsSnap] = await Promise.all([QUEUE_DOC.get(), ACCOUNTS_DOC.get()]);
  if (!queueSnap.exists) return {checked: 0, processed: 0};

  const items = Array.isArray(queueSnap.data()?.items) ? queueSnap.data().items : [];
  const accountsMeta = accountsSnap.exists ? (accountsSnap.data() || {}) : {};
  const now = Date.now();
  const dueIdx = items.map((job, i) => (isJobDue(job, now) ? i : -1)).filter(i => i !== -1);

  if (!dueIdx.length) return {checked: items.length, processed: 0};

  // Mark as in-flight first so a second overlapping run (e.g. manual trigger
  // firing mid-schedule) doesn't double-publish the same job.
  for (const i of dueIdx) items[i] = {...items[i], status: 'publishing'};
  await QUEUE_DOC.set({items}, {merge: true});

  for (const i of dueIdx) {
    items[i] = await runJob(items[i], secrets, accountsMeta);
  }
  await QUEUE_DOC.set({items}, {merge: true});

  logger.info(`[posting] sweep done — ${dueIdx.length}/${items.length} job(s) processed`);
  return {checked: items.length, processed: dueIdx.length};
}

/**
 * Scheduled sweep — adjust the cadence to match how time-sensitive your
 * scheduled posts are. Every 5 minutes is a reasonable default.
 */
exports.processPostingQueue = onSchedule(
  {schedule: 'every 5 minutes', secrets: [INSTAGRAM_ACCESS_TOKEN], region: 'us-central1'},
  async () => {
    await sweepQueue({instagramAccessToken: INSTAGRAM_ACCESS_TOKEN.value()});
  }
);

/**
 * On-demand trigger for admins — lets you hit "Publish now" in the UI (or a
 * debug button) and see the result immediately instead of waiting up to 5
 * minutes for the schedule. Wire this up from the browser with:
 *
 *   const fn = firebase.functions().httpsCallable('processPostingQueueNow');
 *   await fn();
 *
 * Restricted to admins via the same `users/{uid}.role` check the rest of the
 * app uses, enforced here server-side (never trust the client's claim).
 */
exports.processPostingQueueNow = onCall(
  {secrets: [INSTAGRAM_ACCESS_TOKEN], region: 'us-central1'},
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    const user = userDoc.data();
    if (!userDoc.exists || user?.role !== 'admin' || user?.active !== true) {
      throw new HttpsError('permission-denied', 'Posting is restricted to admins.');
    }
    return sweepQueue({instagramAccessToken: INSTAGRAM_ACCESS_TOKEN.value()});
  }
);
