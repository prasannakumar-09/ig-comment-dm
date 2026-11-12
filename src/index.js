import html from './dashboard.html';
import { API, MAX_DMS, MAX_MEDIA, collectComments, commentStatus, defaults, isRateLimit, plainText, processComments, processInbox, pruneInbox, validateConfig } from './core.js';

const KEY = 'state'; // the only KV key
// Fields from the earlier Instagram-Login version (the token must not stay in KV). Dropped on next save.
const LEGACY = ['token', 'tokenFp', 'tokenRefreshedAt', 'tokenExpiresAt', 'tokenError'];

const load = async (env) => {
  // cacheTtl 30 = KV's minimum edge cache (default 60), so runs and the dashboard see fresh data sooner.
  const s = { ...defaults(), ...((await env.KV.get(KEY, { type: 'json', cacheTtl: 30 })) || {}) };
  for (const k of LEGACY) delete s[k];
  return s;
};
const save = (env, s) => env.KV.put(KEY, JSON.stringify(s));

const sha256 = async (text) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

// Graph API call. Token goes in the Authorization header, never in the URL.
async function ig(token, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw Object.assign(new Error(body.error?.message || `HTTP ${res.status}`), {
      code: body.error?.code,
      status: res.status,
    });
  }
  return body;
}
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

// replies{...} rides along in the same request, so "you already replied" costs no extra subrequest.
const COMMENT_FIELDS = encodeURIComponent('id,text,username,timestamp,like_count,from{id,username},replies{username,from{id,username}}');
const commentPage = (token) => (mid, after) =>
  ig(token, `/${mid}/comments?fields=${COMMENT_FIELDS}&limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`);

// Comments tab: every recent comment plus what the tool did / will do with it. Read-only, no KV writes.
async function commentsView(env) {
  const s = await load(env);
  const now = Date.now();
  const media = (await ig(env.IG_TOKEN, `/${env.IG_USER_ID}/media?fields=id,caption,permalink,timestamp,comments_count&limit=${MAX_MEDIA}`)).data || [];
  const { comments } = await collectComments(media, commentPage(env.IG_TOKEN), 48, now); // 1 media + 48 pages + KV read < 50
  const byCid = Object.fromEntries(s.log.filter((e) => e.cid).map((e) => [e.cid, e]));
  return {
    loadedAt: now,
    posts: media.map(({ id, caption, permalink, timestamp, comments_count }) => ({ id, caption: (caption || '').slice(0, 120), permalink, timestamp, comments: comments_count })),
    comments: comments.map((c) => {
      const { status, rule } = commentStatus(c, s, now);
      const e = byCid[c.id]; // DM result, for comments handled since the log started recording comment IDs
      const result = status !== 'handled' || !e ? status : e.skipped ? 'skipped' : e.ok ? 'sent' : 'failed';
      return { id: c.id, mediaId: c.mediaId, user: c.username || c.from?.username || '?', text: c.text, t: Date.parse(c.timestamp), likes: c.like_count || 0, replies: (c.replies?.data || []).length, status: result, rule: rule?.keyword || null, error: e?.error || null };
    }),
  };
}

