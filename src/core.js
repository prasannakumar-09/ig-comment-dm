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
  inboxSeen: {}, // IGSID -> ms of the last message from them that the inbox step handled
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

// Exclude words: comma-separated, whole-word like keywords ("scam, spam").
const excluded = (text, r) => (r.exclude || '').split(',').some((w) => w.trim() && hasWord(text, w));

// Priority: keyword rules, then "any emoji", then "any comment" — so "LINK 🔥" gets the LINK DM.
// A rule is live while switched on, on its post (or all posts), and before its end date (ms, optional).
export function matchRule(text, mediaId, rules, now = Date.now()) {
  const live = rules.filter((r) => r.enabled && (!r.postId || r.postId === mediaId) && !(r.until && now > r.until) && !excluded(text, r));
  return (
    live.find((r) => (r.match || 'keyword') === 'keyword' && hasWord(text, r.keyword)) ||
    live.find((r) => r.match === 'emoji' && hasEmoji(text)) ||
    live.find((r) => r.match === 'any' && (text || '').trim()) ||
    null
  );
}

// One line per variation; the same comment always gets the same pick (stable, testable), different comments vary.
export function pickLine(text, seed) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return lines[0] || '';
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return lines[h % lines.length];
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
  const rule = matchRule(c.text, c.mediaId, state.rules, now);
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
        await api.dm(c.id, dmMessage(rule));
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
              await api.reply(c.id, pickLine(state.failReplyText, c.id));
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
          await api.reply(c.id, pickLine(state.replyText, c.id));
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

// ---------- DM message bodies ----------
// With a link button: Instagram's button template; the I/O layer falls back to plain text if Instagram refuses it.
export function dmMessage(rule) {
  const url = rule.link;
  return url && rule.buttonTitle
    ? { attachment: { type: 'template', payload: { template_type: 'button', text: rule.dm, buttons: [{ type: 'web_url', url, title: rule.buttonTitle }] } } }
    : { text: url ? `${rule.dm}\n${url}` : rule.dm };
}
// Plain-text version of any message, for the fallback.
export const plainText = (m) => m.text || `${m.attachment.payload.text}\n${m.attachment.payload.buttons[0].url}`;

// ---------- inbox: DM keywords and story replies ----------
// convs: [{ pid, user, msgs: [{ id, text, at }] }] — only messages FROM the other person, newest first.
// api = { save, send(pid, message) }. Same rule as comments: mark handled, save, then send.
export const INBOX_MAX = 5;
export async function processInbox(state, convs, api, now = Date.now()) {
  const inboxRules = state.rules.filter((r) => r.inbox).map((r) => ({ ...r, postId: '' }));
  const work = [];
  for (const cv of convs) {
    if (work.length >= INBOX_MAX) break;
    const m = cv.msgs.find((x) => x.at > (state.inboxSeen[cv.pid] || 0) && now - x.at < 864e5); // 24 h reply window
    if (!m) continue;
    const rule = matchRule(m.text, undefined, inboxRules, now);
    if (!rule) { state.inboxSeen[cv.pid] = m.at; continue; } // seen, nothing to do (no save needed on its own)
    work.push({ cv, m, rule });
  }
  if (!work.length) return { handled: 0 };
  for (const w of work) state.inboxSeen[w.cv.pid] = w.m.at;
  await api.save(state);

  let handled = 0;
  for (const { cv, rule } of work) {
    const entry = { t: now, user: cv.user, keyword: rule.keyword, post: 'DM', ok: true, dry: state.dryRun, via: 'DM keyword' };
    try {
      if (!state.dryRun) await api.send(cv.pid, dmMessage(rule));
      handled++;
    } catch (e) {
      if (isRateLimit(e)) { state.lastError = { at: now, msg: 'Rate limited by Instagram. Will retry next run.' }; addLog(state, { ...entry, ok: false, error: e.message }); break; }
      entry.ok = false; entry.error = e.message;
    }
    addLog(state, entry);
  }
  await api.save(state);
  return { handled };
}

export function pruneInbox(state, now = Date.now()) {
  delete state.gates; delete state.gateText; delete state.trackClicks; delete state.origin; // removed features
  for (const [k, at] of Object.entries(state.inboxSeen)) if (now - at >= WEEK) delete state.inboxSeen[k];
}

// Trust boundary: dashboard input.
const lines = (s, max) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, max);
export function validateConfig(body) {
  if (!body || !Array.isArray(body.rules)) return { error: 'rules must be a list' };
  if (body.rules.length > 50) return { error: 'max 50 rules' };
  const rules = [];
  for (const r of body.rules) {
    const match = ['emoji', 'any'].includes(r.match) ? r.match : 'keyword';
    const keyword = match === 'emoji' ? 'any emoji' : match === 'any' ? 'any comment' : String(r.keyword ?? '').trim();
    const dm = String(r.dm ?? '').trim();
    const postId = String(r.postId ?? '').trim();
    const exclude = String(r.exclude ?? '').trim();
    const link = String(r.link ?? '').trim();
    const buttonTitle = String(r.buttonTitle ?? '').trim();
    const until = r.until ? Number(r.until) : null;
    if (!keyword || keyword.length > 50) return { error: 'each keyword must be 1-50 characters' };
    if (!dm || dm.length > 1000) return { error: `DM text for "${keyword}" must be 1-1000 characters` };
    if (postId && !/^\d+$/.test(postId)) return { error: `post ID for "${keyword}" must be digits` };
    if (exclude.length > 200) return { error: `exclude words for "${keyword}" max 200 characters` };
    if (link && !/^https:\/\/[^\s]{3,500}$/.test(link)) return { error: `link for "${keyword}" must start with https:// and have no spaces` };
    if (buttonTitle.length > 20) return { error: `button text for "${keyword}" max 20 characters` };
    if (until !== null && !(until > 0)) return { error: `end date for "${keyword}" is invalid` };
    rules.push({ id: String(r.id || crypto.randomUUID()), match, keyword, dm, postId, enabled: !!r.enabled,
      exclude, link, buttonTitle: link ? buttonTitle : '', until, inbox: !!r.inbox });
  }
  const replyText = lines(body.replyText, 10).join('\n');
  const failReplyText = lines(body.failReplyText, 10).join('\n');
  if ([...replyText.split('\n'), ...failReplyText.split('\n')].some((l) => l.length > 300)) return { error: 'each reply line max 300 characters' };
  return { rules, replyText, replyEnabled: !!body.replyEnabled && !!replyText, failReplyText, dryRun: !!body.dryRun };
}
