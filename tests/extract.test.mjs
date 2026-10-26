import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSearchExtractExpression as search, buildDetailExtractExpression as detail } from '../scripts/extract.mjs';

// Tiny in-memory DOM fixture for read-only extraction tests, not a production parser.
class Text {
  constructor(text) { this.nodeType = 3; this.nodeValue = text; }
  get textContent() { return this.nodeValue; }
}
class Element {
  constructor(tag, attrs = {}, children = []) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.childNodes = []; for (const c of children) this.append(c); }
  append(c) { if (typeof c === 'string') c = new Text(c); c.parentElement = this; this.childNodes.push(c); return this; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  get className() { return this.attrs.class || ''; } get id() { return this.attrs.id || ''; } get hidden() { return Object.hasOwn(this.attrs, 'hidden'); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  get innerText() { if (!this.getClientRects().length) return ''; return this.childNodes.map(c => c.nodeType === 3 ? c.textContent : c.innerText).join(' '); }
  getClientRects() { return this.hidden || this.attrs.style === 'display:none' ? [] : [{}]; }
  matches(selector) { return selector.split(',').some(s => match(this, s.trim())); }
  closest(selector) { for (let n = this; n?.nodeType === 1; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { const out = []; const walk = n => { for (const c of n.childNodes || []) if (c.nodeType === 1) { if (c.matches(selector)) out.push(c); walk(c); } }; walk(this); return out; }
}
function compound(node, selector) {
  const tag = selector.match(/^[a-zA-Z][a-zA-Z0-9-]*/)?.[0]; if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const m of selector.matchAll(/\.([a-zA-Z0-9_-]+)|#([a-zA-Z0-9_-]+)|\[([^\]=*\s]+)(\*?=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))?\]/g)) {
    if (m[1] && !node.className.split(/\s+/).includes(m[1])) return false;
    if (m[2] && node.id !== m[2]) return false;
    if (m[3]) { const val = node.getAttribute(m[3]); if (val === null) return false; const wanted = m[5] ?? m[6] ?? m[7] ?? ''; if (m[4] === '=' && val !== wanted) return false; if (m[4] === '*=' && !val.includes(wanted)) return false; }
  }
  return true;
}
function match(node, selector) {
  const tokens = selector.replaceAll('>', ' > ').trim().split(/\s+/); let i = tokens.length - 1;
  if (!compound(node, tokens[i])) return false;
  while (--i >= 0) {
    if (tokens[i] === '>') { node = node.parentElement; if (!node || !compound(node, tokens[--i])) return false; }
    else { let parent = node.parentElement; while (parent && !compound(parent, tokens[i])) parent = parent.parentElement; if (!parent) return false; node = parent; }
  }
  return true;
}
const el = (tag, attrs, ...children) => new Element(tag, attrs, children.flat());
function evaluate(expression, children, { url = 'https://www.bing.com/search?q=geo', title = '搜索', readyState = 'complete', head = [] } = {}) {
  const body = el('body', {}, children); const document = new Element('html', {}, [el('head', {}, head), body]); document.body = body; document.title = title; document.readyState = readyState;
  Object.defineProperty(document, 'cookie', { get() { throw new Error('cookie read forbidden'); } });
  const context = { document, location: { href: url }, URL, atob, Uint8Array, TextDecoder,
    getComputedStyle: n => ({ display: n.attrs.style === 'display:none' ? 'none' : 'block', visibility: 'visible' }),
    fetch: () => { throw new Error('network forbidden'); } };
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(context, key, { get() { throw new Error('storage read forbidden'); } });
  return JSON.parse(JSON.stringify(vm.runInNewContext(expression, context, { timeout: 1000 })));
}
const bingCard = (href, title = '实际文章', extra = []) => el('li', { class: 'b_algo' }, el('h2', {}, el('a', { href }, title)), ...extra);

test('Bing tracking URL is decoded as UTF-8; advertisements, navigation and nested duplicates are excluded', () => {
  const target = 'https://example.com/中文?q=GEO'; const redirect = 'https://www.bing.com/ck/a?u=a1' + Buffer.from(target).toString('base64url');
  const card = bingCard(redirect, '正文标题', [el('p', { class: 'snippet' }, '摘要')]);
  const r = evaluate(search('bing'), [el('header', {}, el('a', { href: 'https://example.com/nav' }, '导航')), card, bingCard('https://ads.example/a', '广告', []).append(el('span', {}, '')), el('li', { class: 'b_ad' }, bingCard('https://ads.example/b')), bingCard(redirect)]);
  assert.equal(r.items[0].url, new URL(target).href); assert.equal(r.items.filter(i => i.url === new URL(target).href).length, 1);
  assert.ok(!r.items.some(i => i.url.endsWith('/nav') || i.url === 'https://ads.example/b')); assert.equal(r.readyState, 'complete');
});

test('Bili real-content routes retain a full title attribute while author links are ignored', () => {
  const url = 'https://www.bilibili.com/video/BV1abcDEF123?vd_source=abc';
  const r = evaluate(search('bili'), [el('div', { class: 'bili-video-card' }, el('a', { href: 'https://space.bilibili.com/123' }, '作者主页'), el('a', { href: url, title: '完整 GEO 教程' }, el('h3', {}, 'GEO ', el('em', {}, '教程'))), el('a', { href: url }, '封面'))], { url: 'https://search.bilibili.com/all?keyword=geo' });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].title, '完整 GEO 教程'); assert.equal(r.items[0].url, url); assert.equal(r.items[0].contentType, 'video');
});

test('XHS signed href is preserved privately and nested/repeated cards do not duplicate the note', () => {
  const href = '/explore/0123456789abcdef01234567?xsec_token=private-value&xsec_source=pc_search';
  const r = evaluate(search('xhs'), [el('section', { class: 'note-item' }, el('section', { class: 'note-item' }, el('a', { href, title: '经验<em>分享</em>' }, '经验分享')), el('a', { href: '/user/profile/0123456789abcdef01234567' }, '作者')), el('section', { class: 'note-item' }, el('a', { href: href.replace('private-value', 'another-value') }, '经验分享'))], { url: 'https://www.xiaohongshu.com/search_result?keyword=geo' });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].title, '经验分享'); assert.ok(r.items[0].url.includes('xsec_token=private-value'));
});

