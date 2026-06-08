/**
 * Instagram Graph API publisher.
 *
 * Token model: the INSTAGRAM_ACCESS_TOKEN secret accepts EITHER shape —
 *   1. A single shared long-lived token string (e.g. "IGAAS0o..." / "EAA...")
 *      — works if that token has instagram_basic + instagram_content_publish
 *      permissions across every connected IG business account.
 *   2. A per-account JSON map  {"<igUserId>": "<token for that account>", ...}
 *      — needed when the platform/account manager hands out a separate
 *      page-scoped token per Instagram Business Account (the common case —
 *      Page Access Tokens from /me/accounts are scoped to their own Page/IG
 *      account and won't work for a different one).
 *
 * resolveAccessToken() below detects which shape was provided and looks up
 * the right token for the account being published to (by its igUserId). The
 * raw secret never touches Firestore or the browser — see ../index.js.
 *
 * Job shape (from board/postingQueue, written by confirmPostingCompose in app.js):
 *   {
 *     id, caption, destinations: [accountId,...], mode: 'now'|'schedule',
 *     scheduledAt, status, youtube: {title, description, tags} | null,
 *     card: { _kind: 'video'|'carousel', name, thumbDisplayUrl, thumbUrl,
 *             vidUrl, vidDisplayUrl, images: [{shareUrl, downloadUrl}, ...], ... }
 *   }
 *
 * accountMeta (from board/socialAccounts[accountId]):
 *   { igUserId, connected, connectedAt }
 *
 * NOTE on media URLs: Instagram's Graph API fetches media by URL — it needs a
 * publicly reachable HTTPS URL for each image/video. Firebase Storage download
 * URLs in `card.thumbDisplayUrl` / `card.vidDisplayUrl` can expire (the app's
 * own comments mention a ~45min TTL). If a job sits in the queue for a while
 * before being picked up, refresh the URL from Storage right before use —
 * see refreshMediaUrl() below, which is stubbed to the obvious approach.
 */

const FACEBOOK_GRAPH_API = 'https://graph.facebook.com/v19.0';
const INSTAGRAM_GRAPH_API = 'https://graph.instagram.com/v21.0';
const CONTAINER_POLL_INTERVAL_MS = 5000;
const CONTAINER_POLL_MAX_ATTEMPTS = 24; // ~2 minutes

/**
 * Pick the right access token for a given Instagram Business Account out of
 * whatever shape the INSTAGRAM_ACCESS_TOKEN secret was stored in.
 *
 *  - If the secret looks like a JSON object, treat it as a per-account map
 *    keyed by igUserId and return the entry for THIS account (or null if
 *    that account isn't in the map — a clear, actionable error beats a
 *    confusing "Cannot parse access token" from the Graph API).
 *  - Otherwise treat the whole (trimmed) string as one shared token.
 */
