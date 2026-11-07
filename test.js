const assert = require('assert');
const fs = require('fs');
const {
  hunt,
  qualify,
  man,
  escapeHtml,
  safeUrl,
  loadHistory,
  rememberSearch,
  renderResults,
  renderHistory
} = require('./core');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function memoryStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const FRESH = '2026-11-01T12:00:00.000Z';
const STALE = '2025-01-01T12:00:00.000Z';

function hnHit(over) {
  return Object.assign({
    objectID: '1001',
    author: 'buyer',
    created_at: FRESH,
    created_at_i: Date.parse(FRESH) / 1000,
    title: '',
    story_title: 'Ask HN: tools',
    story_text: '',
    comment_text: "I'm looking for a tool for a small team CRM. I would pay for something simple.",
    points: 3
  }, over);
}

function buyerText() {
  return "I'm looking for a tool for a small team CRM. I would pay for something simple.";
}

test('buyer-intent post qualifies and states the matched phrase', () => {
  const q = qualify(buyerText(), 'crm');
  assert.ok(q, 'expected a buyer-intent match');
  assert.match(q.reason, /looking for a tool/i);
  assert.match(q.reason, /crm/i);
  assert.match(q.reason, /not (a )?guaranteed buyers?/i);
  assert.equal(q.selfPromo, false);
});

test('self-promotion is rejected even when it borrows buyer language', () => {
  const samples = [
    "Show HN: CRM for founders. I'm looking for a tool review and users.",
    "I built a CRM for small teams. Looking for a tool to compare against and feedback on my product.",
    "We just launched a CRM. Check out our product if you are looking for a tool.",
    "I'm the founder of a CRM startup. Can anyone recommend a place to post it? I would pay for ads."
  ];
  for (const text of samples) {
    const q = qualify(text, 'crm');
    assert.equal(q, null, 'self-promo should not qualify: ' + text.slice(0, 60));
  }
});

test('job-seeking noise is not a buyer signal', () => {
  const q = qualify('Looking for a job writing CRM software. Resume: example.com. Willing to relocate.', 'crm');
  assert.equal(q, null);
});

test('keyword far from the intent phrase does not qualify', () => {
  const text = "I'm looking for a tool. " + ('filler '.repeat(80)) + 'then someone mentioned a CRM.';
  assert.equal(qualify(text, 'crm'), null);
});

test('asking for the product qualifies, and a keyword in the next sentence does not', () => {
  assert.equal(
    qualify('Enterprise were not willing to pay, even many years ago. Large CRM vendors kept raising prices.', 'crm'),
    null
  );
  const direct = qualify("I'm looking for a CRM for our sales team.", 'crm');
  assert.ok(direct, 'looking for the product itself should qualify');
  assert.match(direct.reason, /looking for/i);
  assert.match(direct.reason, /crm/i);
});

test('a nearby keyword that is not the thing being asked for does not qualify', () => {
  const aside = 'Is there a way to sync a passkey? ' + ('padding '.repeat(18)) + 'password manager';
  assert.equal(qualify(aside, 'password manager'), null);
  assert.equal(qualify('They were built to be an alternative to the big vendors, and a password manager is sensitive.', 'password manager'), null);
  const real = qualify('Is there an alternative to a password manager? I would pay for a simple one.', 'password manager');
  assert.ok(real);
  assert.match(real.reason, /alternative/i);
  assert.match(real.reason, /password manager/i);
});

test('zero matches is a real empty result, not an unavailable source', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('reddit.com')) return jsonResponse({ data: { children: [] } });
    return jsonResponse({ hits: [] });
  };
  const r = await hunt('invoice tool', { fetch: fetchImpl, includeReddit: true, now: NOW });
  assert.equal(r.sources.hn.status, 'ok');
  assert.equal(r.sources.hn.count, 0);
  assert.equal(r.sources.reddit.status, 'ok');
  assert.equal(r.sources.reddit.count, 0);
  assert.equal(r.count, 0);
  assert.deepEqual(r.posts, []);
  const html = renderResults(r);
  assert.doesNotMatch(html, /source unavailable/i);
  assert.match(html, /no buyer-intent posts/i);
  assert.match(html, /not (a )?guaranteed buyers?/i);
  assert.ok(urls.some((u) => u.startsWith('https://hn.algolia.com/')));
  assert.ok(urls.some((u) => u.startsWith('https://www.reddit.com/search.json?')));
});

test('upstream network error is source unavailable and does not look like zero matches', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const r = await hunt('invoice', { fetch: fetchImpl, includeReddit: true, now: NOW });
  assert.equal(r.sources.hn.status, 'unavailable');
  assert.equal(r.sources.reddit.status, 'unavailable');
  assert.equal(r.posts.length, 0);
  assert.notEqual(r.sources.hn.status, 'ok');
  const html = renderResults(r);
  assert.match(html, /Hacker News/);
  assert.match(html, /source unavailable/i);
  assert.match(html, /Reddit/);
  assert.doesNotMatch(html, /0 buyer-intent posts/i);
});

