/**
 * YouTube Data API v3 publisher — STUB.
 *
 * Not implemented yet because YouTube's auth model is fundamentally different
 * from Instagram's: it's per-channel OAuth 2.0 (not a single long-lived app
 * token), so it needs its own secret(s) and a refresh-token flow:
 *
 *   - YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET (from Google Cloud Console,
 *     same project as Firebase or a dedicated one)
 *   - YOUTUBE_REFRESH_TOKEN (obtained once via an OAuth consent flow for the
 *     "Capital.com Arabic" channel — youtube.upload scope)
 *
 * High-level flow once you're ready to build it:
 *   1. Exchange the refresh token for a short-lived access token:
 *        POST https://oauth2.googleapis.com/token
 *          {client_id, client_secret, refresh_token, grant_type: 'refresh_token'}
 *   2. Resumable upload of the video file:
 *        POST https://www.googleapis.com/upload/youtube/v3/videos
 *             ?uploadType=resumable&part=snippet,status
 *        body: { snippet: {title, description, tags}, status: {privacyStatus} }
 *      then PUT the video bytes to the returned upload URL.
 *   3. The job already carries everything you need in job.youtube:
 *        { title, description, tags: string[] }
 *      (collected by the YouTube-specific fields added to the compose modal —
 *      see #postingYoutubeFields / #postingYtTitle etc. in index.html)
 *
 * For scheduled posts, YouTube supports `status.publishAt` + `privacyStatus:
 * 'private'` so you don't have to hold the upload yourself until job.scheduledAt.
 *
 * @returns {Promise<string>} the published video id
 * @throws Always — until this is implemented, jobs targeting YouTube will be
 *         recorded as failed with this message rather than silently "succeeding".
 */
async function publishToYoutube({job, accountId, accountMeta, secrets}) {
  throw new Error('YouTube publishing is not implemented yet — see functions/src/youtube.js for the planned OAuth + resumable-upload flow');
}

module.exports = {publishToYoutube};