test('visible captcha or login overlays suppress underlying results; hidden dialogs and header login do not', () => {
  for (const [text, flag] of [['请完成安全验证', 'captcha'], ['请先登录后搜索', 'loginRequired']]) {
    const r = evaluate(search('bing'), [bingCard('https://example.com/a'), el('div', { role: 'dialog' }, text)]);
    assert.equal(r.state[flag], true); assert.deepEqual(r.items, []); assert.equal(r.state.empty, false);
  }
  const r = evaluate(search('bing'), [el('header', {}, '登录'), bingCard('https://example.com/captcha-guide', '如何使用 captcha'), el('div', { role: 'dialog', style: 'display:none' }, '请先登录')]);
  assert.equal(r.items.length, 1); assert.equal(r.state.loginRequired, false); assert.equal(r.state.captcha, false);
});

test('empty results, loading and Google challenge are distinct states', () => {
  const empty = evaluate(search('bing'), [el('main', {}, '没有找到相关结果')]); assert.equal(empty.state.empty, true); assert.equal(empty.state.loading, false);
  const loading = evaluate(search('bing'), [el('main', {}, '加载中…')], { readyState: 'interactive' }); assert.equal(loading.state.loading, true); assert.equal(loading.state.empty, false);
  const captcha = evaluate(search('google'), [el('main', {}, 'Our systems have detected unusual traffic')], { url: 'https://www.google.com/sorry/index', title: 'Google' }); assert.equal(captcha.state.captcha, true); assert.deepEqual(captcha.items, []);
});