test('HTTP 429 and 500 are source unavailable, not an empty success', async () => {
  const fetchImpl = async (url) => {
    const status = String(url).includes('reddit.com') ? 429 : 500;
    return jsonResponse({ message: 'nope' }, status);
  };
  const r = await hunt('crm', { fetch: fetchImpl, includeReddit: true, now: NOW });
  assert.equal(r.sources.hn.status, 'unavailable');
  assert.equal(r.sources.reddit.status, 'unavailable');
  assert.match(r.sources.reddit.error, /429/);
  assert.match(r.sources.reddit.error, /rate limit/i);
  const html = renderResults(r);
  assert.match(html, /source unavailable/i);
  assert.match(html, /429/);
});

test('reddit failure still returns hacker news matches', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('reddit.com')) throw new TypeError('Failed to fetch');
    return jsonResponse({ hits: [hnHit()] });
  };
  const r = await hunt('crm', { fetch: fetchImpl, includeReddit: true, now: NOW });
  assert.equal(r.sources.hn.status, 'ok');
  assert.equal(r.sources.reddit.status, 'unavailable');
  assert.match(r.sources.reddit.error, /blocked|CORS|failed/i);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].source, 'hackernews');
  assert.equal(r.posts[0].url, 'https://news.ycombinator.com/item?id=1001');
  assert.match(r.posts[0].reason, /looking for a tool/i);
  const html = renderResults(r);
  assert.match(html, /source unavailable/i);
  assert.match(html, /https:\/\/news\.ycombinator\.com\/item\?id=1001/);
});

test('reddit success keeps the permalink, drops promo, stale, and duplicate posts', async () => {
  const fresh = Math.floor(NOW / 1000) - 86400;
  const old = Math.floor(NOW / 1000) - 400 * 86400;
  const reddit = {
    data: {
      children: [
        { data: { id: 'abc123', author: 'buyer1', created_utc: fresh, title: 'Looking for a CRM', selftext: 'I am looking for a tool for our sales team CRM. We would pay for it.', permalink: '/r/smallbusiness/comments/abc123/looking_for_a_crm/' } },
        { data: { id: 'abc123', author: 'buyer1', created_utc: fresh, title: 'Looking for a CRM', selftext: 'I am looking for a tool for our sales team CRM. We would pay for it.', permalink: '/r/smallbusiness/comments/abc123/looking_for_a_crm/' } },
        { data: { id: 'promo12', author: 'founder', created_utc: fresh, title: 'I built a CRM', selftext: 'I built a CRM. Looking for a tool review. Check out my product.', permalink: '/r/startups/comments/promo12/i_built_a_crm/' } },
        { data: { id: 'oldold1', author: 'old', created_utc: old, title: 'Looking for a CRM', selftext: 'looking for a tool, a CRM', permalink: '/r/smallbusiness/comments/oldold1/looking_for_a_crm/' } },
        { data: { id: 'evil99', author: 'x', created_utc: fresh, title: 'Looking for a CRM', selftext: 'looking for a tool CRM', permalink: 'javascript:alert(1)' } }
      ]
    }
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('reddit.com')) return jsonResponse(reddit);
    return jsonResponse({ hits: [] });
  };
  const r = await hunt('crm', { fetch: fetchImpl, includeReddit: true, now: NOW });
  assert.equal(r.sources.reddit.status, 'ok');
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].source, 'reddit');
  assert.equal(r.posts[0].url, 'https://www.reddit.com/r/smallbusiness/comments/abc123/looking_for_a_crm/');
  assert.match(r.posts[0].reason, /looking for a crm/i);
  assert.match(r.posts[0].reason, /not (a )?guaranteed buyers?/i);
});

test('duplicate hacker news hits and stale hits collapse', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('reddit.com')) return jsonResponse({ data: { children: [] } });
    return jsonResponse({
      hits: [
        hnHit({ objectID: '1001' }),
        hnHit({ objectID: '1001' }),
        hnHit({ objectID: '1002', created_at: STALE, comment_text: buyerText() }),
        hnHit({ objectID: '99"><script>', comment_text: buyerText() })
      ]
    });
  };
  const r = await hunt('crm', { fetch: fetchImpl, includeReddit: false, now: NOW });
  assert.equal(r.sources.hn.status, 'ok');
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].url, 'https://news.ycombinator.com/item?id=1001');
});

test('skipping reddit does not call it and does not call that zero or unavailable', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return jsonResponse({ hits: [] });
  };
  const r = await hunt('crm', { fetch: fetchImpl, includeReddit: false, now: NOW });
  assert.ok(urls.every((u) => !u.includes('reddit.com')));
  assert.equal(r.sources.reddit.status, 'skipped');
  const html = renderResults(r);
  assert.match(html, /Reddit search off/i);
  assert.doesNotMatch(html, /source unavailable/i);
});

