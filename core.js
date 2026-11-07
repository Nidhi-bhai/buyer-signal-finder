// Buyer Signal Finder
// Hacker News via the public Algolia API, plus optional public Reddit search.json.
// A match is buyer-intent language in a public post. It is not a guaranteed buyer.
// Reddit search.json often fails in the browser (CORS or a block). That is "source unavailable",
// never a fake empty result. Hacker News still runs.

const HISTORY_KEY = 'buyer-signal-finder:history';
const MAX_HISTORY = 20;
const MAX_POSTS = 40;
const DEFAULT_DAYS = 180;

const INTENT = /\b(i(?:'m| am) looking for an? (?:good |simple |cheap )?(?:tool|app|service|way)|looking for an? (?:good |simple |cheap )?(?:tool|app|service|saas|alternative)|is there an? (?:tool|app|service|way|alternative)|any (?:good )?(?:tool|app|service)s? (?:for|that)|can (?:anyone|someone) recommend|i'?d (?:happily )?pay|would pay for|willing to pay|wish there (?:was|were) an?|we need an? (?:tool|way)|(?:looking for|any|what are) (?:an? |some )?alternatives? to)\b/i;

const SELF_PROMO = /\b(show hn\b|i(?:'m| am) the (?:founder|creator|maker)\b|i (?:just )?(?:built|made|launched|shipped|created|wrote) (?:a |an |my |our |this )|we (?:just )?(?:built|made|launched|shipped|created) (?:a |an |my |our |this )?|check out (?:my|our)|feedback on (?:my|our)|shameless plug|introducing (?:my|our)|(?:my|our) (?:new )?(?:app|tool|saas|startup|product|side project))\b/i;

const NOISE = /\b(looking for (?:work|a job|freelance|contract|remote)|seeking work|who is hiring|willing to relocate|resume:|portfolio:)\b/i;

function phrasesFor(keyword) {
  return [`looking for ${keyword}`, `is there a ${keyword}`, `alternative to ${keyword}`, `recommend ${keyword}`, keyword];
}

function strip(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
  }[c]));
}

function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'news.ycombinator.com') {
    if (url.pathname !== '/item') return null;
    const id = url.searchParams.get('id');
    if (!/^\d+$/.test(id || '')) return null;
    return 'https://news.ycombinator.com/item?id=' + id;
  }
  if (host === 'www.reddit.com' || host === 'old.reddit.com' || host === 'reddit.com') {
    const match = url.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,10})(?:\/([A-Za-z0-9_]+)?)?\/?$/);
    if (!match) return null;
    return 'https://www.reddit.com/r/' + match[1] + '/comments/' + match[2] + '/' + (match[3] ? match[3] + '/' : '');
  }
  return null;
}

function isFresh(when, now, days) {
  const time = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(time)) return false;
  return time >= now - days * 86400000;
}