test('site index keeps the requested host boundary after a Google redirect', () => {
  const r = evaluate(search('site:example.com'), [bingCard('https://www.google.com/url?q=' + encodeURIComponent('https://docs.example.com/guide')), bingCard('https://example.com.evil.invalid/fake')], { url: 'https://www.google.com/search?q=site:example.com' });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].url, 'https://docs.example.com/guide');
});

test('GitHub author profiles and star navigation are not code/repository results', () => {
  const r = evaluate(search('github'), [el('div', { class: 'repo-list-item' }, el('a', { href: '/owner' }, 'owner'), el('a', { href: '/owner/repo', title: 'owner/repo' }, 'repo'), el('a', { href: '/owner/repo/stargazers' }, 'stars'))], { url: 'https://github.com/search?q=geo&type=repositories' });
  assert.deepEqual(r.items.map(i => i.url), ['https://github.com/owner/repo']);
});

test('detail extracts primary article text rather than page navigation and sidebars', () => {
  const body = '正文事实与实际步骤。'.repeat(20);
  const r = evaluate(detail('csdn'), [el('header', {}, '站点导航和登录'), el('main', {}, el('article', {}, el('h1', {}, '文章题目'), el('div', { id: 'content_views' }, el('p', {}, body), el('aside', {}, '侧栏推荐不可进入正文'), el('footer', {}, '页脚推荐不可进入正文')))), el('aside', {}, '侧栏')], { url: 'https://blog.csdn.net/user/article/details/1234', head: [el('link', { rel: 'canonical', href: '/user/article/details/1234' })] });
  assert.ok(r.text.includes(body)); assert.ok(!/导航|侧栏|页脚/.test(r.text)); assert.equal(r.canonicalUrl, r.url); assert.equal(r.readyState, 'complete');
});

test('unsupported detail page does not treat its body navigation as article content or invent a canonical /null', () => {
  const r = evaluate(detail('site:example.com'), [el('header', {}, '只有菜单'), el('nav', {}, '首页产品登录')], { url: 'https://example.com/page' });
  assert.equal(r.text, ''); assert.equal(r.canonicalUrl, 'https://example.com/page');
});

test('detail overlay is blocking even when there is visible background article text', () => {
  const r = evaluate(detail('zhihu'), [el('article', {}, '背景文章。'.repeat(40)), el('div', { class: 'login-container' }, '扫码登录后查看内容')], { url: 'https://www.zhihu.com/question/123' });
  assert.equal(r.state.loginRequired, true); assert.equal(r.text, '');
});

test('bounded extraction leaves DOM and private APIs alone', () => {
  const r = evaluate(search('bing', { limit: 1, maxText: 45 }), [bingCard('https://example.com/a', '文章标题', [el('div', { class: 'b_caption' }, el('p', {}, '摘要'.repeat(100)))]), bingCard('https://example.com/b')]);
  assert.equal(r.items.length, 1); assert.ok(r.items.reduce((n, i) => n + i.title.length + i.snippet.length + (i.author?.length || 0) + (i.publishedAt?.length || 0) + i.metrics.raw.length, 0) <= 45);
  const d = evaluate(detail('site:example.com', { maxText: 40 }), [el('article', {}, '正文'.repeat(100))], { url: 'https://example.com/a' }); assert.ok(d.text.length <= 40);
  for (const opts of [{ limit: -1 }, { maxText: 0 }, { limit: '10' }]) assert.throws(() => search('bing', opts), { code: 'invalid_extract_options' });
});

test('a video duration is not a publication date and missing redirect targets are rejected', () => {
  const r = evaluate(search('bilibili'), [el('div', { class: 'bili-video-card' }, el('a', { href: 'https://www.bilibili.com/video/BV123abc456', title: '教程' }, '教程'), el('span', { class: 'time' }, '03:20'))], { url: 'https://search.bilibili.com/all?keyword=geo' });
  assert.equal(r.items[0].publishedAt, null);
  const redirect = evaluate(search('google'), [bingCard('https://www.google.com/url'), bingCard('https://www.google.com/url?q=javascript:alert(1)')], { url: 'https://www.google.com/search?q=geo' });
  assert.deepEqual(redirect.items, []);
});