test('injection in posts, reasons, and history is escaped and bad URLs are not links', () => {
  const html = renderResults({
    keyword: '<script>alert(1)</script>',
    count: 1,
    phrases: ['<img src=x onerror=alert(1)>'],
    posts: [{
      source: 'hackernews',
      author: '<img src=x onerror=alert(1)>',
      date: '2026-11-01',
      url: 'javascript:alert(1)',
      snippet: '<script>alert(1)</script> "quoted"',
      reason: '"><script>alert(1)</script>',
      query: '<b>crm</b>'
    }],
    sources: {
      hn: { status: 'ok', count: 1 },
      reddit: { status: 'unavailable', error: '<script>alert(1)</script>' }
    }
  });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /source unavailable/i);
  const history = renderHistory([
    { keyword: '<script>alert(1)</script>', at: '2026-11-07T00:00:00.000Z', phrases: ['<b>looking for x</b>'] }
  ]);
  assert.equal(history.includes('<script>'), false);
  assert.equal(history.includes('<b>'), false);
  assert.match(history, /&lt;script&gt;/);
});

test('safeUrl allows only https Hacker News items and Reddit comment permalinks', () => {
  assert.equal(safeUrl('https://news.ycombinator.com/item?id=1001'), 'https://news.ycombinator.com/item?id=1001');
  assert.equal(safeUrl('https://news.ycombinator.com/item?id=1001&goto=<script>'), 'https://news.ycombinator.com/item?id=1001');
  assert.equal(safeUrl('https://www.reddit.com/r/smallbusiness/comments/abc123/looking_for_a_crm/'), 'https://www.reddit.com/r/smallbusiness/comments/abc123/looking_for_a_crm/');
  assert.equal(safeUrl('https://old.reddit.com/r/smallbusiness/comments/abc123/looking_for_a_crm/?utm_source=x'), 'https://www.reddit.com/r/smallbusiness/comments/abc123/looking_for_a_crm/');
  for (const bad of [
    'javascript:alert(1)',
    'http://news.ycombinator.com/item?id=1001',
    'https://evil.com/item?id=1001',
    'https://news.ycombinator.com.evil.com/item?id=1001',
    'https://www.reddit.com/r/../../../etc/passwd',
    'https://user:pass@www.reddit.com/r/a/comments/abc123/t/',
    '',
    null
  ]) {
    assert.equal(safeUrl(bad), null, 'should reject ' + bad);
  }
});

test('search phrases are saved, deduped, and readable after corrupt storage', () => {
  const storage = memoryStorage();
  const first = rememberSearch(storage, 'crm', ['looking for crm', 'is there a crm'], NOW);
  const second = rememberSearch(storage, 'CRM', ['looking for crm'], NOW + 1000);
  const third = rememberSearch(storage, 'invoice tool', ['looking for invoice tool'], NOW + 2000);
  assert.equal(third[0].keyword, 'invoice tool');
  assert.equal(third.filter((e) => e.keyword.toLowerCase() === 'crm').length, 1);
  assert.deepEqual(loadHistory(storage).map((e) => e.keyword), ['invoice tool', 'crm']);
  assert.ok(first[0].phrases.includes('looking for crm'));
  assert.deepEqual(second[0].phrases, ['looking for crm']);
  storage.setItem('buyer-signal-finder:history', '{not json');
  assert.deepEqual(loadHistory(storage), []);
  const html = renderHistory(rememberSearch(memoryStorage(), '<script>', ['looking for <script>'], NOW));
  assert.equal(html.includes('<script>'), false);
});

test('rendered result shows the source link and the explicit reason', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('reddit.com')) throw new TypeError('Failed to fetch');
    return jsonResponse({ hits: [hnHit()] });
  };
  const r = await hunt('crm', { fetch: fetchImpl, includeReddit: true, now: NOW });
  assert.ok(Array.isArray(r.phrases) && r.phrases.length >= 1);
  assert.match(r.phrases.join(' '), /crm/i);
  const html = renderResults(r);
  assert.match(html, /href="https:\/\/news\.ycombinator\.com\/item\?id=1001"/);
  assert.match(html, /Why this is a signal/);
  assert.match(html, /looking for a tool/);
  assert.match(html, /not (a )?guaranteed buyer/i);
  assert.ok(r.phrases.every((p) => html.includes(escapeHtml(p))));
});

test('man score describes wording only and does not call matches guaranteed buyers', () => {
  const m = man([
    { snippet: 'looking for a tool and would pay $20' },
    { snippet: 'looking for a tool' }
  ]);
  assert.ok(m.need >= 2);
  assert.ok(m.money >= 2);
  assert.match(m.verdict, /not guaranteed buyers/i);
  const none = man([]);
  assert.match(none.verdict, /no buyer-intent/i);
});

(async () => {
  const results = [];
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
      console.log('PASS ' + t.name);
    } catch (e) {
      failed++;
      results.push({ name: t.name, ok: false, error: e && e.stack ? e.stack : String(e) });
      console.error('FAIL ' + t.name);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  const out = {
    run: new Date().toISOString(),
    passed: tests.length - failed,
    failed,
    results: results.map((r) => ({ name: r.name, ok: r.ok, error: r.ok ? undefined : String(r.error).split('\n')[0] }))
  };
  fs.writeFileSync('test-results.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ passed: out.passed, failed: out.failed }));
  process.exit(failed ? 1 : 0);
})();