function fingerprint(text) {
  return 'fp:' + String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 180);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sentenceAt(text, index, length) {
  let start = 0;
  for (let i = index; i >= 0; i--) {
    if ('.!?\n'.includes(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index + length; i < text.length; i++) {
    if ('.!?\n'.includes(text[i])) {
      end = i;
      break;
    }
  }
  return text.slice(start, end);
}

function qualify(text, keyword) {
  const clean = strip(text);
  const kw = String(keyword || '').trim();
  if (!clean || !kw) return null;
  if (SELF_PROMO.test(clean) || NOISE.test(clean)) return null;
  const direct = new RegExp(
    '\\b(' +
      "(?:i(?:'m| am) |we(?:'re| are) )?looking for (?:a |an |some )?(?:good |simple |cheap |new )?" +
      '|can (?:anyone|someone) recommend (?:a |an |me )?' +
      '|alternatives? to (?:a |an )?' +
      '|is there (?:a |an )?(?:good )?(?:alternative to (?:a |an )?)?' +
    ')' + escapeRegExp(kw) + '\\b',
    'i'
  );
  const match = clean.match(direct) || clean.match(INTENT);
  if (!match) return null;
  const sentence = sentenceAt(clean, match.index, match[0].length);
  const words = kw.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  const needles = words.length ? words : [kw.toLowerCase()];
  if (!needles.every((word) => sentence.toLowerCase().includes(word))) return null;
  const near = clean.slice(Math.max(0, match.index - 40), match.index + match[0].length + 80).toLowerCase();
  if (!needles.every((word) => near.includes(word))) return null;
  const snippet = clean.slice(Math.max(0, match.index - 80), match.index + 160);
  const phrase = match[0];
  return {
    selfPromo: false,
    match: phrase,
    snippet,
    reason: 'Buyer-intent language "' + phrase + '" appears next to "' + kw + '". This is a signal that someone may be asking for it, not a guaranteed buyer.'
  };
}

function man(posts) {
  const list = posts || [];
  const pay = list.filter((post) => /(?:\bpay\b|\bpaid\b|\bprice\b|\$|\bbudget\b|\bsubscription\b)/i.test(post.snippet || '')).length;
  const need = Math.min(10, list.length);
  const money = Math.min(10, pay * 2);
  let verdict = 'No buyer-intent posts in this window';
  if (need >= 5 && money >= 2) {
    verdict = 'Repeated buyer-intent language, including some mention of paying. These are not guaranteed buyers.';
  } else if (need >= 2) {
    verdict = 'A few buyer-intent posts. These are not guaranteed buyers.';
  } else if (need === 1) {
    verdict = 'One buyer-intent post. This is not a guaranteed buyer.';
  }
  return { need, money, verdict };
}

function resolveOptions(daysOrOpts, fetchImpl) {
  if (typeof daysOrOpts === 'number') {
    return { days: daysOrOpts, fetch: fetchImpl || globalThis.fetch, includeReddit: false, now: Date.now() };
  }
  const opts = daysOrOpts || {};
  return {
    days: opts.days == null ? DEFAULT_DAYS : opts.days,
    fetch: opts.fetch || fetchImpl || globalThis.fetch,
    includeReddit: Boolean(opts.includeReddit),
    now: opts.now == null ? Date.now() : opts.now
  };
}

async function getJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    const message = e && e.message ? e.message : 'request failed';
    if (e && (e.name === 'TypeError' || /failed to fetch|cors/i.test(message))) {
      return { ok: false, error: 'request blocked before a response (CORS or network). Public search.json often refuses browser reads.' };
    }
    return { ok: false, error: 'request failed: ' + message };
  }
  if (!response || !response.ok) {
    const status = response && response.status;
    if (status === 429) return { ok: false, error: 'rate limited (HTTP 429)' };
    return { ok: false, error: 'HTTP ' + (status || 'error') };
  }
  try {
    return { ok: true, json: await response.json() };
  } catch (e) {
    return { ok: false, error: 'invalid JSON' };
  }
}

function takePost(seen, post) {
  if (!post || !post.url) return null;
  const fp = fingerprint(post.snippet);
  const idKey = post.source + ':' + post.id;
  if (seen.has(post.url) || seen.has(fp) || (post.id && seen.has(idKey))) return null;
  seen.add(post.url);
  seen.add(fp);
  if (post.id) seen.add(idKey);
  return post;
}

function postFromHn(hit, keyword, query, now, days) {
  if (!hit || !/^\d+$/.test(String(hit.objectID || ''))) return null;
  if (!isFresh(hit.created_at, now, days)) return null;
  const text = strip(hit.comment_text || ((hit.title || '') + ' ' + (hit.story_text || '')));
  const found = qualify(text, keyword);
  if (!found) return null;
  const url = safeUrl('https://news.ycombinator.com/item?id=' + hit.objectID);
  if (!url) return null;
  return {
    id: String(hit.objectID),
    source: 'hackernews',
    author: String(hit.author || 'unknown').slice(0, 80),
    date: String(hit.created_at).slice(0, 10),
    url,
    snippet: found.snippet,
    reason: found.reason,
    query
  };
}

function postFromReddit(data, keyword, query, now, days) {
  if (!data || data.stickied) return null;
  const createdMs = Number(data.created_utc) * 1000;
  if (!isFresh(createdMs, now, days)) return null;
  const text = strip([data.title, data.link_title, data.selftext, data.body].filter(Boolean).join(' '));
  const found = qualify(text, keyword);
  if (!found) return null;
  let permalink = data.permalink || '';
  if (permalink.startsWith('/')) permalink = 'https://www.reddit.com' + permalink;
  const url = safeUrl(permalink);
  if (!url) return null;
  return {
    id: String(data.id || ''),
    source: 'reddit',
    author: String(data.author || 'unknown').slice(0, 80),
    date: new Date(createdMs).toISOString().slice(0, 10),
    url,
    snippet: found.snippet,
    reason: found.reason,
    query
  };
}

