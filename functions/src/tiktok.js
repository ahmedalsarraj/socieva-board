/**
 * TikTok Content Posting API publisher — STUB.
 *
 * Not implemented yet — TikTok's posting API requires:
 *   - A TikTok Developer app with the "Content Posting API" product approved
 *     (this is an app-review-gated product, not available by default)
 *   - Per-account OAuth 2.0 (authorization-code flow, refresh tokens), similar
 *     in shape to YouTube's model — would need its own secrets:
 *       TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN
 *   - Direct-post or upload flow against:
 *       POST https://open.tiktokapis.com/v2/post/publish/video/init/
 *     followed by a chunked video upload to the returned upload URL, then
 *     polling https://open.tiktokapis.com/v2/post/publish/status/fetch/
 *
 * Note POSTING_ACCOUNTS in app.js currently marks the TikTok account as
 * `connected:false` (static demo placeholder) — there's no connect UI for it
 * yet, unlike Instagram. That UI would need to be built alongside this.
 *
 * @returns {Promise<string>} the published post id
 * @throws Always — until this is implemented, jobs targeting TikTok will be
 *         recorded as failed with this message rather than silently "succeeding".
 */
async function publishToTiktok({job, accountId, accountMeta, secrets}) {
  throw new Error('TikTok publishing is not implemented yet — requires Content Posting API approval; see functions/src/tiktok.js');
}

module.exports = {publishToTiktok};