test('XHS live DOM shape prefers the signed title search_result route over an empty explore or cover anchor', () => {
  const id = '0123456789abcdef01234567'; const href = '/search_result/' + id + '?xsec_token=fixture-only-not-a-real-token';
  const card = el('section', { class: 'note-item' }, el('a', { href: '/explore/' + id, style: 'display:none' }), el('a', { href, class: 'cover mask' }), el('div', { class: 'footer' }, el('a', { href, class: 'title' }, el('span', {}, '真实卡片 ', el('em', {}, '标题'))), el('a', { href: '/user/profile/' + id, class: 'author' }, el('div', { class: 'name' }, '演示作者')), el('div', { class: 'name-time-wrapper' }, el('div', { class: 'time' }, '昨天'))));
  const unsignedDuplicate = el('section', { class: 'note-item' }, el('a', { href: '/explore/' + id, title: '旧无签名图锚' }, '旧无签名图锚'));
  const r = evaluate(search('xiaohongshu'), [unsignedDuplicate, card], { url: 'https://www.xiaohongshu.com/search_result?keyword=geo' });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].title, '真实卡片 标题');
  assert.equal(r.items[0].url, 'https://www.xiaohongshu.com' + href); assert.equal(r.items[0].author, '演示作者'); assert.equal(r.items[0].publishedAt, '昨天');
});

test('Google regional opaque goto and first-party content survive while root/account/search navigation is excluded', () => {
  const card = (href, title) => el('div', { class: 'MjjYud' }, el('a', { href }, el('h3', {}, title)));
  const wrapper = 'https://www.google.com.hk/goto?url=fixture-opaque-value';
  const cloud = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/video-gen-prompt-guide?hl=zh-cn';
  const developer = 'https://codelabs.developers.google.com/draw-a-website-gemini?hl=zh-cn';
  const baijiahao = 'https://baijiahao.baidu.com/s?id=123456789';
  const r = evaluate(search('google'), [card(wrapper, '不透明跳转结果'), card(cloud, 'Google Cloud 文档'), card(developer, '开发者教程'), card(baijiahao, '百家号正文'), card('https://www.google.com.hk/', '搜索首页'), card('https://www.google.com.hk/search?q=other', '更多搜索'), card('https://accounts.google.com/', 'Google 账号'), card('https://consent.google.com/m', '同意选项')], { url: 'https://www.google.com.hk/search?q=geo' });
  assert.deepEqual(r.items.map(i => i.url), [wrapper, cloud, developer, baijiahao]);
});

test('Google url unwraps only explicit HTTPS targets and preserves an opaque wrapper without fabricating a relative destination', () => {
  const card = (href, title) => el('div', { class: 'MjjYud' }, el('a', { href }, el('h3', {}, title)));
  const target = 'https://developers.google.com/search/docs?hl=zh-cn';
  const opaque = 'https://www.google.com.hk/url?url=fixture-opaque-value';
  const r = evaluate(search('google'), [card('https://www.google.com/url?q=' + encodeURIComponent(target), '明确目标'), card(opaque, '不透明目标'), card('https://www.google.com/url', '无目标'), card('https://www.google.com.hk/goto?url=javascript%3Aalert(1)', '无效协议')], { url: 'https://www.google.com.hk/search?q=geo' });
  assert.deepEqual(r.items.map(i => i.url), [target, opaque]);
  assert.ok(!r.items.some(i => i.url === 'https://www.google.com.hk/fixture-opaque-value'));
});

