/**
 * Backend publishing worker for the Socieva Studio "Posting" feature.
 *
 * The browser (app.js / openPosting / confirmPostingCompose) only ever:
 *   - writes non-secret account metadata to  board/socialAccounts  (igUserId, connected)
 *   - writes posting jobs to                 board/postingQueue/items/{jobId}    ({status: 'queued' | 'scheduled', ...})
 *
 * It never sees or stores platform access tokens. This worker is the only
 * thing that holds the real Instagram access token (as a Firebase secret —
 * see "Setup" below) and the only thing that calls the Graph API.
 *
 * Flow:
 *   1. A scheduled function wakes up every few minutes.
 *   2. It reads board/postingQueue/items, finds jobs that are due:
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
 *    Two shapes are accepted (src/instagram.js auto-detects which one you used):
 *      - A single shared token string (e.g. "IGAAS0o..."), if it already has
 *        instagram_basic + instagram_content_publish permissions across every
 *        connected IG business account, OR
 *      - A per-account JSON map  {"<igUserId>": "<token for that account>", ...}
 *        — needed when each account has its own page-scoped token (the usual
 *        case when an account/business manager hands you Page Access Tokens).
 *    Paste whichever shape you have, exactly as given, when prompted.
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

const {publishToInstagram, getInstagramPlatformReport} = require('./src/instagram');
const {publishToYoutube, setYoutubeStorage} = require('./src/youtube');
const {publishToTiktok} = require('./src/tiktok');

admin.initializeApp();
const db = admin.firestore();
setYoutubeStorage(admin.storage());

// Declared here so Cloud Functions injects it at runtime without it ever
// touching source control, Firestore, or the browser.
const INSTAGRAM_ACCESS_TOKEN = defineSecret('INSTAGRAM_ACCESS_TOKEN');
const YOUTUBE_CLIENT_ID = defineSecret('YOUTUBE_CLIENT_ID');
const YOUTUBE_CLIENT_SECRET = defineSecret('YOUTUBE_CLIENT_SECRET');
const YOUTUBE_REFRESH_TOKEN = defineSecret('YOUTUBE_REFRESH_TOKEN');

const QUEUE_DOC = db.collection('board').doc('postingQueue');
const QUEUE_ITEMS = QUEUE_DOC.collection('items');
const ACCOUNTS_DOC = db.collection('board').doc('socialAccounts');

// Mirrors STAGES / CAROUSEL_STAGES in app.js — needed to know which stage
// index counts as "Posted" for each board when auto-advancing a card after
// a successful publish. Keep in sync if the stage lists ever change.
const STAGES = ['Script', 'Recording', 'Under editing', 'Ready to post', 'Posted'];
const CAROUSEL_STAGES = ['Script', 'Working on', 'Ready to post', 'Posted'];

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

async function assertAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  const user = userDoc.data();
  if (!userDoc.exists || user?.role !== 'admin' || user?.active !== true) {
    throw new HttpsError('permission-denied', 'This action is restricted to admins.');
  }
}

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
 * Once a job actually goes out to at least one destination, flip its source
 * card on the board over to the "Posted" stage — mirroring the audit trail
 * (stageHistory / stageChangedAt / postedAt) the UI keeps for a manual
 * drag-to-Posted.
 *
 * Cards can currently live in either of two shapes (the client migrates a
 * board lazily, the first time someone opens it, from the old shape to the
 * new one — so both can be live in production at once):
 *   - new:    board/{mode}/cards/{cardId} documents, each with its own `_rev`
 *             — bump `_rev` so app.js's per-card conflict check still works
 *   - legacy: a `cards` array on the board/{mode} doc, guarded by the doc's
 *             whole-board `revision` — bump `revision` so app.js's
 *             whole-board conflict check still works
 * Pick whichever shape the card is actually stored in; don't touch the other.
 */
async function markCardPosted(job) {
  const card = job.card;
  if (!card || !card.id) return;
  const isCarousel = card._kind === 'carousel';
  const boardDocId = isCarousel ? 'carousels' : 'videos';
  const stages = isCarousel ? CAROUSEL_STAGES : STAGES;
  const postedStage = stages.length - 1;
  const boardRef = db.collection('board').doc(boardDocId);
  const cardRef = boardRef.collection('cards').doc(card.id);
  try {
    const advanced = await db.runTransaction(async tx => {
      const cardSnap = await tx.get(cardRef);
      const nowIso = new Date().toISOString();

      if (cardSnap.exists) {
        const data = cardSnap.data() || {};
        if (data.stage === postedStage) return false;
        tx.update(cardRef, {
          stage: postedStage,
          stageChangedAt: nowIso,
          stageHistory: [...(Array.isArray(data.stageHistory) ? data.stageHistory : []), {from: data.stage, to: postedStage, at: nowIso, by: 'auto-publish'}],
          postedAt: data.postedAt || nowIso,
          updatedAt: nowIso,
          updatedAtMs: Date.now(),
          updatedBy: 'auto-publish',
          _rev: Number(data._rev || 0) + 1
        });
        return true;
      }

      const boardSnap = await tx.get(boardRef);
      if (!boardSnap.exists) return false;
      const data = boardSnap.data() || {};
      const cards = Array.isArray(data.cards) ? data.cards : [];
      const idx = cards.findIndex(c => c.id === card.id);
      if (idx === -1 || cards[idx].stage === postedStage) return false;
      const previous = cards[idx];
      const nextCards = cards.slice();
      nextCards[idx] = {
        ...previous,
        stage: postedStage,
        stageChangedAt: nowIso,
        stageHistory: [...(Array.isArray(previous.stageHistory) ? previous.stageHistory : []), {from: previous.stage, to: postedStage, at: nowIso, by: 'auto-publish'}],
        postedAt: previous.postedAt || nowIso,
        updatedAt: nowIso,
        updatedBy: 'auto-publish'
      };
      tx.update(boardRef, {
        cards: nextCards,
        revision: Number(data.revision || 0) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: Date.now(),
        updatedBy: 'auto-publish'
      });
      return true;
    });
    if (advanced) logger.info(`[posting] card ${card.id} (${boardDocId}) auto-advanced to Posted after job ${job.id}`);
  } catch (e) {
    logger.error(`[posting] failed to auto-advance card ${card.id} to Posted for job ${job.id}`, e);
  }
}

