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

async function createVideoContainer({igUserId, videoUrl, caption, coverUrl, accessToken, isCarouselItem}) {
  const params = {video_url: videoUrl, media_type: isCarouselItem ? undefined : 'REELS'};
  if (isCarouselItem) params.is_carousel_item = 'true';
  else {
    if (caption) params.caption = caption;
    // cover_url sets the Reel's thumbnail/cover image — only supported for
    // non-carousel Reels and only when a thumbnail was actually uploaded.
    if (coverUrl) params.cover_url = coverUrl;
  }
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

function metricValue(insights, name) {
  const item = Array.isArray(insights?.data) ? insights.data.find(m => m.name === name) : null;
  const value = item?.total_value?.value ?? item?.value;
  if (value == null) return null;
  return Number(value || 0);
}

function sumMetricValues(insights, name) {
  const item = Array.isArray(insights?.data) ? insights.data.find(m => m.name === name) : null;
  if (!item) return null;
  if (item.total_value?.value != null) return Number(item.total_value.value || 0);
  if (!Array.isArray(item.values)) return Number(item.value || 0);
  return item.values.reduce((sum, entry) => sum + Number(entry.value || 0), 0);
}

function mergeMetricData(target, source) {
  for (const item of source?.data || []) {
    const existingIndex = target.data.findIndex(existing => existing.name === item.name);
    if (existingIndex === -1) target.data.push(item);
    else target.data[existingIndex] = item;
  }
}

function inDateRange(timestamp, from, to) {
  const day = String(timestamp || '').slice(0, 10);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

async function getMediaInsights(mediaId, accessToken) {
  const metricSets = [
    'views,reach,total_interactions,likes,comments,shares,saved',
    'reach,total_interactions,likes,comments,shares,saved',
    'reach,total_interactions',
    'impressions,reach,engagement,saved'
  ];
  let combined = {data: []};
  const seen = new Set();
  let lastError = null;
  for (const metric of metricSets) {
    try {
      const res = await igRequest(`${mediaId}/insights`, {params: {metric}, accessToken});
      for (const item of res.data || []) {
        if (!seen.has(item.name)) {
          seen.add(item.name);
          combined.data.push(item);
        }
      }
    } catch (e) {
      lastError = e;
    }
  }
  if (!combined.data.length && lastError) throw lastError;
  return combined;
}

function dateToUnixStart(dateStr) {
  if (!dateStr) return null;
  return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

function dateToUnixEnd(dateStr) {
  if (!dateStr) return null;
  return Math.floor(new Date(`${dateStr}T23:59:59Z`).getTime() / 1000);
}

async function getAccountInsights({igUserId, accessToken, from, to}) {
  const since = dateToUnixStart(from);
  const until = dateToUnixEnd(to);
  const baseParams = {};
  if (since) baseParams.since = since;
  if (until) baseParams.until = until;

  const combined = {data: []};
  const unavailable = [];
  const attempts = [
    {
      metrics: 'views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,reposts',
      params: {...baseParams, period: 'day', metric_type: 'total_value'}
    },
    {
      metrics: 'views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves',
      params: {...baseParams, period: 'day'}
    },
    {
      metrics: 'impressions,reach,profile_views',
      params: {...baseParams, period: 'day'}
    }
  ];

  for (const attempt of attempts) {
    try {
      const res = await igRequest(`${igUserId}/insights`, {
        params: {metric: attempt.metrics, ...attempt.params},
        accessToken
      });
      mergeMetricData(combined, res);
    } catch (e) {
      unavailable.push({metrics: attempt.metrics, error: e.message || String(e)});
    }
  }

  const metric = name => {
    const totalValue = metricValue(combined, name);
    if (totalValue != null) return totalValue;
    return sumMetricValues(combined, name);
  };

  return {
    totals: {
      views: metric('views'),
      impressions: metric('impressions'),
      likes: metric('likes'),
      comments: metric('comments'),
      saves: metric('saves') ?? metric('saved'),
      shares: metric('shares'),
      reach: metric('reach'),
      totalInteractions: metric('total_interactions') ?? metric('accounts_engaged')
    },
    unavailable,
    rawMetricNames: combined.data.map(item => item.name)
  };
}

function mediaMatchesContentType(item, contentType) {
  if (!contentType || contentType === 'all') return true;
  const product = String(item.media_product_type || '').toUpperCase();
  const mediaType = String(item.media_type || '').toUpperCase();
  if (contentType === 'reels') return product === 'REELS';
  if (contentType === 'posts') return product !== 'REELS' && ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'FEED'].includes(mediaType || product);
  return true;
}

async function listInstagramMedia({igUserId, accessToken, from, to, includeTopContent, limit = 100}) {
  const fields = includeTopContent
    ? 'id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count'
    : 'id,media_type,media_product_type,timestamp';
  const media = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const params = {fields, limit: Math.min(Math.max(Number(limit) || 100, 1), 100)};
    if (after) params.after = after;
    const res = await igRequest(`${igUserId}/media`, {params, accessToken});
    const items = res.data || [];
    if (!items.length) break;
    for (const item of items) {
      if (inDateRange(item.timestamp, from, to)) media.push(item);
    }
    const oldest = items[items.length - 1]?.timestamp;
    if (from && oldest && String(oldest).slice(0, 10) < from) break;
    after = res.paging?.cursors?.after;
    if (!after) break;
  }
  return media;
}

async function getInstagramPlatformReport({accountId, accountMeta, secrets, from = '', to = '', includeTopContent = false, contentType = 'all'}) {
  const igUserId = accountMeta.igUserId;
  if (!igUserId) throw new Error(`No Instagram Business Account ID saved for "${accountId}"`);
  if (!secrets.instagramAccessToken) throw new Error('INSTAGRAM_ACCESS_TOKEN secret is not configured');

  const accessToken = resolveAccessToken(secrets.instagramAccessToken, igUserId);
  if (!accessToken) throw new Error(`No usable access token found for "${accountId}" (igUserId ${igUserId}).`);

  const media = await listInstagramMedia({igUserId, accessToken, from, to, includeTopContent});
  const rows = [];
  const accountInsights = await getAccountInsights({igUserId, accessToken, from, to});

  const topCandidates = includeTopContent ? media.filter(item => mediaMatchesContentType(item, contentType)) : [];
  for (const item of topCandidates) {
    let insights = null;
    let error = null;
    try {
      insights = await getMediaInsights(item.id, accessToken);
    } catch (e) {
      error = e.message || String(e);
    }

    const likes = Number(item.like_count ?? metricValue(insights, 'likes') ?? 0);
    const comments = Number(item.comments_count ?? metricValue(insights, 'comments') ?? 0);
    const shares = metricValue(insights, 'shares') ?? 0;
    const saves = metricValue(insights, 'saved') ?? metricValue(insights, 'saves') ?? 0;
    const views = metricValue(insights, 'views') ?? metricValue(insights, 'video_views') ?? 0;
    const impressions = metricValue(insights, 'impressions');
    const reach = metricValue(insights, 'reach');
    const totalInteractions = metricValue(insights, 'total_interactions') ?? metricValue(insights, 'engagement') ?? (likes + comments + shares + saves);

    rows.push({
      id: item.id,
      title: item.caption ? String(item.caption).slice(0, 120) : 'Untitled',
      mediaType: item.media_product_type || item.media_type || '',
      publishedAt: item.timestamp || null,
      permalink: item.permalink || '',
      thumbnailUrl: item.thumbnail_url || item.media_url || '',
      views,
      impressions,
      reach,
      likes,
      comments,
      saves,
      shares,
      totalInteractions,
      error
    });
  }

  rows.sort((a, b) => (b.views || b.totalInteractions || 0) - (a.views || a.totalInteractions || 0));
  return {
    ok: true,
    platform: 'instagram',
    accountId,
    igUserId,
    from,
    to,
    totals: {...accountInsights.totals, publishedContent: media.length},
    overviewSource: 'account_insights',
    topContentLoaded: !!includeTopContent,
    contentType,
    unavailableMetrics: accountInsights.unavailable,
    rawOverviewMetrics: accountInsights.rawMetricNames,
    rows: rows.slice(0, 10),
    fetchedContent: media.length
  };
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
    // Use the card's thumbnail as the Reel cover if one was uploaded — the
    // Graph API accepts any publicly reachable HTTPS URL for cover_url, and
    // Firebase Storage download URLs (with their token) qualify. If there's
    // no thumbnail on this card we just omit it and Instagram picks a frame.
    const coverUrl = await refreshMediaUrl(card, 'thumb');
    containerId = await createVideoContainer({igUserId, videoUrl, caption, coverUrl: coverUrl || undefined, accessToken, isCarouselItem: false});
  } else {
    const imageUrl = await refreshMediaUrl(card, 'thumb');
    if (!imageUrl) throw new Error('No image URL found on this card');
    containerId = await createImageContainer({igUserId, imageUrl, caption, accessToken, isCarouselItem: false});
  }

  return publishContainer({igUserId, containerId, accessToken});
}

module.exports = {publishToInstagram, getInstagramPlatformReport};
