// Pure logic: no network, no KV. Everything here is unit-tested in test/core.test.js.

// Instagram API with Unified Login (system-user token) lives on graph.facebook.com. Latest version as of 2026-11.
export const API = 'https://graph.facebook.com/v26.0';
export const MAX_DMS = 15;
export const MAX_MEDIA = 15; // 1 media call + up to 19 comment-page calls + 30 send calls = 50 subrequests (index.js)
export const WEEK = 7 * 864e5;
export const LOG_SIZE = 100;

export const defaults = () => ({
  rules: [], // { id, match: 'keyword'|'emoji', keyword, dm, postId, enabled }
  replyText: 'Sent you a DM 📩',
  replyEnabled: true,
  failReplyText: "We couldn't DM you 🙈 Please allow message requests or follow us, then comment again.", // '' = off
  dryRun: true, // start safe
  handled: {}, // commentId -> comment timestamp (ms)
  dryHandled: {}, // same, for dry-run; cleared when dry-run is turned off
  log: [],
  userId: null,
  username: null,
  lastRunAt: null,
  lastError: null,
});

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Small-capital letters that phone keyboards / "fancy font" apps insert (ʟᴇᴀʀɴ). NFKC does not map these.
const SMALL_CAPS = { ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ǫ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z' };
// NFKC turns bold/italic/full-width letters (𝐥𝐞𝐚𝐫𝐧, ｌｅａｒｎ) into plain ones; zero-width characters are dropped.
export const normalize = (s) =>
  (s || '').normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '').replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ]/g, (c) => SMALL_CAPS[c]);

// Whole word, any case, any font. "link" matches "Link!", "send LINK pls", "ʟɪɴᴋ" but not "linkedin".
export function hasWord(text, keyword) {
  const kw = normalize(keyword).trim();
  if (!kw) return false;
  const body = esc(kw).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu').test(normalize(text));
}

// Pictographs (😍🔥❤️), flags (🇮🇳 = two regional indicators) and keycaps (1️⃣ ends in U+20E3).
export const hasEmoji = (text) => /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u.test(text || '');

// Keyword rules win over "any emoji" rules, so "LINK 🔥" gets the LINK DM.
export function matchRule(text, mediaId, rules) {
  const live = rules.filter((r) => r.enabled && (!r.postId || r.postId === mediaId));
  return (
    live.find((r) => r.match !== 'emoji' && hasWord(text, r.keyword)) ||
    live.find((r) => r.match === 'emoji' && hasEmoji(text)) ||
    null
  );
}

export const isMine = (c, s) =>
  (s.userId && c.from?.id === s.userId) ||
  (!!s.username && (c.username || c.from?.username || '').toLowerCase() === s.username.toLowerCase());

// Meta throttling codes: 4/17/32/613 app/user/page limits, 80000-80014 business use case limits.
export const isRateLimit = (e) =>
  e?.status === 429 || [4, 17, 32, 613].includes(e?.code) || (e?.code >= 80000 && e?.code <= 80014);

// Instagram returns max 25 comments per page, NOT strictly newest first on busy posts. Read the first page of
// every post, then follow "next" while a page still has any comment from the last 7 days, until `budget` runs out.
export async function collectComments(media, fetchPage, budget, now = Date.now()) {
  let queue = media.slice(0, budget).map((m) => ({ m, after: null }));
  budget -= queue.length;
  const comments = [];
  let pages = 0, firstErr = null;
  while (queue.length) {
    const batch = queue;
    queue = [];
    const results = await Promise.allSettled(batch.map((q) => fetchPage(q.m.id, q.after)));
    for (let i = 0; i < batch.length; i++) {
      const r = results[i], m = batch[i].m;
      if (r.status === 'rejected') {
        if (isRateLimit(r.reason)) throw r.reason;
        firstErr ??= r.reason;
        continue;
      }
      pages++;
      const data = r.value.data || [];
      comments.push(...data.map((c) => ({ ...c, mediaId: m.id, permalink: m.permalink })));
      const after = r.value.paging?.next && r.value.paging?.cursors?.after;
      if (after && data.some((c) => now - Date.parse(c.timestamp) < WEEK) && budget > 0) {
        queue.push({ m, after });
        budget--;
      }
    }
  }
  if (media.length && !pages) throw firstErr; // every request failed: surface it, don't report 0 comments
  return { comments, pages };
}

// What the tool does with one comment. The run (pickWork) and the dashboard's Comments tab both use this.
// status: mine | handled | dry | nomatch | old | replied (you replied yourself) | queued (DM next run)
export function commentStatus(c, state, now = Date.now()) {
  if (isMine(c, state)) return { status: 'mine' };
  if (state.handled[c.id]) return { status: 'handled' };
  if (state.dryRun && state.dryHandled[c.id]) return { status: 'dry' };
  const rule = matchRule(c.text, c.mediaId, state.rules);
  if (!rule) return { status: 'nomatch' };
  if (!(now - Date.parse(c.timestamp) < WEEK)) return { status: 'old', rule };
  if ((c.replies?.data || []).some((r) => isMine(r, state))) return { status: 'replied', rule };
  return { status: 'queued', rule };
}