/**
 * Core queue sweep — pulled out of the scheduled trigger so it can also be
 * invoked on demand (see processPostingQueueNow below) for fast manual testing
 * without waiting for the schedule to tick.
 */
async function sweepQueue(secrets) {
  const [jobsSnap, accountsSnap] = await Promise.all([
    QUEUE_ITEMS.where('status', 'in', ['queued', 'scheduled']).limit(25).get(),
    ACCOUNTS_DOC.get()
  ]);
  const accountsMeta = accountsSnap.exists ? (accountsSnap.data() || {}) : {};
  const now = Date.now();
  const dueDocs = jobsSnap.docs.filter(doc => isJobDue({id: doc.id, ...doc.data()}, now));

  if (!dueDocs.length) return {checked: jobsSnap.size, processed: 0};

  let processed = 0;
  for (const doc of dueDocs) {
    const ref = doc.ref;
    const lockedJob = await db.runTransaction(async tx => {
      const latest = await tx.get(ref);
      if (!latest.exists) return null;
      const job = {id: latest.id, ...latest.data()};
      if (!isJobDue(job, Date.now())) return null;
      tx.update(ref, {
        status: 'publishing',
        processingStartedAt: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return {...job, status: 'publishing'};
    });
    if (!lockedJob) continue;

    const result = await runJob(lockedJob, secrets, accountsMeta);
    await ref.set({
      ...result,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true});
    if (result.status === 'published' || result.status === 'partial') {
      await markCardPosted(result);
    }
    processed++;
  }

  logger.info(`[posting] sweep done — ${processed}/${jobsSnap.size} candidate job(s) processed`);
  return {checked: jobsSnap.size, processed};
}

/**
 * Scheduled sweep — safety net that catches anything the immediate triggers
 * miss (e.g. a "Publish now" call that failed to reach processPostingQueueNow,
 * or a scheduled post whose time arrives while no one is interacting with the
 * board). Runs every minute — the minimum granularity Cloud Scheduler
 * supports — so a "scheduled" post goes out within ~60s of its target time
 * even in the worst case, instead of up to 5 minutes late.
 */
exports.processPostingQueue = onSchedule(
  {schedule: 'every 1 minutes', secrets: [INSTAGRAM_ACCESS_TOKEN, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN], region: 'us-central1', timeoutSeconds: 540, memory: '1GiB'},
  async () => {
    await sweepQueue({
      instagramAccessToken: INSTAGRAM_ACCESS_TOKEN.value(),
      youtubeClientId: YOUTUBE_CLIENT_ID.value(),
      youtubeClientSecret: YOUTUBE_CLIENT_SECRET.value(),
      youtubeRefreshToken: YOUTUBE_REFRESH_TOKEN.value()
    });
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
  {secrets: [INSTAGRAM_ACCESS_TOKEN, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN], region: 'us-central1', timeoutSeconds: 540, memory: '1GiB'},
  async (request) => {
    await assertAdmin(request);
    return sweepQueue({
      instagramAccessToken: INSTAGRAM_ACCESS_TOKEN.value(),
      youtubeClientId: YOUTUBE_CLIENT_ID.value(),
      youtubeClientSecret: YOUTUBE_CLIENT_SECRET.value(),
      youtubeRefreshToken: YOUTUBE_REFRESH_TOKEN.value()
    });
  }
);

exports.getPlatformReport = onCall(
  {secrets: [INSTAGRAM_ACCESS_TOKEN], region: 'us-central1', timeoutSeconds: 120},
  async (request) => {
    await assertAdmin(request);
    const accountId = String(request.data?.accountId || '').trim();
    const from = String(request.data?.from || '').trim();
    const to = String(request.data?.to || '').trim();
    const includeTopContent = request.data?.includeTopContent === true;
    const contentType = String(request.data?.contentType || 'all').trim();
    if (!accountId) throw new HttpsError('invalid-argument', 'accountId is required.');

    const platform = ACCOUNT_PLATFORM[accountId];
    if (!platform) throw new HttpsError('invalid-argument', 'Unknown platform account.');
    if (platform !== 'instagram') {
      return {
        ok: false,
        platform,
        accountId,
        from,
        to,
        reason: `${platform} analytics is not connected yet. Add OAuth/API credentials before live metrics can be pulled.`
      };
    }

    const accountsSnap = await ACCOUNTS_DOC.get();
    const accountsMeta = accountsSnap.exists ? (accountsSnap.data() || {}) : {};
    const accountMeta = accountsMeta[accountId] || {};
    try {
      return await getInstagramPlatformReport({
        accountId,
        accountMeta,
        from,
        to,
        includeTopContent,
        contentType,
        secrets: {instagramAccessToken: INSTAGRAM_ACCESS_TOKEN.value()}
      });
    } catch (e) {
      throw new HttpsError('failed-precondition', e.message || String(e));
    }
  }
);