function cleanAccessToken(token) {
  return String(token || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function resolveAccessToken(rawSecret, igUserId) {
  if (!rawSecret) return null;
  const trimmed = String(rawSecret).trim();
  if (trimmed.startsWith('{')) {
    let map;
    try {
      map = JSON.parse(trimmed);
    } catch (e) {
      throw new Error('INSTAGRAM_ACCESS_TOKEN looks like JSON but failed to parse — check it was pasted as a single valid JSON object with no extra quoting.');
    }
    if (!map || typeof map !== 'object') return null;
    return cleanAccessToken(map[igUserId]);
  }
  return cleanAccessToken(trimmed) || null;
}

function graphBaseForToken(accessToken) {
  return /^IGA/i.test(accessToken) ? INSTAGRAM_GRAPH_API : FACEBOOK_GRAPH_API;
}

async function igRequest(path, {method = 'GET', params = {}, accessToken}) {
  const url = new URL(`${graphBaseForToken(accessToken)}/${path}`);
  const isGet = method === 'GET';
  const body = new URLSearchParams({...params, access_token: accessToken});
  if (isGet) {
    for (const [k, v] of body.entries()) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method,
    ...(isGet ? {} : {body, headers: {'Content-Type': 'application/x-www-form-urlencoded'}})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const msg = json.error?.message || `Graph API error (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return json;
}

async function waitForContainer(containerId, accessToken) {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await igRequest(containerId, {params: {fields: 'status_code,status'}, accessToken});
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR') throw new Error(status.status || 'Media container processing failed');
    await new Promise(r => setTimeout(r, CONTAINER_POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for media container to finish processing');
}

/**
 * Re-fetch a fresh download URL for Storage-backed media right before
 * publishing, in case the cached one in the card has expired.
 *
 * TODO: implement using admin.storage() once you know the canonical Storage
 * path for thumbnails/videos (see thumbItemId / vidItemId in app.js — those
 * look like they may be OneDrive-era leftovers; confirm what the Firebase
 * equivalent field is, e.g. a Storage path string, before wiring this up).
 * Falling back to the cached URL is fine as a first pass since the queue is
 * processed every few minutes, well within the ~45min TTL mentioned in app.js.
 */
async function refreshMediaUrl(card, kind) {
  if (kind === 'thumb') return card.thumbDisplayUrl || card.thumbUrl || null;
  if (kind === 'video') return card.vidDisplayUrl || card.vidUrl || null;
  return null;
}

async function createImageContainer({igUserId, imageUrl, caption, accessToken, isCarouselItem}) {
  const params = {image_url: imageUrl};
  if (isCarouselItem) params.is_carousel_item = 'true';
  else if (caption) params.caption = caption;
  const res = await igRequest(`${igUserId}/media`, {method: 'POST', params, accessToken});
  return res.id;
}

async function createVideoContainer({igUserId, videoUrl, caption, accessToken, isCarouselItem}) {
  const params = {video_url: videoUrl, media_type: isCarouselItem ? undefined : 'REELS'};
  if (isCarouselItem) params.is_carousel_item = 'true';
  else if (caption) params.caption = caption;
  Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);
  const res = await igRequest(`${igUserId}/media`, {method: 'POST', params, accessToken});
  await waitForContainer(res.id, accessToken);
  return res.id;
}

async function createCarouselContainer({igUserId, childIds, caption, accessToken}) {
  const res = await igRequest(`${igUserId}/media`, {
    method: 'POST',
    params: {media_type: 'CAROUSEL', children: childIds.join(','), caption: caption || ''},
    accessToken
  });
  return res.id;
}

async function publishContainer({igUserId, containerId, accessToken}) {
  const res = await igRequest(`${igUserId}/media_publish`, {method: 'POST', params: {creation_id: containerId}, accessToken});
  return res.id;
}

/**
 * Entry point called by index.js's runJob() for any destination whose
 * platform is 'instagram'.
 *
 * @returns {Promise<string>} the published media id
 * @throws on any failure — index.js records job.error from the message
 */
async function publishToInstagram({job, accountId, accountMeta, secrets}) {
  const igUserId = accountMeta.igUserId;
  if (!igUserId) throw new Error(`No Instagram Business Account ID saved for "${accountId}" — connect it from the Posting overlay first`);
  if (!secrets.instagramAccessToken) throw new Error('INSTAGRAM_ACCESS_TOKEN secret is not configured');

  const accessToken = resolveAccessToken(secrets.instagramAccessToken, igUserId);
  if (!accessToken) {
    throw new Error(
      `No usable access token found for "${accountId}" (igUserId ${igUserId}). ` +
      `INSTAGRAM_ACCESS_TOKEN must be either a single shared token string, or a JSON map ` +
      `like {"${igUserId}":"<token for this account>"} that includes this account's id.`
    );
  }

  const card = job.card || {};
  const caption = job.caption || '';

  let containerId;

  if (card._kind === 'carousel' && Array.isArray(card.images) && card.images.length > 1) {
    const childIds = [];
    for (const img of card.images) {
      const imageUrl = img.downloadUrl || img.shareUrl;
      if (!imageUrl) continue;
      childIds.push(await createImageContainer({igUserId, imageUrl, accessToken, isCarouselItem: true}));
    }
    if (childIds.length < 2) throw new Error('Carousel needs at least 2 valid images');
    containerId = await createCarouselContainer({igUserId, childIds, caption, accessToken});
  } else if (card._kind === 'video' || card.vidUrl || card.vidDisplayUrl) {
    const videoUrl = await refreshMediaUrl(card, 'video');
    if (!videoUrl) throw new Error('No video URL found on this card');
    containerId = await createVideoContainer({igUserId, videoUrl, caption, accessToken, isCarouselItem: false});
  } else {
    const imageUrl = await refreshMediaUrl(card, 'thumb');
    if (!imageUrl) throw new Error('No image URL found on this card');
    containerId = await createImageContainer({igUserId, imageUrl, caption, accessToken, isCarouselItem: false});
  }

  return publishContainer({igUserId, containerId, accessToken});
}

module.exports = {publishToInstagram};