async function run(env, manual = false) {
  if (!env.IG_TOKEN || !env.IG_USER_ID) return { error: 'IG_TOKEN secret or IG_USER_ID var is not set' };
  const token = env.IG_TOKEN;
  const id = env.IG_USER_ID;
  const s = await load(env);
  const now = Date.now();
  // KV has no locks: keep "Run now" away from the cron (fires at :00, :05, ...) and from a recent run.
  if (manual && (new Date(now).getUTCMinutes() % 5 === 0 || now - (s.lastRunAt || 0) < 120e3))
    return { skipped: 'A scheduled run may be in progress. Try again in a minute.' };

  let dirty = false;
  let calls = 0; // Instagram calls made before the comment pages, so pages + sends stay within 50 subrequests
  try {
    if (s.userId !== id || !s.username) {
      const me = await ig(token, `/${id}?fields=username`);
      Object.assign(s, { userId: id, username: me.username });
      dirty = true;
      calls++;
    }

    const saveNow = async (st) => { await save(env, st); dirty = false; };
    // Rich messages (button / quick replies) fall back to plain text if Instagram refuses them (costs one more call).
    const sendWithFallback = async (recipient, message) => {
      try {
        return await ig(token, `/${id}/messages`, post({ recipient, message }));
      } catch (e) {
        if (isRateLimit(e) || /already has a reply/i.test(e.message) || !(message.attachment || message.quick_replies)) throw e;
        return ig(token, `/${id}/messages`, post({ recipient, message: { text: plainText(message) } }));
      }
    };
    pruneInbox(s, now);

    // 1) Inbox first (people waiting on a follow gate / DM keywords are inside a 24 h window). Max 1 + 2×5 calls.
    let inbox = { handled: 0 };
    if (s.rules.some((r) => r.enabled && (r.gate || r.inbox)) || Object.keys(s.gates).length) {
      const f = encodeURIComponent('updated_time,participants,messages.limit(3){from,message,created_time}');
      const data = (await ig(token, `/${id}/conversations?platform=instagram&fields=${f}&limit=15`)).data || [];
      calls++;
      const convs = data
        .filter((c) => now - Date.parse(c.updated_time) < 864e5)
        .map((c) => {
          const other = (c.participants?.data || []).find((p) => p.id !== id) || {};
          const msgs = (c.messages?.data || []).filter((m) => m.from?.id && m.from.id !== id)
            .map((m) => ({ id: m.id, text: m.message || '', at: Date.parse(m.created_time) }));
          return { pid: other.id, user: other.username || '?', msgs };
        })
        .filter((c) => c.pid && c.msgs.length);
      inbox = await processInbox(s, convs, {
        save: saveNow,
        follows: async (pid) => { calls++; return (await ig(token, `/${pid}?fields=is_user_follow_business`)).is_user_follow_business === true; },
        send: (pid, message) => { calls++; return sendWithFallback({ id: pid }, message); },
      }, now);
    }

    // 2) Comments. 50 subrequests per run: keep 2 per possible DM (DM + public reply), rest on comment pages.
    const media = (await ig(token, `/${id}/media?fields=id,permalink,timestamp&limit=${MAX_MEDIA}`)).data || [];
    calls++;
    const pageBudget = Math.max(1, 50 - calls - 2 * MAX_DMS);
    const { comments, pages } = await collectComments(media, commentPage(token), pageBudget, now);

    if (s.lastError && !s.lastError.msg.startsWith('Rate limited')) {
      s.lastError = null; // reached Instagram fine: clear a stale error (one write, only when one exists)
      dirty = true;
    }

    const res = await processComments(
      s,
      comments,
      {
        save: saveNow,
        dm: (cid, message) => sendWithFallback({ comment_id: cid }, message),
        reply: (cid, message) => ig(token, `/${cid}/replies`, post({ message })),
      },
      now
    );
    if (dirty) await save(env, s);
    return { ...res, inbox: inbox.handled, posts: media.length, pages, comments: comments.length };
  } catch (e) {
    const msg = isRateLimit(e) ? 'Rate limited by Instagram. Will retry next run.' : e.message;
    // Only write when the error changes, so a broken token doesn't burn the KV write quota.
    if (dirty || s.lastError?.msg !== msg) {
      s.lastError = { at: now, msg };
      await save(env, s);
    }
    return { error: msg };
  }
}

