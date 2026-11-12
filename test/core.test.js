import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasWord, matchRule, pickWork, pickLine, dmMessage, plainText, GATE_DONE, processInbox, commentStatus, processComments, collectComments, defaults, validateConfig, MAX_DMS, WEEK } from '../src/core.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString().replace('.000Z', '+0000');
const rule = (keyword, extra = {}) => ({ id: keyword, keyword, dm: `here is ${keyword}`, postId: '', enabled: true, ...extra });
const comment = (id, text, extra = {}) => ({
  id, text, timestamp: ago(1), username: `user${id}`, from: { id: `ig${id}`, username: `user${id}` }, mediaId: '111', ...extra,
});
const state = (over = {}) => ({ ...defaults(), dryRun: false, userId: 'me1', username: 'myshop', rules: [rule('link')], ...over });

// fake API that records calls and snapshots of what was saved
function fakeApi({ dmError, replyError, saveFailAt } = {}) {
  const calls = { dm: [], reply: [], saves: [] };
  return {
    calls,
    save: async (s) => {
      if (calls.saves.length === saveFailAt) throw new Error('crash');
      calls.saves.push(JSON.parse(JSON.stringify(s)));
    },
    dm: async (id, text) => {
      calls.dm.push({ id, text, handledAtSendTime: !!calls.saves.at(-1)?.handled[id] });
      const err = typeof dmError === 'function' ? dmError(id) : dmError;
      if (err) throw err;
    },
    reply: async (id, text) => {
      calls.reply.push({ id, text });
      if (replyError) throw replyError;
    },
  };
}

// ---------- keyword matching ----------
test('whole word, any letter case', () => {
  assert.ok(hasWord('Link please', 'link'));
  assert.ok(hasWord('send LINK', 'link'));
  assert.ok(hasWord('link!!!', 'link'));
  assert.ok(hasWord('"link"', 'link'));
  assert.ok(hasWord('🔥link🔥', 'link'));
  assert.ok(hasWord('line one\nlink', 'link'));
});

test('spaces, invisible characters and fancy fonts still match', () => {
  for (const t of ['learn', ' learn ', 'learn  please', 'learn ', 'le​arn', 'ʟᴇᴀʀɴ', '𝐥𝐞𝐚𝐫𝐧', '𝘭𝘦𝘢𝘳𝘯', 'ｌｅａｒｎ', 'Learn!!', '#learn'])
    assert.ok(hasWord(t, 'Learn'), JSON.stringify(t));
  assert.ok(hasWord('learn', ' LEARN '));
  assert.ok(hasWord('learn', 'ʟᴇᴀʀɴ')); // keyword typed in a fancy font too
  assert.ok(!hasWord('learning', 'learn'));
  assert.ok(!hasWord('ʟᴇᴀʀɴɪɴɢ', 'learn'));
});

test('does not match inside other words', () => {
  assert.ok(!hasWord('linkedin', 'link'));
  assert.ok(!hasWord('hyperlink', 'link'));
  assert.ok(!hasWord('link_2', 'link'));
  assert.ok(!hasWord('links', 'link'));
  assert.ok(!hasWord('', 'link'));
  assert.ok(!hasWord('link', '  '));
});

test('multi-word and special-character keywords', () => {
  assert.ok(hasWord('Free   Guide please', 'free guide'));
  assert.ok(!hasWord('freeguide', 'free guide'));
  assert.ok(hasWord('I want c++ now', 'c++'));
  assert.ok(hasWord('Ça va? GUIDE', 'guide'));
  assert.ok(!hasWord('aguide', 'guide'));
});

test('rule matching respects on/off and post ID', () => {
  const rules = [rule('off', { enabled: false }), rule('one', { postId: '222' }), rule('all')];
  assert.equal(matchRule('off', '111', rules), null);
  assert.equal(matchRule('one', '111', rules), null);
  assert.equal(matchRule('one', '222', rules).keyword, 'one');
  assert.equal(matchRule('ALL', '999', rules).keyword, 'all');
  assert.equal(matchRule('nothing here', '111', rules), null);
});

