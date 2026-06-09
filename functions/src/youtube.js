/**
 * YouTube Data API v3 publisher.
 *
 * Required Firebase secrets:
 *   - YOUTUBE_CLIENT_ID
 *   - YOUTUBE_CLIENT_SECRET
 *   - YOUTUBE_REFRESH_TOKEN
 *
 * The refresh token must belong to the target YouTube channel and include:
 *   https://www.googleapis.com/auth/youtube.upload
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
let adminStorage = null;

function setYoutubeStorage(storage) {
  adminStorage = storage || null;
}

function cleanSecret(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
}

async function exchangeRefreshToken(secrets) {
  const clientId = cleanSecret(secrets.youtubeClientId);
  const clientSecret = cleanSecret(secrets.youtubeClientSecret);
  const refreshToken = cleanSecret(secrets.youtubeRefreshToken);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube OAuth secrets are not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body,
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const msg = json.error_description || json.error || `OAuth token exchange failed (HTTP ${res.status})`;
    throw new Error(`YouTube OAuth failed: ${msg}. Verify YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN belong to the same OAuth client.`);
  }
  return json.access_token;
}

async function youtubeVideoUrl(card) {
  if (card?.vidItemId && adminStorage) {
    try {
      const [url] = await adminStorage.bucket().file(card.vidItemId).getSignedUrl({
        action: 'read',
        expires: Date.now() + 60 * 60 * 1000
      });
      if (url) return url;
    } catch (e) {
      // Fall back to the stored Firebase download URL. Some Cloud Functions
      // service accounts cannot sign URLs until IAM is expanded, but the
      // tokenized download URL from the ticket is still valid for publishing.
    }
  }
  return card?.vidDisplayUrl || card?.vidUrl || card?.videoUrl || null;
}

async function downloadVideoBytes(url) {
  if (!url) throw new Error('This ticket has no video URL to upload to YouTube.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download video for YouTube upload (HTTP ${res.status}).`);
  const contentType = res.headers.get('content-type') || 'video/mp4';
  const arrayBuffer = await res.arrayBuffer();
  return {buffer: Buffer.from(arrayBuffer), contentType};
}

function isShortCard(card) {
  return String(card?.format || '').trim().toLowerCase() === 'short';
}

function withShortsHashtag(text) {
  const value = String(text || '').trim();
  if (!value) return '#Shorts';
  return /(^|\s)#shorts(\s|$)/i.test(value) ? value : `${value} #Shorts`;
}

function uniqueList(items) {
  const seen = new Set();
  return items
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function youtubeMetadata(job) {
  const yt = job.youtube || {};
  const card = job.card || {};
  const shortUpload = isShortCard(card);
  const baseTitle = String(yt.title || card.seoTitle || card.name || 'Untitled').trim();
  const baseDescription = String(yt.description || card.seoDesc || job.caption || '').trim();
  const title = (shortUpload ? withShortsHashtag(baseTitle) : baseTitle).slice(0, 100);
  const description = shortUpload ? withShortsHashtag(baseDescription) : baseDescription;
  const rawTags = Array.isArray(yt.tags) ? yt.tags : [];
  const tags = uniqueList([...rawTags, ...(shortUpload ? ['Shorts'] : [])]).slice(0, 30);
  if (!title) throw new Error('YouTube title is required.');
  if (!description) throw new Error('YouTube description is required.');
  return {
    snippet: {
      title,
      description,
      tags,
      categoryId: '25'
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false
    }
  };
}

async function startResumableUpload({accessToken, metadata, contentType, contentLength}) {
  const url = new URL(YOUTUBE_UPLOAD_URL);
  url.searchParams.set('uploadType', 'resumable');
  url.searchParams.set('part', 'snippet,status');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(contentLength)
    },
    body: JSON.stringify(metadata)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YouTube upload session failed (HTTP ${res.status}): ${text || res.statusText}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('YouTube upload session did not return an upload URL.');
  return location;
}

async function uploadVideoBytes({uploadUrl, accessToken, buffer, contentType}) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
      'Content-Length': String(buffer.length)
    },
    body: buffer
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) {
    const msg = json.error?.message || JSON.stringify(json) || `HTTP ${res.status}`;
    throw new Error(`YouTube video upload failed: ${msg}`);
  }
  return json.id;
}

async function publishToYoutube({job, secrets}) {
  if (job.card?._kind === 'carousel') {
    throw new Error('YouTube publishing requires a video ticket, not a carousel.');
  }
  const accessToken = await exchangeRefreshToken(secrets);
  const metadata = youtubeMetadata(job);
  const {buffer, contentType} = await downloadVideoBytes(await youtubeVideoUrl(job.card));
  const uploadUrl = await startResumableUpload({
    accessToken,
    metadata,
    contentType,
    contentLength: buffer.length
  });
  return uploadVideoBytes({uploadUrl, accessToken, buffer, contentType});
}

module.exports = {publishToYoutube, setYoutubeStorage};
