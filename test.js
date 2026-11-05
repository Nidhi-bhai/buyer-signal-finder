const {hunt,man}=require('./core');const fs=require('fs');
(async()=>{const res=[];for(const k of ['youtube transcript','invoice','cold email','password manager']){const r=await hunt(k);const m=man(r.posts);res.push({k,count:r.count,man:m,sample:r.posts.slice(0,2).map(p=>p.url+' '+p.snippet.slice(0,90))});}
fs.writeFileSync('test-results.json',JSON.stringify({run:new Date().toISOString(),res},null,1));console.log(JSON.stringify(res,null,1));})();
