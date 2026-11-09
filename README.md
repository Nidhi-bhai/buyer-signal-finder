# Buyer Signal Finder

**Stop pitching strangers. Find people already asking.**

Free static page. Type what you sell. It searches public Hacker News posts (Algolia API, about the last 6 months) for buyer-intent language, and can optionally call public `https://www.reddit.com/search.json`.

A match is a signal that a post asks for a tool, an alternative, or says someone would pay. **It is not a guaranteed buyer.** The page states that on the result and in the reason attached to each post.

Each result shows the original post link (only `https://news.ycombinator.com/item?id=` or a Reddit comments permalink) and the phrase that qualified it. Self-promotion, job posts, duplicates, and posts older than the window are dropped. HTML from posts is escaped.

Search phrases are saved in this browser only (`localStorage`). Nothing is uploaded.

Reddit is best-effort. Checked from a browser, `search.json` is blocked before a response (CORS), and unauthenticated calls from this environment also get HTTP 403. When that happens the page says **source unavailable**. It does not pretend Reddit returned zero posts. Hacker News still runs.

The need/money line counts wording in the snippets. It does not check authority and it does not mean someone will buy.

Live: https://nidhi-bhai.github.io/buyer-signal-finder/

Test: `node test.js` (writes `test-results.json`).

Done-for-you version that also covers X: [Buyer Hunt](https://nidhi-bhai.github.io/buyer-hunt/). 30 posts from the last 14 days, a reply drafted for each, $49 via PayPal, pro-rata refund if fewer than 30 are found.