test('a specific emoji works as a keyword', () => {
  assert.ok(hasWord('love it 🔥🔥', '🔥'));
  assert.ok(hasWord('🔥', '🔥'));
  assert.ok(!hasWord('love it 😍', '🔥'));
});

test('"any emoji" rule matches comments with any emoji', () => {
  const rules = [rule('any emoji', { match: 'emoji' })];
  for (const t of ['😍', 'nice 🔥', 'wow ❤️', '👏🏽 great', '🇮🇳', 'step 1️⃣'])assert.ok(matchRule(t, '111', rules), t);
  for (const t of ['nice post', 'price? 100%', 'ok :)', '', '123']) assert.equal(matchRule(t, '111', rules), null, t);
});

test('keyword rules win over the "any emoji" rule, whatever the order', () => {
  const rules = [rule('any emoji', { match: 'emoji' }), rule('link')];
  assert.equal(matchRule('LINK 🔥', '111', rules).keyword, 'link');
  assert.equal(matchRule('🔥🔥', '111', rules).keyword, 'any emoji');
  rules[0].enabled = false;
  assert.equal(matchRule('🔥🔥', '111', rules), null);
});

test('comment status explains every outcome', () => {
  const s = state({ handled: { h: NOW } });
  const st = (c) => commentStatus(c, s, NOW).status;
  assert.equal(st(comment('a', 'link')), 'queued');
  assert.equal(st(comment('h', 'link')), 'handled');
  assert.equal(st(comment('b', 'nice post')), 'nomatch');
  assert.equal(st(comment('c', 'link', { timestamp: ago(24 * 8) })), 'old');
  assert.equal(st(comment('d', 'link', { from: { id: 'me1' }, username: 'myshop' })), 'mine');
  assert.equal(st(comment('e', 'link', { replies: { data: [{ username: 'myshop' }] } })), 'replied');
  assert.equal(commentStatus(comment('a', 'LINK'), s, NOW).rule.keyword, 'link');
});

// ---------- reading comment pages ----------
function fakePages(posts) {
  // posts: { id: [page1Comments, page2Comments, ...] }; comments newest first
  const calls = [];
  const fetchPage = async (id, after) => {
    calls.push(`${id}:${after ?? 0}`);
    const i = after ? Number(after) : 0, pages = posts[id];
    return { data: pages[i], ...(i + 1 < pages.length ? { paging: { next: 'x', cursors: { after: String(i + 1) } } } : {}) };
  };
  return { calls, fetchPage };
}
const page = (prefix, n, hoursAgo) => Array.from({ length: n }, (_, k) => ({ id: `${prefix}${k}`, text: 'x', timestamp: ago(hoursAgo + k / 100) }));

test('follows next pages while comments are under 7 days old, stops at older ones', async () => {
  const f = fakePages({ busy: [page('a', 25, 1), page('b', 25, 30), page('c', 25, 24 * 8), page('d', 25, 24 * 9)], quiet: [page('q', 3, 2)] });
  const { comments, pages } = await collectComments([{ id: 'busy' }, { id: 'quiet' }], f.fetchPage, 19, NOW);
  assert.equal(pages, 4); // busy p1, quiet p1, busy p2, busy p3 (p3 is older than 7 days, so p4 is never read)
  assert.equal(comments.length, 78);
  assert.ok(!f.calls.includes('busy:3'));
  assert.equal(comments.find((c) => c.id === 'b0').mediaId, 'busy');
});

test('never uses more page requests than the budget', async () => {
  const f = fakePages({ p: Array.from({ length: 10 }, (_, i) => page(`p${i}-`, 25, 1 + i)) });
  const { pages } = await collectComments([{ id: 'p' }], f.fetchPage, 4, NOW);
  assert.equal(pages, 4);
  assert.equal(f.calls.length, 4);
});

