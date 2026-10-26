#!/usr/bin/env node
import {mkdir,readFile,writeFile,readdir,chmod,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Bridge} from './bridge.mjs';
import {defaultConfigPath,resolveOptions,loadConfig,initConfig,validateBrowserMap} from './config.mjs';
import {getPlatform,listPlatforms,searchURL} from './platforms.mjs';
import {buildSearchExtractExpression,buildDetailExtractExpression} from './extract.mjs';
import {normalizeItem,rankResults,diverseTop,publicURL,shortText,reportMarkdown} from './results.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fail=code=>Object.assign(new Error(code),{code});
const number=(v,low,high,name)=>{const n=Number(v);if(!Number.isInteger(n)||n<low||n>high)throw fail('invalid_'+name);return n};
const tabsOf=x=>Array.isArray(x)?x:x?.tabs||[];
const safeCode=e=>typeof e?.code==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(e.code)?e.code:'search_step_failed';
export async function inventory(bridge){
 const online=(await bridge.browsers()).filter(x=>x.online);const rows=await Promise.all(online.map(async b=>{try{return {...b,tabs:tabsOf(await bridge.command(b.browserId,'list_tabs',{}))}}catch{return {...b,tabs:[],inventoryUnavailable:true}}}));return rows;
}
function matchesHost(url,hosts){try{const h=new URL(url).hostname;return hosts.some(x=>h===x||h.endsWith('.'+x))}catch{return false}}
export function selectBrowser(platform,browsers,map={}){
 const explicit=map[platform.id]||map['*'];if(explicit){const match=browsers.filter(b=>b.browserId===explicit||b.displayName===explicit);if(match.length!==1)throw fail('configured_browser_not_unique_or_online');return {browser:match[0],source:'explicit'};}
 const choices=browsers.filter(b=>!b.inventoryUnavailable).map((b,i)=>({browser:b,source:'automatic',score:b.tabs.filter(t=>matchesHost(t.url,platform.hosts)).length*100+(/chrome/i.test(b.displayName)?10:0)-i/100})).sort((a,b)=>b.score-a.score);
 if(!choices.length)throw fail('no_online_browser');const choice=choices[0];choice.source=choice.score>=100?'existing_platform_tab':'public_search_browser';choice.warning=choices.filter(x=>x.score>=100).length>1?'multiple_platform_browsers_identity_not_verified':null;return choice;
}
function searchLocation(expected,actual){
 try{const a=new URL(actual),e=new URL(expected);const google=['google.com','google.com.hk','google.co.uk','google.de','google.co.jp'];const inGoogle=h=>google.some(x=>h===x||h.endsWith('.'+x));const sameHost=a.hostname===e.hostname||(inGoogle(a.hostname)&&inGoogle(e.hostname))||(['bing.com','baidu.com'].some(x=>(a.hostname===x||a.hostname.endsWith('.'+x))&&(e.hostname===x||e.hostname.endsWith('.'+x))));if(!sameHost||a.pathname.replace(/\/$/,'')!==e.pathname.replace(/\/$/,''))return false;for(const [k,v] of e.searchParams)if(['q','keyword','search_query','wd','text','query'].includes(k)&&a.searchParams.get(k)!==v)return false;return true}catch{return false}
}
function providerRedirect(value){try{const u=new URL(value),google=getPlatform('google').hosts.some(h=>u.hostname===h||u.hostname==='www.'+h);return ((u.hostname==='www.baidu.com'||u.hostname==='baidu.com')&&u.pathname==='/link'&&u.searchParams.has('url'))||(google&&['/url','/goto'].includes(u.pathname)&&(u.searchParams.has('url')||u.searchParams.has('q')))||((u.hostname==='www.bing.com'||u.hostname==='cn.bing.com')&&u.pathname==='/ck/a')}catch{return false}}
function detailLocation(expected,page){try{if(providerRedirect(page.url))return false;const e=new URL(publicURL(expected)),a=new URL(publicURL(page.url));if(a.hostname!==e.hostname)return providerRedirect(expected)&&!!publicURL(page.url);if(a.pathname!==e.pathname)return publicURL(page.canonicalUrl)===e.href;for(const k of ['v','p','id','mid'])if(e.searchParams.has(k)&&a.searchParams.get(k)!==e.searchParams.get(k))return false;return true}catch{return false}}
function stateOf(page){if(page?.state?.captcha)return 'challenge';if(page?.state?.loginRequired)return 'login_required';return null}
async function boundedPage(bridge,browserId,tabId,expression,{expectedURL,timeoutMs,detail=false}={}){
 const until=Date.now()+timeoutMs;let latest,frameRetries=0;
 while(Date.now()<until){
  try{latest=await bridge.evaluate(browserId,tabId,expression)}catch(e){if(e.frameChanged&&frameRetries++<2){await pause(350);continue}throw e}
  if(typeof latest==='string'){try{latest=JSON.parse(latest)}catch{throw fail('page_extraction_invalid')}}
  if(!latest||typeof latest!=='object')throw fail('page_extraction_invalid');
  const blocked=stateOf(latest);if(blocked&&latest.readyState!=='loading')return latest;
  const right=detail?detailLocation(expectedURL,latest):searchLocation(expectedURL,latest.url);
  if(right&&latest.readyState!=='loading'){
   if(detail&&String(latest.text||'').trim().length>=80)return latest;
   if(!detail&&latest.items?.length)return latest;
   if(latest.state?.empty)return latest;
  }
  await pause(450);
 }
 return {...latest,timedOut:true};
}
async function saveJSON(file,value){await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(file,0o600)}
function outputOptions(o){
 const queries=[...new Set((o.queries||[]).map(x=>String(x).trim()))];if(!queries.length||queries.length>5||queries.some(q=>!q||q.length>500))throw fail('invalid_queries');
 const ids=[...new Set(o.platforms||['baidu','google'])];if(!ids.length||ids.length>20)throw fail('invalid_platforms');const profiles=[...new Map(ids.map(id=>{const p=getPlatform(id);return [p.id,p]})).values()];validateBrowserMap(o.browserMap||{});
 return {...o,queries,profiles,limit:number(o.limit??5,1,20,'limit'),read:number(o.read??3,0,10,'read'),timeoutMs:number(o.timeoutMs??18000,2000,60000,'timeout'),concurrency:number(o.concurrency??3,1,4,'concurrency')};
}
export async function runSearch(input,{bridge,onProgress=()=>{}}={}){
 const o=outputOptions(input);bridge=bridge||await Bridge.connect();
 const output=path.resolve(o.output||path.join(process.cwd(),'.local','easybr-search',new Date().toISOString().replace(/[:.]/g,'-')));
 await mkdir(output,{recursive:true,mode:0o700});if((await readdir(output)).length)throw fail('output_directory_not_empty');await chmod(output,0o700);await mkdir(path.join(output,'sources'),{mode:0o700});
 const browsers=await inventory(bridge);if(!browsers.length)throw fail('no_online_browser');
 const codeFiles=['search.mjs','bridge.mjs','results.mjs','platforms.mjs','extract.mjs','config.mjs'];const hashes=await Promise.all(codeFiles.map(async f=>[f,createHash('sha256').update(await readFile(new URL(f,import.meta.url))).digest('hex')]));const id=randomUUID().slice(0,8),contexts=new Map(),privateRun={schemaVersion:1,runId:id,codeFingerprint:Object.fromEntries(hashes),startedAt:new Date().toISOString(),routes:[],navigation:[],cleanup:[]};
 const searches=[],items=[],navigationURLs=new Map();
 let journalQueue=Promise.resolve();const journal=()=>{const snapshot=structuredClone(privateRun);journalQueue=journalQueue.then(async()=>{const temp=path.join(output,'private-run.json.tmp');await saveJSON(temp,snapshot);await rename(temp,path.join(output,'private-run.json'))});return journalQueue};
 const routeTasks=o.profiles.map(profile=>{const selected=selectBrowser(profile,browsers,o.browserMap);privateRun.routes.push({platform:profile.id,browserId:selected.browser.browserId,browserName:selected.browser.displayName,selectionSource:selected.source,warning:selected.warning||null});return {profile,browser:selected.browser}});
 for(const {browser} of routeTasks)if(!contexts.has(browser.browserId))contexts.set(browser.browserId,{browser,session:'easybr-search-'+id+'-'+contexts.size,tabId:null,owned:new Set(),groupId:null,started:false,unknownNavigation:false});
 async function navigate(ctx,url,flags={}){
  if(!publicURL(url))throw fail('unsafe_navigation_url');
  ctx.started=true;ctx.unknownNavigation=true;await journal();const d=await bridge.command(ctx.browser.browserId,'navigate',{url,session:ctx.session,groupTitle:'easybrSearch 搜索',...((flags.newTab||!ctx.tabId)?{newTab:true}:{})},20000);
  const tabId=d.tabId||d.tab?.id;if(!Number.isSafeInteger(tabId))throw fail('navigation_tab_missing');ctx.unknownNavigation=false;ctx.tabId=tabId;ctx.owned.add(tabId);ctx.groupId=d.groupId??ctx.groupId;privateRun.navigation.push({browserId:ctx.browser.browserId,session:ctx.session,tabId,url});await journal();return tabId;
 }
 async function searchTask({profile,browser},query){
  const ctx=contexts.get(browser.browserId),started=Date.now(),method=profile.id.startsWith('site:')?'web_index':profile.kind==='web'?'web':'native';onProgress({stage:'search',platform:profile.id,query});
  const entry={platform:profile.id,query,method,status:'unavailable',count:0,elapsedMs:0,evidenceFile:'sources/search-'+randomUUID().slice(0,12)+'.json'};
  try{
   const url=searchURL(profile.id,query),tab=await navigate(ctx,url),expression=buildSearchExtractExpression(profile.id,{limit:o.limit,maxText:12000});let page=await boundedPage(bridge,browser.browserId,tab,expression,{expectedURL:url,timeoutMs:o.timeoutMs});
   if(page.items?.length&&page.items.length<o.limit&&!stateOf(page)){
    await bridge.command(browser.browserId,'scroll',{tabId:tab,y:650});await pause(450);const more=await bridge.evaluate(browser.browserId,tab,expression);if(more&&Array.isArray(more.items)&&more.items.length>=page.items.length)page=more;
   }
   const blocked=stateOf(page);if(blocked)entry.status=blocked;
   else if(!searchLocation(url,page.url))entry.status='unexpected_page';
   else if(page.items?.length){
    for(const [position,raw] of page.items.slice(0,o.limit).entries()){
     const item=normalizeItem(raw,{platform:profile.id,query,method,position});if(!item)continue;
     const hostAllowed=profile.kind==='web'||profile.id.startsWith('site:')||matchesHost(raw.url,profile.hosts);if(!hostAllowed)continue;
     items.push(item);navigationURLs.set(item.id,{url:raw.url,ctx,profile});entry.count++;
    }
    entry.status=entry.count?'ok':'no_content_links';
   }else entry.status=page.state?.empty?'empty':page.timedOut?'result_load_timeout':'no_content_links';
   entry.pageTitle=shortText(page.title,180);
   await saveJSON(path.join(output,entry.evidenceFile),{platform:entry.platform,query,method,status:entry.status,url:publicURL(page.url),observedAt:new Date().toISOString(),diagnostics:page.diagnostics||{},items:items.filter(x=>x.platform===profile.id&&x.query===query)});
  }catch(e){entry.errorCode=safeCode(e);entry.status='unavailable'}
  entry.elapsedMs=Date.now()-started;searches.push(entry);await journal();onProgress({...entry,stage:'searched'});
 }
 let ranked=[];let cleanup={remaining:[],verified:true};
 try{
  await journal();for(const ctx of contexts.values()){try{const c=await bridge.command(ctx.browser.browserId,'capabilities',{});privateRun.routes.filter(r=>r.browserId===ctx.browser.browserId).forEach(r=>{r.backgroundExecution=c.features?.backgroundExecution??null})}catch{privateRun.routes.filter(r=>r.browserId===ctx.browser.browserId).forEach(r=>{r.backgroundExecution=null})}}await journal();const groups=[...contexts.values()].map(ctx=>routeTasks.filter(x=>x.browser.browserId===ctx.browser.browserId));let next=0;
  async function worker(){while(next<groups.length){const group=groups[next++];for(const task of group)for(const q of o.queries)await searchTask(task,q)}}
  await Promise.all(Array.from({length:Math.min(o.concurrency,groups.length)},worker));ranked=rankResults(items,o.queries);
  for(const item of diverseTop(ranked,o.read)){
   const nav=navigationURLs.get(item.id);if(!nav)continue;onProgress({stage:'read',platform:item.platform,title:item.title});
   try{
    const tab=await navigate(nav.ctx,nav.url,{newTab:providerRedirect(nav.url)});const page=await boundedPage(bridge,nav.ctx.browser.browserId,tab,buildDetailExtractExpression(nav.profile.id,{maxText:16000}),{expectedURL:nav.url,timeoutMs:o.timeoutMs,detail:true});const state=stateOf(page);
    if(state){item.readStatus=state;continue}if(providerRedirect(nav.url)&&publicURL(page.url)&&!providerRedirect(page.url)&&detailLocation(nav.url,page)){item.resolvedFrom=publicURL(nav.url);item.url=publicURL(page.url);item.contentType=page.contentType||item.contentType;}if(page.timedOut||!page.text||page.text.trim().length<80){item.readStatus='content_unavailable';continue}
    // A redirect must remain on this source platform, or the exact same web-result host.
    if(!publicURL(page.url)||(!providerRedirect(nav.url)&&!matchesHost(page.url,[new URL(nav.url).hostname,...(nav.profile.kind==='web'?[]:nav.profile.hosts)]))){item.readStatus='unexpected_page';continue}
    if(providerRedirect(nav.url)){item.resolvedFrom=publicURL(nav.url);item.url=publicURL(page.url);}item.contentType=page.contentType||item.contentType;item.readTitle=shortText(page.title,300);item.author=item.author||shortText(page.author,100)||null;item.publishedAt=item.publishedAt||shortText(page.publishedAt,100)||null;item.readStatus='read';item.readCoverage=item.contentType==='video'?'视频页面标题与描述；未播放或转录':'已呈现页面正文';item.contentFile='sources/'+item.id+'.json';
    await saveJSON(path.join(output,item.contentFile),{id:item.id,url:item.url,title:shortText(page.title,300),text:String(page.text).slice(0,16000),textSha256:createHash('sha256').update(String(page.text).slice(0,16000)).digest('hex'),truncated:String(page.text).length>=16000,extractionMethod:'dom',readCoverage:item.readCoverage,observedAt:new Date().toISOString(),untrustedSource:true});
   }catch(e){item.readStatus='read_failed';item.readError=safeCode(e)}
  }
 }finally{
  for(const ctx of contexts.values()){
   if(!ctx.started)continue;let closed=false;if(ctx.unknownNavigation){cleanup.verified=false;cleanup.remaining.push({browserIndex:[...contexts.keys()].indexOf(ctx.browser.browserId),status:'navigation_outcome_unverified'})}
   try{await bridge.command(ctx.browser.browserId,'close_session',{session:ctx.session});closed=true}catch{}
   try{
    let tabs=tabsOf(await bridge.command(ctx.browser.browserId,'list_tabs',{}));let remaining=tabs.filter(t=>ctx.owned.has(t.id??t.tabId));
    for(const t of remaining){try{await bridge.command(ctx.browser.browserId,'close_tab',{tabId:t.id??t.tabId})}catch{}}
    tabs=tabsOf(await bridge.command(ctx.browser.browserId,'list_tabs',{}));remaining=tabs.filter(t=>ctx.owned.has(t.id??t.tabId));if(remaining.length)cleanup.remaining.push({browserIndex:[...contexts.keys()].indexOf(ctx.browser.browserId),count:remaining.length});privateRun.cleanup.push({browserId:ctx.browser.browserId,session:ctx.session,closeAcknowledged:closed,remaining:remaining.map(t=>t.id??t.tabId)});
   }catch{cleanup.verified=false;cleanup.remaining.push({browserIndex:[...contexts.keys()].indexOf(ctx.browser.browserId),status:'unverified'});}
  }
  await journal();
 }
 ranked=rankResults(ranked,o.queries);
 const report={schemaVersion:1,scope:{platforms:o.profiles.map(p=>p.id),limit:o.limit,read:o.read},question:o.question||o.queries[0],queries:o.queries,startedAt:privateRun.startedAt,finishedAt:new Date().toISOString(),searches,results:ranked,cleanup,limitations:['页面搜索会受登录状态、网络、平台限制与排序影响。','本地相关性是关键词启发式；AI应阅读证据后再判断。','视频页面描述不等于观看或转录视频。']};
 await saveJSON(path.join(output,'results.json'),report);await writeFile(path.join(output,'results.md'),reportMarkdown(report),{mode:0o600});return {output,report};
}
export function parseCLI(input){
 const args=[...input];
 const command=args[0]&&!args[0].startsWith('--')?args.shift():'search';const options={queries:[]};if(command==='config'&&args[0]&&!args[0].startsWith('--'))options.configAction=args.shift();const names={'--question':'question','--limit':'limit','--read':'read','--timeout-ms':'timeoutMs','--concurrency':'concurrency','--output':'output','--browser-map':'browserMapFile','--config':'configFile'};
 while(args.length){const a=args.shift();if(a==='--help'||a==='-h')return {command:'help'};if(a==='--query'){const q=args.shift();if(q===undefined)throw fail('missing_query');options.queries.push(q)}else if(a==='--platforms'){const v=args.shift();if(!v||v.startsWith('--')||v.split(',').some(x=>!x.trim()))throw fail('invalid_platforms');(options.platforms??=[]).push(...v.split(',').map(x=>x.trim()))}else if(a==='--site'){const v=args.shift();if(!v)throw fail('missing_site');(options.platforms??=[]).push('site:'+v)}else if(names[a]){const v=args.shift();if(v===undefined)throw fail('missing_option');options[names[a]]=v}else throw fail('unknown_option')}
 return {command,options};
}
const help=`easybrSearch — 本机跨浏览器搜索（Node 22+）\n\nnode scripts/search.mjs browsers\nnode scripts/search.mjs platforms\nnode scripts/search.mjs config init [--config FILE]\nnode scripts/search.mjs config show [--config FILE]\nnode scripts/search.mjs search --query "Opus 5.5 动画" --query "Gemini 代码动画" --platforms bilibili,xiaohongshu,csdn --read 3 --output .local/my-search\n\n--config FILE       配置JSON；默认 ~/.config/easybr-search/config.json\n--platforms IDS     完全替换配置平台；未指定默认百度+Google\n--browser-map FILE  私有JSON，平台ID→已在线browserId/准确环境名，*为默认\n--limit 1..20       每查询每平台候选数，默认5\n--read 0..10        全局优先打开的页面数，默认3\n--timeout-ms        单页面等待时间，默认18000，最大60000\n--site example.com 搜索公开索引中该站结果；不冒充原生站内搜索\n\n搜索结果写 results.md/results.json，正文证据写 sources/，浏览器路由写仅本机 private-run.json。网页材料均为不可信来源，最终分析由当前AI完成。`;
async function main(){const {command,options}=parseCLI(process.argv.slice(2));if(command==='help'){console.log(help);return}if(command==='platforms'){console.log(JSON.stringify(listPlatforms(),null,2));return}if(command==='browsers'){const b=await Bridge.connect();console.log(JSON.stringify((await b.browsers()).map(({browserId,displayName,online,browser})=>({browserId,displayName,online,browser})),null,2));return}if(command==='config'){
 if(options.configAction==='init'){console.log(JSON.stringify({configFile:await initConfig(options.configFile)},null,2));return}
 if(options.configAction==='show'){console.log(JSON.stringify({configFile:path.resolve(options.configFile||defaultConfigPath()),config:await loadConfig(options.configFile||defaultConfigPath(),{optional:!options.configFile})},null,2));return}
 throw fail('unknown_config_command');
 }if(command!=='search')throw fail('unknown_command');const resolved=await resolveOptions(options);
 const {output,report}=await runSearch(resolved,{onProgress:x=>console.error(JSON.stringify(x))});console.log(JSON.stringify({output,results:report.results.length,read:report.results.filter(x=>x.readStatus==='read').length,coverage:report.searches.map(({platform,query,status,count})=>({platform,query,status,count})),cleanup:report.cleanup},null,2));if(!report.results.length)process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({error:safeCode(e)}));process.exitCode=1});