async function authed(req, env) {
  if (!env.DASH_PASSWORD) return false;
  let pass = '';
  try {
    const h = req.headers.get('Authorization') || '';
    if (h.startsWith('Basic ')) pass = atob(h.slice(6)).split(':').slice(1).join(':');
  } catch {
    return false;
  }
  const [a, b] = await Promise.all([sha256(pass), sha256(env.DASH_PASSWORD)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const publicView = (s, env) => ({
  rules: s.rules,
  replyText: s.replyText,
  failReplyText: s.failReplyText,
  gateText: s.gateText,
  trackClicks: s.trackClicks !== false,
  waitingOnFollow: Object.keys(s.gates || {}).length,
  replyEnabled: s.replyEnabled,
  dryRun: s.dryRun,
  log: s.log,
  username: s.username,
  hasToken: !!env.IG_TOKEN,
  lastRunAt: s.lastRunAt,
  lastRun: s.lastRun || null,
  lastError: s.lastError,
  version: env.VERSION?.id || null, // dashboard reloads itself when this changes after a deploy
});

export default {
  async fetch(req, env, ctx) {
    const lm = new URL(req.url).pathname.match(/^\/l\/([\w-]{1,64})$/);
    if (req.method === 'GET' && lm) return click(env, ctx, lm[1]); // public: people tap these links in DMs
    if (!(await authed(req, env)))
      return new Response('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="ig-dm"' } });

    const { pathname } = new URL(req.url);
    const m = req.method;
    // Mutating calls must be JSON: forces a CORS preflight, so other sites can't trigger them with your saved login.
    if (m !== 'GET' && !(req.headers.get('Content-Type') || '').startsWith('application/json'))
      return json({ error: 'JSON required' }, 415);

    if (m === 'GET' && pathname === '/')
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (m === 'GET' && pathname === '/api/state')
      return json({ ...publicView(await load(env), env), clicks: (await env.KV.get(CLICK_KEY, { type: 'json', cacheTtl: 30 })) || {} });
    if (m === 'GET' && pathname === '/api/posts') {
      if (!env.IG_TOKEN || !env.IG_USER_ID) return json({ error: 'IG_TOKEN or IG_USER_ID not set' }, 400);
      try {
        return json((await ig(env.IG_TOKEN, `/${env.IG_USER_ID}/media?fields=id,caption,permalink,timestamp&limit=25`)).data || []);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    if (m === 'GET' && pathname === '/api/comments') {
      if (!env.IG_TOKEN || !env.IG_USER_ID) return json({ error: 'IG_TOKEN or IG_USER_ID not set' }, 400);
      try {
        return json(await commentsView(env));
      } catch (e) {
        return json({ error: isRateLimit(e) ? 'Instagram rate limit. Try again in a few minutes.' : e.message }, 502);
      }
    }
    if (m === 'PUT' && pathname === '/api/config') {
      const cfg = validateConfig(await req.json().catch(() => null));
      if (cfg.error) return json(cfg, 400);
      const s = await load(env);
      if (s.dryRun && !cfg.dryRun) s.dryHandled = {}; // dry-run "handled" must not block real DMs
      Object.assign(s, cfg, { origin: new URL(req.url).origin }); // the 5-minute run has no URL; it builds /l/ links from this
      await save(env, s);
      return json(publicView(s, env));
    }
    if (m === 'POST' && pathname === '/api/run') return json(await run(env, true));
    return json({ error: 'not found' }, 404);
  },

  async scheduled(_event, env, ctx) {
    // Logged so `wrangler tail` / Cloudflare's logs show what each automatic run did.
    ctx.waitUntil(run(env).then((r) => console.log('scheduled run', JSON.stringify(r))));
  },
};

// ---------- click tracking: /l/<rule id> -> 302 to that rule's own link ----------
// Counted in memory, written at most every 10 min to a SEPARATE key ("clicks"), so a viral reel can never use up
// the KV write quota that DM sending needs, and a click can never overwrite the DM state. Counts are approximate
// (an isolate that shuts down before flushing loses its unflushed clicks).
const CLICK_KEY = 'clicks';
let pending = {}, lastFlush = Date.now();
async function click(env, ctx, ruleId) {
  const s = await load(env);
  const rule = s.rules.find((r) => r.id === ruleId);
  if (!rule?.link) return new Response('Link not found', { status: 404 });
  pending[ruleId] = (pending[ruleId] || 0) + 1;
  if (Date.now() - lastFlush > 600e3) {
    const batch = pending; pending = {}; lastFlush = Date.now();
    ctx.waitUntil((async () => {
      const c = (await env.KV.get(CLICK_KEY, 'json')) || {};
      for (const [k, n] of Object.entries(batch)) c[k] = (c[k] || 0) + n;
      await env.KV.put(CLICK_KEY, JSON.stringify(c));
    })());
  }
  return Response.redirect(rule.link, 302); // only ever a link you stored in a rule: no open redirect
}