async function searchHackerNews(keyword, days, fetchImpl, now) {
  const since = Math.floor(now / 1000) - days * 86400;
  const queries = [keyword + ' looking for', keyword + ' recommend', keyword + ' alternative', keyword + ' pay for', keyword + ' is there'];
  const jobs = [];
  for (const query of queries) {
    for (const tag of ['comment', 'story']) jobs.push({ query, tag });
  }
  const settled = await Promise.all(jobs.map(async (job) => {
    const url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(job.query) +
      '&tags=' + job.tag +
      '&numericFilters=' + encodeURIComponent('created_at_i>' + since) +
      '&hitsPerPage=100';
    return { job, got: await getJson(fetchImpl, url) };
  }));
  const ok = settled.filter((item) => item.got.ok);
  if (!ok.length) {
    return { status: 'unavailable', error: (settled[0] && settled[0].got.error) || 'request failed', posts: [] };
  }
  const seen = new Set();
  const posts = [];
  for (const item of ok) {
    const hits = item.got.json && Array.isArray(item.got.json.hits) ? item.got.json.hits : [];
    for (const hit of hits) {
      const post = takePost(seen, postFromHn(hit, keyword, item.job.query, now, days));
      if (post) posts.push(post);
    }
  }
  return { status: 'ok', count: posts.length, posts };
}

async function searchReddit(keyword, days, fetchImpl, now) {
  const query = keyword + ' (looking OR recommend OR alternative OR pay)';
  const url = 'https://www.reddit.com/search.json?q=' + encodeURIComponent(query) + '&sort=new&t=year&limit=25&raw_json=1';
  const got = await getJson(fetchImpl, url);
  if (!got.ok) return { status: 'unavailable', error: got.error, posts: [] };
  const children = got.json && got.json.data && Array.isArray(got.json.data.children) ? got.json.data.children : [];
  const seen = new Set();
  const posts = [];
  for (const child of children) {
    const post = takePost(seen, postFromReddit(child && child.data, keyword, query, now, days));
    if (post) posts.push(post);
  }
  return { status: 'ok', count: posts.length, posts };
}

async function hunt(keyword, daysOrOpts, fetchImpl) {
  const opts = resolveOptions(daysOrOpts, fetchImpl);
  const kw = String(keyword || '').trim();
  const phrases = kw ? phrasesFor(kw) : [];
  if (!kw) {
    return {
      keyword: '',
      count: 0,
      posts: [],
      phrases: [],
      links: [],
      sources: {
        hn: { status: 'unavailable', error: 'missing keyword' },
        reddit: { status: 'skipped' }
      }
    };
  }
  const hn = await searchHackerNews(kw, opts.days, opts.fetch, opts.now);
  const reddit = opts.includeReddit
    ? await searchReddit(kw, opts.days, opts.fetch, opts.now)
    : { status: 'skipped', posts: [] };
  const seen = new Set();
  const posts = [];
  for (const post of hn.posts.concat(reddit.posts || [])) {
    const kept = takePost(seen, post);
    if (kept) posts.push(kept);
  }
  posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const trimmed = posts.slice(0, MAX_POSTS);
  return {
    keyword: kw,
    count: trimmed.length,
    posts: trimmed,
    phrases,
    links: phrases.map((phrase) => ({
      phrase,
      reddit: 'https://www.reddit.com/search/?q=' + encodeURIComponent('"' + phrase + '"') + '&sort=new',
      x: 'https://x.com/search?q=' + encodeURIComponent('"' + phrase + '" -is:retweet') + '&f=live'
    })),
    sources: {
      hn: { status: hn.status, count: hn.status === 'ok' ? hn.posts.length : undefined, error: hn.error },
      reddit: {
        status: reddit.status,
        count: reddit.status === 'ok' ? (reddit.posts || []).length : undefined,
        error: reddit.error
      }
    }
  };
}

function sourceLine(name, source) {
  if (!source) return '';
  if (source.status === 'skipped') return 'Reddit search off';
  if (source.status === 'unavailable') {
    const detail = source.error ? ' (' + source.error + ')' : '';
    return name + ': source unavailable' + detail;
  }
  const count = source.count || 0;
  return name + ': ' + count + ' matching post' + (count === 1 ? '' : 's');
}

function externalSearchLink(phrase, kind) {
  const encoded = encodeURIComponent('"' + phrase + '"');
  if (kind === 'reddit') return 'https://www.reddit.com/search/?q=' + encoded + '&sort=new';
  return 'https://x.com/search?q=' + encodeURIComponent('"' + phrase + '" -is:retweet') + '&f=live';
}