// Comments to DM this run: the "queued" ones, oldest first, max 15.
export function pickWork(comments, state, now = Date.now()) {
  const picks = [];
  const sorted = [...comments].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const c of sorted) {
    if (picks.length >= MAX_DMS) break;
    const { status, rule } = commentStatus(c, state, now);
    if (status === 'queued') picks.push({ c, rule, ts: Date.parse(c.timestamp) });
  }
  return picks;
}

export function prune(state, now = Date.now()) {
  for (const set of [state.handled, state.dryHandled])
    for (const [id, ts] of Object.entries(set)) if (now - ts >= WEEK) delete set[id];
}

const addLog = (state, entry) => {
  state.log.unshift(entry);
  state.log.length = Math.min(state.log.length, LOG_SIZE);
};

// api = { save(state), dm(commentId, text), reply(commentId, text) }.
// Comments are saved as handled BEFORE any send, so a crash mid-run can never cause a second DM.
export async function processComments(state, comments, api, now = Date.now()) {
  const picks = pickWork(comments, state, now);
  if (!picks.length) return { picked: 0, sent: 0 };
  const done = state.dryRun ? state.dryHandled : state.handled;
  for (const p of picks) done[p.c.id] = p.ts;
  state.lastRunAt = now;
  // Run summary for the dashboard's live bar. Rides on the two saves that already happen: no extra KV writes.
  const run = (state.lastRun = { at: now, total: picks.length, sent: 0, failed: 0, skipped: 0, dry: state.dryRun, done: false });
  await api.save(state);

  let sent = 0;
  let retryFrom = -1; // index of the first pick to un-mark after a rate limit
  for (let i = 0; i < picks.length; i++) {
    const { c, rule } = picks[i];
    const entry = {
      t: now,
      cid: c.id, // lets the Comments tab show this comment's DM result
      user: c.username || c.from?.username || '?',
      keyword: rule.keyword,
      post: c.permalink || c.mediaId,
      ok: true,
      dry: state.dryRun,
    };
    if (!state.dryRun) {
      try {
        await api.dm(c.id, rule.dm);
        sent++;
      } catch (e) {
        if (isRateLimit(e)) {
          retryFrom = i; // not sent, retry next run
          break;
        }
        entry.ok = false;
        if (/already has a reply/i.test(e.message)) {
          entry.skipped = true; // Instagram allows one private reply per comment, and one was already sent
          entry.error = 'Skipped: this comment already got a private reply (from you or another tool).';
        } else {
          entry.error = e.message;
          // Real failure (privacy settings, blocked, etc.): tell them publicly so they can fix it and comment again.
          if (state.failReplyText) {
            try {
              await api.reply(c.id, state.failReplyText);
              entry.error += ' · Told them in a public reply.';
            } catch (e2) {
              entry.error += ` · Public reply also failed: ${e2.message}`;
              if (isRateLimit(e2)) retryFrom = i + 1; // keep this one handled, stop the run
            }
          }
        }
      }
      if (entry.ok && state.replyEnabled && state.replyText) {
        try {
          await api.reply(c.id, state.replyText);
        } catch (e) {
          entry.error = `DM sent, public reply failed: ${e.message}`;
          if (isRateLimit(e)) retryFrom = i + 1; // DM went out, keep this one handled
        }
      }
    }
    addLog(state, entry);
    if (!state.dryRun) entry.skipped ? run.skipped++ : entry.ok ? run.sent++ : run.failed++;
    if (retryFrom >= 0) break;
  }
  run.done = true;
  if (retryFrom >= 0) run.retryLater = picks.length - retryFrom;

  if (retryFrom >= 0) {
    for (const p of picks.slice(retryFrom)) delete done[p.c.id];
    state.lastError = { at: now, msg: 'Rate limited by Instagram. Stopped; will retry next run.' };
  } else state.lastError = null;
  prune(state, now);
  await api.save(state);
  return { picked: picks.length, sent, rateLimited: retryFrom >= 0 };
}

// Trust boundary: dashboard input.
export function validateConfig(body) {
  if (!body || !Array.isArray(body.rules)) return { error: 'rules must be a list' };
  if (body.rules.length > 50) return { error: 'max 50 rules' };
  const rules = [];
  for (const r of body.rules) {
    const match = r.match === 'emoji' ? 'emoji' : 'keyword';
    const keyword = match === 'emoji' ? 'any emoji' : String(r.keyword ?? '').trim();
    const dm = String(r.dm ?? '').trim();
    const postId = String(r.postId ?? '').trim();
    if (!keyword || keyword.length > 50) return { error: 'each keyword must be 1-50 characters' };
    if (!dm || dm.length > 1000) return { error: `DM text for "${keyword}" must be 1-1000 characters` };
    if (postId && !/^\d+$/.test(postId)) return { error: `post ID for "${keyword}" must be digits` };
    rules.push({ id: String(r.id || crypto.randomUUID()), match, keyword, dm, postId, enabled: !!r.enabled });
  }
  const replyText = String(body.replyText ?? '').trim();
  if (replyText.length > 300) return { error: 'reply text max 300 characters' };
  const failReplyText = String(body.failReplyText ?? '').trim();
  if (failReplyText.length > 300) return { error: 'failed-DM reply text max 300 characters' };
  return { rules, replyText, replyEnabled: !!body.replyEnabled && !!replyText, failReplyText, dryRun: !!body.dryRun };
}