test('rate limit on any page stops the run; all pages failing is an error', async () => {
  const limited = async () => { throw Object.assign(new Error('limit'), { code: 4 }); };
  await assert.rejects(collectComments([{ id: 'a' }], limited, 10, NOW), /limit/);
  const broken = async () => { throw new Error('bad field'); };
  await assert.rejects(collectComments([{ id: 'a' }, { id: 'b' }], broken, 10, NOW), /bad field/);
});

// ---------- picking ----------
test('skips own comments, old comments, non-matching and handled ones', () => {
  const s = state({ handled: { h: NOW } });
  const comments = [
    comment('ok', 'link'),
    comment('mine', 'link', { from: { id: 'me1', username: 'myshop' }, username: 'myshop' }),
    comment('mine2', 'link', { from: { id: 'other' }, username: 'MyShop' }),
    comment('old', 'link', { timestamp: ago(24 * 7 + 1) }),
    comment('nomatch', 'nice post'),
    comment('h', 'link'),
  ];
  assert.deepEqual(pickWork(comments, s, NOW).map((p) => p.c.id), ['ok']);
});

test('skips comments you already replied to yourself', () => {
  const s = state();
  const comments = [
    comment('mine-replied', 'link', { replies: { data: [{ id: 'r1', username: 'myshop', from: { id: 'me1', username: 'myshop' } }] } }),
    comment('mine-replied-name', 'link', { replies: { data: [{ id: 'r2', username: 'MyShop' }] } }),
    comment('others-replied', 'link', { replies: { data: [{ id: 'r3', username: 'friend', from: { id: 'x', username: 'friend' } }] } }),
    comment('no-replies', 'link'),
  ];
  assert.deepEqual(pickWork(comments, s, NOW).map((p) => p.c.id).sort(), ['no-replies', 'others-replied']);
});

test('failed DM: public "couldn\'t DM you" reply, not the normal one; off when text is empty', async () => {
  const blocked = () => Object.assign(new Error('This person isn\'t available right now.'), { code: 551 });
  const s = state({ failReplyText: 'Could not DM you' });
  const api = fakeApi({ dmError: blocked() });
  await processComments(s, [comment('1', 'link')], api, NOW);
  assert.deepEqual(api.calls.reply, [{ id: '1', text: 'Could not DM you' }]);
  assert.match(s.log[0].error, /Told them in a public reply/);
  const off = fakeApi({ dmError: blocked() });
  await processComments(state({ failReplyText: '' }), [comment('2', 'link')], off, NOW);
  assert.equal(off.calls.reply.length, 0);
});

test('"already has a reply" is logged as skipped, not an error, and gets no public reply', async () => {
  const s = state();
  const api = fakeApi({ dmError: Object.assign(new Error('(#-1) The comment that you are trying to reply to already has a reply.'), { code: -1 }) });
  await processComments(s, [comment('1', 'link')], api, NOW);
  assert.equal(s.log[0].skipped, true);
  assert.equal(api.calls.reply.length, 0);
  assert.ok(s.handled['1']); // never retried
});

test('caps at 15 per run, oldest first', () => {
  const comments = Array.from({ length: 20 }, (_, i) => comment(`c${i}`, 'link', { timestamp: ago(i + 1) }));
  const picks = pickWork(comments, state(), NOW);
  assert.equal(picks.length, MAX_DMS);
  assert.equal(picks[0].c.id, 'c19'); // oldest
});

// ---------- no duplicates ----------
test('comment is saved as handled BEFORE the DM is sent', async () => {
  const s = state();
  const api = fakeApi();
  const r = await processComments(s, [comment('1', 'link')], api, NOW);
  assert.equal(r.sent, 1);
  assert.equal(api.calls.dm.length, 1);
  assert.equal(api.calls.dm[0].handledAtSendTime, true);
  assert.equal(api.calls.reply.length, 1);
  assert.equal(s.log[0].ok, true);
});