test('web result evidence excludes bare accessibility/footer links without blocking support content with a real heading', () => {
  const help = 'https://support.google.com/websearch/answer/181196';
  const result = 'https://support.google.com/websearch/answer/2466433';
  const r = evaluate(search('google'), [el('div', { class: 'MjjYud' }, el('a', { href: help }, '无障碍功能帮助')), el('a', { href: 'https://example.com/menu' }, '普通链接'), el('div', { class: 'MjjYud' }, el('a', { href: result }, el('h3', {}, '有标题的 Google 帮助结果')))], { url: 'https://www.google.com.hk/search?q=geo' });
  assert.deepEqual(r.items.map(i => i.url), [result]);
  const bing = evaluate(search('bing'), [el('li', { class: 'b_algo' }, el('a', { href: 'https://example.com/bing' }, '有效卡片')), el('a', { href: 'https://example.com/menu' }, '菜单')]);
  assert.deepEqual(bing.items.map(i => i.url), ['https://example.com/bing']);
  const baidu = evaluate(search('baidu'), [el('div', { class: 'result c-container' }, el('h3', {}, el('a', { href: 'https://www.baidu.com/link?url=fixture-opaque' }, '百度结果')))], { url: 'https://www.baidu.com/s?wd=geo' });
  assert.equal(baidu.items.length, 1);
});

test('cross-engine contentType follows the actual result URL, with article/post exceptions and unknown wrappers retained', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abc123_xyz', 'video'],
    ['https://www.youtube.com/shorts/abc123_xyz', 'video'],
    ['https://www.bilibili.com/video/BV123abc456', 'video'],
    ['https://www.bilibili.com/read/cv123456', 'article'],
    ['https://www.bilibili.com/opus/12345678', 'post'],
    ['https://www.douyin.com/video/12345678', 'video'],
    ['https://www.douyin.com/note/12345678', 'post'],
    ['https://www.google.com.hk/goto?url=fixture-opaque', 'article'],
    ['https://example.com/video/not-a-known-platform', 'article']
  ];
  const cards = cases.map(([href]) => el('div', { class: 'MjjYud' }, el('a', { href }, el('h3', {}, href))));
  const r = evaluate(search('google'), cards, { url: 'https://www.google.com.hk/search?q=video' });
  assert.deepEqual(r.items.map(i => [i.url, i.contentType]), cases);
});

test('engine-origin YouTube detail uses its visible description and video metadata, not a larger generic main', () => {
  const description = '视频页面实际可见的简短说明，未观看或转录视频。';
  const r = evaluate(detail('google'), [el('main', {}, el('p', {}, '其他区域文字不作为视频说明。'.repeat(20)), el('ytd-watch-metadata', {}, el('h1', {}, '实际视频标题'), el('div', { id: 'description-inline-expander' }, description)))], { url: 'https://www.youtube.com/watch?v=abc123_xyz', title: 'YouTube' });
  assert.equal(r.contentType, 'video'); assert.equal(r.text, description); assert.equal(r.title, '实际视频标题');
});

test('engine-origin Bili detail selects native description while read/opus and unknown wrappers are never mislabeled video', () => {
  const description = 'B站视频页面的实际说明。';
  const r = evaluate(detail('bing'), [el('main', {}, el('p', {}, '推荐列表不可代替说明。'.repeat(20)), el('h1', { class: 'video-title' }, '视频题目'), el('div', { class: 'video-desc-container' }, description))], { url: 'https://www.bilibili.com/video/BV123abc456' });
  assert.equal(r.contentType, 'video'); assert.equal(r.text, description); assert.equal(r.title, '视频题目');
  for (const [url, expected] of [['https://www.bilibili.com/read/cv123456', 'article'], ['https://www.bilibili.com/opus/12345678', 'post'], ['https://www.douyin.com/note/12345678', 'post'], ['https://www.google.com.hk/goto?url=fixture-opaque', 'article']]) {
    const page = evaluate(detail('youtube'), [el('article', {}, '实际页面文字。'.repeat(20))], { url });
    assert.equal(page.contentType, expected);
  }
});