function renderPost(post) {
  const url = safeUrl(post.url);
  const sourceName = post.source === 'reddit' ? 'Reddit' : 'Hacker News';
  const label = (post.date || '') + ' · ' + (post.author || 'unknown') + ' · ' + sourceName;
  const link = url
    ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>'
    : '<span>' + escapeHtml(label) + '</span>';
  return '<article class="p">' + link +
    '<div>' + escapeHtml(post.snippet || '') + '</div>' +
    '<p class="reason">Why this is a signal: ' + escapeHtml(post.reason || '') + '</p>' +
    '<p class="m">Matched query: ' + escapeHtml(post.query || '') + '</p>' +
    '</article>';
}

function renderResults(result) {
  const data = result || {};
  const posts = data.posts || [];
  const sources = data.sources || {};
  const hnOk = sources.hn && sources.hn.status === 'ok';
  const redditOk = sources.reddit && sources.reddit.status === 'ok';
  const searched = Boolean(hnOk || redditOk);
  let summary;
  if (!searched && !posts.length) {
    summary = 'Hacker News did not return results. This is not the same as zero matches.';
  } else if (!posts.length) {
    summary = 'No buyer-intent posts in this window. A result here would be a signal, not a guaranteed buyer.';
  } else {
    summary = posts.length + ' post' + (posts.length === 1 ? '' : 's') + ' with buyer-intent language. A match is not a guaranteed buyer.';
  }
  const phraseItems = (data.phrases || []).map((phrase) => {
    const safePhrase = escapeHtml(phrase);
    const reddit = escapeHtml(externalSearchLink(phrase, 'reddit'));
    const x = escapeHtml(externalSearchLink(phrase, 'x'));
    return '<li>"' + safePhrase + '" · <a href="' + reddit + '" target="_blank" rel="noopener noreferrer">Open Reddit search</a> · <a href="' + x + '" target="_blank" rel="noopener noreferrer">Open X search</a></li>';
  }).join('');
  const verdict = searched ? '<p>' + escapeHtml(man(posts).verdict) + '</p>' : '';
  return '<section>' +
    '<h2>' + escapeHtml(summary) + '</h2>' +
    '<p class="m">' + escapeHtml(sourceLine('Hacker News', sources.hn)) + '</p>' +
    '<p class="m">' + escapeHtml(sourceLine('Reddit', sources.reddit)) + '</p>' +
    verdict +
    '<h3>Search phrases used</h3>' +
    '<ul>' + phraseItems + '</ul>' +
    posts.map(renderPost).join('') +
    '</section>';
}

function validHistoryEntry(entry) {
  return Boolean(entry && typeof entry.keyword === 'string' && entry.keyword.trim() && Array.isArray(entry.phrases));
}

function loadHistory(storage) {
  if (!storage || typeof storage.getItem !== 'function') return [];
  let raw;
  try {
    raw = storage.getItem(HISTORY_KEY);
  } catch (e) {
    return [];
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(validHistoryEntry).slice(0, MAX_HISTORY);
}

function rememberSearch(storage, keyword, phraseList, now) {
  const typed = String(keyword || '').trim().slice(0, 80);
  if (!typed || !storage || typeof storage.setItem !== 'function') return loadHistory(storage);
  const phrases = (phraseList || []).map((phrase) => String(phrase).trim().slice(0, 160)).filter(Boolean);
  const prev = loadHistory(storage);
  const existing = prev.find((entry) => entry.keyword.toLowerCase() === typed.toLowerCase());
  const entry = {
    keyword: existing ? existing.keyword : typed,
    at: new Date(now == null ? Date.now() : now).toISOString(),
    phrases
  };
  const next = [entry].concat(prev.filter((item) => item.keyword.toLowerCase() !== typed.toLowerCase())).slice(0, MAX_HISTORY);
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch (e) {
    return prev;
  }
  return next;
}

function renderHistory(entries) {
  const list = entries || [];
  if (!list.length) return '';
  return '<section class="history"><h2>Saved search phrases</h2><p class="m">Kept in this browser only. These are the phrases searched, not a list of buyers.</p><ul>' +
    list.map((entry) => {
      const keyword = escapeHtml(entry.keyword);
      const when = escapeHtml(String(entry.at || '').slice(0, 10));
      const phrases = (entry.phrases || []).map((phrase) => escapeHtml(phrase)).join(', ');
      return '<li><button type="button" data-phrase="' + keyword + '">' + keyword + '</button> <span class="m">' + when + '</span><div class="m">' + phrases + '</div></li>';
    }).join('') +
    '</ul></section>';
}

if (typeof module !== 'undefined') {
  module.exports = {
    hunt,
    man,
    qualify,
    escapeHtml,
    safeUrl,
    loadHistory,
    rememberSearch,
    renderResults,
    renderHistory,
    INTENT
  };
}