test('run summary: "sending" saved before the DMs, final counts saved after', async () => {
  const s = state();
  const api = fakeApi({ dmError: (id) => (id === '2' ? Object.assign(new Error('blocked'), { code: 10 }) : id === '3' ? new Error('(#-1) ... already has a reply.') : null) });
  await processComments(s, ['1', '2', '3'].map((id) => comment(id, 'link')), api, NOW);
  assert.deepEqual(api.calls.saves[0].lastRun, { at: NOW, total: 3, sent: 0, failed: 0, skipped: 0, dry: false, done: false });
  assert.deepEqual(s.lastRun, { at: NOW, total: 3, sent: 1, failed: 1, skipped: 1, dry: false, done: true });
  assert.equal(api.calls.saves.length, 2); // no extra writes for the summary
});

test('second run with the same comments sends nothing', async () => {
  const s = state();
  const api = fakeApi();
  const comments = [comment('1', 'link'), comment('2', 'LINK')];
  await processComments(s, comments, api, NOW);
  await processComments(s, comments, api, NOW + 300e3);
  assert.equal(api.calls.dm.length, 2);
});

test('crash after sending (final save fails) still never re-sends', async () => {
  const s = state();
  const crashing = fakeApi({ saveFailAt: 1 }); // first save ok, second save crashes
  await assert.rejects(processComments(s, [comment('1', 'link')], crashing, NOW));
  // next run starts from what was actually stored in KV: the first save
  const stored = crashing.calls.saves[0];
  const api = fakeApi();
  await processComments(stored, [comment('1', 'link')], api, NOW + 300e3);
  assert.equal(crashing.calls.dm.length + api.calls.dm.length, 1);
});

test('failed DM (non rate limit) is logged and not retried', async () => {
  const s = state();
  const api = fakeApi({ dmError: Object.assign(new Error('user blocked'), { code: 10 }) });
  await processComments(s, [comment('1', 'link')], api, NOW);
  await processComments(s, [comment('1', 'link')], api, NOW + 300e3);
  assert.equal(api.calls.dm.length, 1);
  assert.ok(!api.calls.reply.some((r) => r.text === s.replyText)); // never "Sent you a DM" when it failed
  assert.equal(s.log[0].ok, false);
});

test('rate limit stops the run and un-marks unsent comments for the next run', async () => {
  const s = state();
  const limited = new Set(['2']);
  const api = fakeApi({ dmError: (id) => (limited.has(id) ? Object.assign(new Error('too many'), { code: 4 }) : null) });
  const comments = ['1', '2', '3'].map((id, i) => comment(id, 'link', { timestamp: ago(3 - i) }));
  const r = await processComments(s, comments, api, NOW);
  assert.equal(r.rateLimited, true);
  assert.deepEqual(api.calls.dm.map((d) => d.id), ['1', '2']); // stopped, '3' never tried
  assert.deepEqual(Object.keys(s.handled), ['1']);
  limited.clear();
  await processComments(s, comments, api, NOW + 300e3);
  assert.deepEqual(api.calls.dm.map((d) => d.id), ['1', '2', '2', '3']); // '1' never twice
});

test('dry run sends nothing, logs, and does not block the real send later', async () => {
  const s = state({ dryRun: true });
  const api = fakeApi();
  await processComments(s, [comment('1', 'link')], api, NOW);
  await processComments(s, [comment('1', 'link')], api, NOW + 60e3); // no repeat log in dry run
  assert.equal(api.calls.dm.length, 0);
  assert.equal(s.log.length, 1);
  assert.equal(s.log[0].dry, true);
  s.dryRun = false;
  s.dryHandled = {}; // what the dashboard does when dry run is switched off
  await processComments(s, [comment('1', 'link')], api, NOW + 120e3);
  assert.equal(api.calls.dm.length, 1);
});

test('handled IDs older than 7 days are pruned; log keeps 100', async () => {
  const s = state({ handled: { stale: NOW - WEEK - 1 }, log: Array(100).fill({ t: 0 }) });
  await processComments(s, [comment('1', 'link')], fakeApi(), NOW);
  assert.ok(!('stale' in s.handled));
  assert.equal(s.log.length, 100);
});

