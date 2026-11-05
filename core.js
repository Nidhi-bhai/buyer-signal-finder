// Buyer Signal Finder core: real buyer-intent posts from Hacker News (Algolia API) + Reddit links
const INTENT=/\b(i'?m looking for an? (tool|app|service|way)|looking for an? (good |simple |cheap )?(tool|app|service|saas|alternative)|is there an? (tool|app|service|way)|any (good )?(tool|app|service)s? (for|that)|can (anyone|someone) recommend|i'?d (happily )?pay|would pay for|willing to pay|wish there (was|were) an?|alternatives? to|we need an? (tool|way))\b/i;
const NOISE=/(looking for (work|a job|freelance|contract|remote)|seeking work|who is hiring|willing to relocate|resume:|portfolio:)/i;
function phrases(k){return [`looking for ${k}`,`is there a ${k}`,`alternative to ${k}`,`recommend ${k}`,`${k}`];}
function strip(h){return (h||'').replace(/<[^>]+>/g,' ').replace(/&#x27;/g,"'").replace(/&#x2F;/g,'/').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/\s+/g,' ').trim();}
async function hunt(keyword,days=180,f=fetch){
  const since=Math.floor(Date.now()/1000)-days*86400,seen=new Set(),out=[];
  const qs=[];for(const q of [keyword+' looking for',keyword+' recommend',keyword+' alternative',keyword+' pay for',keyword+' is there'])for(const tag of ['comment','story'])qs.push([q,tag]);
  const rs=await Promise.all(qs.map(async([q,tag])=>{const u=`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=${tag}&numericFilters=${encodeURIComponent('created_at_i>'+since)}&hitsPerPage=100`;
      try{const r=await f(u);return r.ok?(await r.json()).hits:[]}catch(e){return []}}));
  for(const hits of rs){{
      for(const h of hits){const t=strip(h.comment_text||((h.title||'')+' '+(h.story_text||'')));
        if(seen.has(h.objectID)||!INTENT.test(t)||NOISE.test(t)||/^show hn/i.test(h.title||'')) continue;
        const kw=keyword.toLowerCase().split(/\s+/).filter(w=>w.length>2), m0=t.match(INTENT), win=t.slice(Math.max(0,m0.index-200),m0.index+250).toLowerCase();
        if(!kw.every(w=>win.includes(w))) continue; seen.add(h.objectID);
        const m=t.match(INTENT); const i=Math.max(0,m.index-80);
        out.push({id:h.objectID,author:h.author,date:h.created_at.slice(0,10),url:`https://news.ycombinator.com/item?id=${h.objectID}`,snippet:t.slice(i,i+240),points:h.points||0});}
    }
  }
  out.sort((a,b)=>b.date.localeCompare(a.date));
  const links=phrases(keyword).map(p=>({phrase:p,reddit:`https://www.reddit.com/search/?q=${encodeURIComponent('"'+p+'"')}&sort=new`,x:`https://x.com/search?q=${encodeURIComponent('"'+p+'" -is:retweet')}&f=live`}));
  return {keyword,count:out.length,posts:out,links};
}
function man(posts){ // simple MAN score from evidence
  const pay=posts.filter(p=>/(pay|paid|price|\$|budget|subscription)/i.test(p.snippet)).length;
  const need=Math.min(10,posts.length), money=Math.min(10,pay*2);
  return {need,money,verdict: need>=5&&money>=2?'Real demand':need>=2?'Weak signal':'No signal'};
}
if(typeof module!=='undefined') module.exports={hunt,man,INTENT};
