import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,stat,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {publicURL,rankResults,reportMarkdown} from '../scripts/results.mjs';
import {selectBrowser,runSearch} from '../scripts/search.mjs';
import {Bridge,loopbackURL} from '../scripts/bridge.mjs';

test('canonical URLs hide content signatures while retaining distinct functional ids',()=>{
 assert.equal(publicURL('https://www.youtube.com/watch?v=one&p=2&utm_source=x&token=private#x'),'https://www.youtube.com/watch?v=one&p=2');
 assert.equal(publicURL('https://www.xiaohongshu.com/search_result/0123456789abcdef01234567?xsec_token=private'),publicURL('https://www.xiaohongshu.com/explore/0123456789abcdef01234567'));
 for(const v of ['file:///etc/passwd','https://user:pass@example.com/x','http://127.0.0.1:17777/','http://192.168.2.3/x'])assert.equal(publicURL(v),null);
 assert.notEqual(publicURL('https://youtube.com/watch?v=one'),publicURL('https://youtube.com/watch?v=two'));
});
test('dedup retains a read source and its multiple discovery queries',()=>{
 const a={id:'a',url:'https://example.com/a',title:'动画',snippet:'',platform:'web',query:'a',position:1,readStatus:'not_read'};
 const rows=rankResults([a,{...a,id:'b',query:'b',readStatus:'read',contentFile:'sources/b.json'}],['动画']);assert.equal(rows.length,1);assert.equal(rows[0].contentFile,'sources/b.json');assert.deepEqual(rows[0].discoveredBy,['a','b']);
});
test('specific tool names outrank broad AI beginner terms and Latin tokens respect word boundaries',()=>{
 const rows=rankResults([
  {url:'https://example.com/illustrator',title:'AI 入门 Adobe Illustrator 教程',snippet:'设计基础',query:'AI Manim 入门',position:0},
  {url:'https://example.com/manim',title:'Manim + Cursor 数学动画',snippet:'AI辅助写代码',query:'AI Manim 入门',position:1},
 ],['AI Manim 入门']);assert.equal(rows[0].url,'https://example.com/manim');
 const exact=rankResults([{url:'https://example.com/chain',title:'chain tutorial',snippet:'',query:'AI',position:0},{url:'https://example.com/ai',title:'AI coding',snippet:'',query:'AI',position:1}],['AI']);assert.equal(exact[0].url,'https://example.com/ai');
});
test('an explicit offline or ambiguous browser cannot silently select another account',()=>{
 const p={id:'x',hosts:['example.com'],kind:'social'},b=[{browserId:'a',displayName:'Chrome',tabs:[]},{browserId:'b',displayName:'Chrome',tabs:[]}];
 assert.throws(()=>selectBrowser(p,b,{x:'missing'}),/configured_browser/);assert.throws(()=>selectBrowser(p,b,{x:'Chrome'}),/configured_browser/);assert.equal(selectBrowser(p,b,{x:'b'}).browser.browserId,'b');
});
test('Bridge credentials are limited to the loopback transport and parsed CDP values',async()=>{
 assert.throws(()=>loopbackURL('https://example.com'),/bridge_must_be_local/);assert.throws(()=>loopbackURL('http://private@127.0.0.1:17777'),/bridge_must_be_local/);
 let request;const bridge=new Bridge({token:'private-test-token',fetchImpl:async(url,options)=>{request={url,options};return new Response(JSON.stringify({ok:true,result:{result:{type:'object',value:{ok:1}}}}))}});
 assert.deepEqual(await bridge.evaluate('browser',1,'({ok:1})'),{ok:1});assert.equal(request.options.headers.Authorization,'Bearer private-test-token');assert.equal(new URL(request.url).hostname,'127.0.0.1');
 await assert.rejects(bridge.command('browser','activate_tab',{}),/action_not_readonly_search/);
});
class FakeBridge {
 constructor({login=false,unknown=false}={}){this.login=login;this.unknown=unknown;this.next=100;this.tabs=new Map([['one',new Map([[1,{id:1,url:'https://user.example/original'}]])],['two',new Map([[2,{id:2,url:'https://user.example/other'}]])]]);this.sessions=new Map();this.calls=[];}
 async browsers(){return [{browserId:'one',displayName:'chrome',online:true},{browserId:'two',displayName:'edge',online:true}]}
 async command(b,a,args){this.calls.push({b,a,args});if(a==='list_tabs')return [...this.tabs.get(b).values()];if(a==='scroll')return {};if(a==='navigate'){
  let id=args.newTab?++this.next:this.sessions.get(b+args.session);if(!id)id=++this.next;this.sessions.set(b+args.session,id);const group=[...(this.sessions.get(args.session)||[])];group.push([b,id]);this.sessions.set(args.session,group);this.tabs.get(b).set(id,{id,url:args.url});
  if(this.unknown)throw Object.assign(Error('unknown'),{code:'navigation_timeout'});return {tabId:id,groupId:999};
 }if(a==='close_session'){for(const [browser,id] of this.sessions.get(args.session)||[])this.tabs.get(browser).delete(id);return {closed:1}}if(a==='close_tab'){this.tabs.get(b).delete(args.tabId);return {}}throw Error('Unexpected action '+a)}
 async evaluate(b,id){await new Promise(r=>setTimeout(r,4));const url=this.tabs.get(b).get(id).url;const u=new URL(url),search=u.hostname.includes('search.bilibili')||u.hostname==='so.csdn.net'||u.hostname.endsWith('google.com');
  if(search){const google=u.hostname.endsWith('google.com');const final=google?url.replace('www.google.com','www.google.com.hk'):url;return {url:final,title:'query results',readyState:'complete',state:{loginRequired:this.login&&b==='two'},items:[{title:'Gemini 动画教程',url:b==='one'?'https://www.bilibili.com/video/BV1234?xsec_token=private-content-signature':'https://blog.csdn.net/author/article/details/1234',snippet:'写代码生成动画',contentType:'article'}]}}
  return {url,title:'真实正文',readyState:'complete',text:'This is source evidence, including the exact author discussion of a useful code animation workflow. '.repeat(3),state:{}};
 }
}
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'easybr-search-'));t.after(()=>rm(root,{recursive:true,force:true}));return path.join(root,'run')}
test('parallel browser search keeps unique evidence, read statuses, and user-owned tabs',async t=>{
 const bridge=new FakeBridge(),output=await fixture(t);const {report}=await runSearch({queries:['Gemini 动画','代码动画'],platforms:['bilibili','csdn'],browserMap:{bilibili:'one',csdn:'two'},read:2,output},{bridge});
 assert.equal(report.searches.length,4);assert.equal(report.results.length,2);assert.equal(report.results.filter(x=>x.readStatus==='read').length,2);assert.equal(new Set(report.searches.map(x=>x.evidenceFile)).size,4);
 for(const s of report.searches)assert.ok((await readFile(path.join(output,s.evidenceFile),'utf8')).includes(s.query));
 assert.equal((await stat(path.join(output,'private-run.json'))).mode&0o777,0o600);
 const publicText=await readFile(path.join(output,'results.json'),'utf8');assert.ok(!publicText.includes('private-content-signature'));assert.ok(!publicText.includes('browserId'));
 assert.deepEqual([...bridge.tabs.get('one').keys()],[1]);assert.deepEqual([...bridge.tabs.get('two').keys()],[2]);assert.equal(report.cleanup.verified,true);
});
test('a blocked platform stays blocked while another platform returns usable results',async t=>{
 const bridge=new FakeBridge({login:true});const {report}=await runSearch({queries:['动画'],platforms:['bilibili','csdn'],browserMap:{bilibili:'one',csdn:'two'},read:0,output:await fixture(t)},{bridge});
 assert.equal(report.searches.find(x=>x.platform==='csdn').status,'login_required');assert.equal(report.results.length,1);assert.equal(report.results[0].platform,'bilibili');
});
test('Google regional redirects are still the requested search, not a false failure',async t=>{
 const bridge=new FakeBridge();const {report}=await runSearch({queries:['动画'],platforms:['google'],browserMap:{google:'one'},read:0,output:await fixture(t)},{bridge});assert.equal(report.searches[0].status,'ok');assert.equal(report.results.length,1);
});
test('opaque engine result redirects are read in a fresh task tab and retained as actual source URLs',async t=>{
 const bridge=new FakeBridge();
 bridge.evaluate=async(b,id)=>{
  const url=bridge.tabs.get(b).get(id).url;
  if(url.includes('/search?'))return {url,title:'results',readyState:'complete',state:{},items:[{title:'HTML animation lesson',url:'https://www.google.com.hk/goto?url=FAKE_OPAQUE',snippet:'HTML animation'}]};
  return {url:'https://www.youtube.com/watch?v=example',title:'HTML animation lesson',readyState:'complete',state:{},contentType:'video',text:'This page is a video title and description, not a transcript or video playback. '.repeat(3)};
 };
 const {report}=await runSearch({queries:['HTML animation'],platforms:['google'],browserMap:{google:'one'},read:1,output:await fixture(t)},{bridge});
 const navigations=bridge.calls.filter(x=>x.a==='navigate');assert.equal(navigations.length,2);assert.equal(navigations[1].args.newTab,true);
 assert.equal(report.results[0].url,'https://www.youtube.com/watch?v=example');assert.equal(report.results[0].contentType,'video');assert.match(report.results[0].readCoverage,/未播放或转录/);assert.deepEqual(report.scope.platforms,['google']);
 assert.deepEqual([...bridge.tabs.get('one').keys()],[1]);
});
test('a resolved source URL remains useful even when its article body cannot be read',async t=>{
 const bridge=new FakeBridge();bridge.evaluate=async(b,id)=>{
  const url=bridge.tabs.get(b).get(id).url;
  return url.includes('/search?')?{url,title:'results',readyState:'complete',state:{},items:[{title:'A useful video tutorial',url:'https://www.google.com.hk/goto?url=FAKE_OPAQUE'}]}:{url:'https://www.youtube.com/watch?v=example',title:'A useful video tutorial',readyState:'complete',text:'',contentType:'video',state:{empty:true}};
 };
 const {report}=await runSearch({queries:['video tutorial'],platforms:['google'],browserMap:{google:'one'},read:1,output:await fixture(t)},{bridge});
 assert.equal(report.results[0].url,'https://www.youtube.com/watch?v=example');assert.equal(report.results[0].readStatus,'content_unavailable');assert.equal(report.results[0].contentType,'video');assert.equal(report.cleanup.verified,true);
});
test('an uncertain navigation still closes only its own session and reports uncertainty',async t=>{
 const bridge=new FakeBridge({unknown:true});const {report}=await runSearch({queries:['动画'],platforms:['bilibili'],browserMap:{bilibili:'one'},read:0,output:await fixture(t)},{bridge});assert.ok(bridge.calls.some(x=>x.a==='close_session'));assert.equal(report.cleanup.verified,false);assert.deepEqual([...bridge.tabs.get('one').keys()],[1]);
});