test('no work means no KV writes', async () => {
  const api = fakeApi();
  await processComments(state(), [comment('1', 'hello')], api, NOW);
  assert.equal(api.calls.saves.length, 0);
});

// ---------- new rule options ----------
test('"any comment" trigger has lowest priority; exclude words and end date', () => {
  const rules = [rule('any comment', { match: 'any', exclude: 'scam, spam' }), rule('link'), rule('old', { until: NOW - 1 })];
  assert.equal(matchRule('LINK pls', '1', rules, NOW).keyword, 'link');
  assert.equal(matchRule('nice video', '1', rules, NOW).keyword, 'any comment');
  assert.equal(matchRule('this is a SCAM', '1', rules, NOW), null);
  assert.equal(matchRule('old', '1', rules, NOW).keyword, 'any comment'); // "old" rule expired, falls through to any
  assert.equal(matchRule('   ', '1', rules, NOW), null);
});

test('reply variations: one line per comment, stable per comment, varied across comments', () => {
  const text = 'Sent! 📩\nCheck your DMs 🙌\nJust sent it ✨';
  assert.equal(pickLine(text, 'c1'), pickLine(text, 'c1'));
  const picks = new Set(Array.from({ length: 30 }, (_, i) => pickLine(text, 'c' + i)));
  assert.ok(picks.size >= 2);
  assert.equal(pickLine('Only one', 'x'), 'Only one');
});

test('DM message: plain, link appended, button template, tracked link, plain-text fallback', () => {
  assert.deepEqual(dmMessage({ dm: 'hi' }), { text: 'hi' });
  assert.deepEqual(dmMessage({ dm: 'hi', link: 'https://x.co' }), { text: 'hi\nhttps://x.co' });
  const b = dmMessage({ id: 'r1', dm: 'hi', link: 'https://x.co', buttonTitle: 'Open' }, { origin: 'https://w.dev' });
  assert.equal(b.attachment.payload.buttons[0].url, 'https://w.dev/l/r1');
  assert.equal(plainText(b), 'hi\nhttps://w.dev/l/r1');
  assert.equal(dmMessage({ id: 'r1', dm: 'hi', link: 'https://x.co' }, { origin: 'https://w.dev', trackClicks: false }).text, 'hi\nhttps://x.co');
});

test('follow-gated comment: first DM asks to follow (with Done button) and remembers who', async () => {
  const s = state({ rules: [rule('link', { gate: true })] });
  const api = fakeApi();
  api.dm = async (id, msg) => { api.calls.dm.push({ id, msg }); return { recipient_id: 'igsid-1' }; };
  await processComments(s, [comment('1', 'link')], api, NOW);
  assert.equal(api.calls.dm[0].msg.quick_replies[0].title, GATE_DONE);
  assert.equal(s.gates['igsid-1'].rid, 'link');
  assert.equal(s.log[0].gate, 'asked');
});

// ---------- inbox: follow gate + DM keywords ----------
function inboxApi(follows) {
  const calls = { send: [], saves: [] };
  return {
    calls,
    save: async (s) => calls.saves.push(JSON.parse(JSON.stringify(s))),
    follows: async () => follows(),
    send: async (pid, msg) => calls.send.push({ pid, text: msg.text || plainText(msg), seenAtSend: !!calls.saves.at(-1)?.inboxSeen[pid] }),
  };
}
const conv = (pid, text, minsAgo = 1) => ({ pid, user: 'u_' + pid, msgs: [{ id: 'm' + pid + minsAgo, text, at: NOW - minsAgo * 60e3 }] });

test('follow gate: follower gets the link (marked handled first); non-follower asked again, gives up after 3', async () => {
  const r = rule('link', { gate: true, dm: 'here', link: 'https://x.co' });
  const s = state({ rules: [r], gates: { p1: { rid: 'link', user: 'a', at: NOW - 60e3, n: 1 }, p2: { rid: 'link', user: 'b', at: NOW - 60e3, n: 1 } } });
  let followers = new Set(['p1']);
  const api = inboxApi(() => false);
  api.follows = async (pid) => followers.has(pid);
  await processInbox(s, [conv('p1', 'Done ✅'), conv('p2', 'done')], api, NOW);
  assert.deepEqual(api.calls.send.map((x) => [x.pid, x.text.startsWith('here'), x.seenAtSend]), [['p1', true, true], ['p2', false, true]]);
  assert.ok(!s.gates.p1); assert.equal(s.gates.p2.n, 2);
  // same messages again: nothing new happens (no duplicate link)
  await processInbox(s, [conv('p1', 'Done ✅'), conv('p2', 'done')], api, NOW + 1);
  assert.equal(api.calls.send.length, 2);
  // p2 keeps tapping without following: asked at n=2, then n=3, then gives up
  await processInbox(s, [conv('p2', 'done', 0.5)], api, NOW + 2);
  await processInbox(s, [conv('p2', 'done', 0.2)], api, NOW + 3);
  assert.ok(!s.gates.p2);
  assert.equal(s.log[0].gate, 'gave up');
});

test('DM keywords / story replies: only rules marked "also in DMs", 24 h window, no follow check unless gated', async () => {
  const s = state({ rules: [rule('auto', { inbox: true, dm: 'repo' }), rule('link')] });
  const api = inboxApi(() => { throw new Error('should not check'); });
  await processInbox(s, [conv('a', 'AUTO please'), conv('b', 'link'), conv('c', 'auto', 60 * 25)], api, NOW);
  assert.deepEqual(api.calls.send.map((x) => [x.pid, x.text]), [['a', 'repo']]);
  assert.equal(s.log[0].via, 'DM keyword');
});

test('inbox: gated DM keyword checks follow right away (they messaged, so consent exists)', async () => {
  const s = state({ rules: [rule('auto', { inbox: true, gate: true, dm: 'repo' })] });
  const api = inboxApi(() => true);
  await processInbox(s, [conv('a', 'auto')], api, NOW);
  assert.equal(api.calls.send[0].text, 'repo');
  assert.ok(!s.gates.a);
});

// ---------- dashboard input ----------
test('config validation', () => {
  assert.ok(validateConfig({ rules: [{ keyword: '', dm: 'x' }] }).error);
  assert.ok(validateConfig({ rules: [{ keyword: 'a', dm: 'x', postId: '12; drop' }] }).error);
  const ok = validateConfig({ rules: [{ keyword: ' Link ', dm: 'go', enabled: 1 }], replyText: '', replyEnabled: true });
  assert.equal(ok.rules[0].keyword, 'Link');
  assert.equal(ok.replyEnabled, false); // empty text turns reply off
  assert.ok(validateConfig({ rules: [{ keyword: 'a', dm: 'x', link: 'http://insecure.com' }] }).error);
  assert.ok(validateConfig({ rules: [{ keyword: 'a', dm: 'x', link: 'https://ok.com', buttonTitle: 'way too long for a button' }] }).error);
  const full = validateConfig({ rules: [{ match: 'any', dm: 'x', enabled: true, gate: 1, inbox: 1, exclude: 'spam', link: 'https://ok.com', buttonTitle: 'Open', until: NOW }], replyText: 'a\n\n b \nc' });
  assert.deepEqual([full.rules[0].keyword, full.rules[0].gate, full.rules[0].inbox, full.rules[0].until, full.replyText], ['any comment', true, true, NOW, 'a\nb\nc']);
  const emoji = validateConfig({ rules: [{ match: 'emoji', keyword: '', dm: 'hi', enabled: true }] });
  assert.equal(emoji.rules[0].keyword, 'any emoji'); // no keyword needed
  assert.equal(validateConfig({ rules: [{ keyword: 'x', dm: 'y' }] }).rules[0].match, 'keyword'); // old rules stay keyword rules
});
