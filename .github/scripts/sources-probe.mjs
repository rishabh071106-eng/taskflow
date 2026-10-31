// v28 source check from GitHub's runners: AI and open news feeds, Openverse and Commons photo search
const UA = 'BrodoitNews/1.0 (https://brodoit.com; hello@brodoit.com)';
const get = async (u, accept) => { const t0 = Date.now(); try { const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: accept || '*/*' }, signal: AbortSignal.timeout(20000), redirect: 'follow' }); const text = await r.text(); return { s: r.status, text, h: r.headers, ms: Date.now() - t0 }; } catch (e) { return { s: 0, text: '', err: e.message, ms: Date.now() - t0 }; } };
const FEEDS = {
  ai: ['https://openai.com/news/rss.xml', 'https://deepmind.google/blog/rss.xml', 'https://blog.google/technology/ai/rss/', 'https://huggingface.co/blog/feed.xml', 'https://blogs.microsoft.com/ai/feed/', 'https://blogs.nvidia.com/feed/', 'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml', 'https://techcrunch.com/category/artificial-intelligence/feed/', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'https://venturebeat.com/category/ai/feed/', 'https://arstechnica.com/ai/feed/', 'https://www.technologyreview.com/topic/artificial-intelligence/feed', 'https://www.anthropic.com/rss.xml', 'https://ai.meta.com/blog/rss/', 'https://www.artificialintelligence-news.com/feed/', 'https://indianexpress.com/section/technology/artificial-intelligence/feed/', 'https://analyticsindiamag.com/feed/'],
  open: ['https://www.nih.gov/news-releases/feed.xml', 'https://en.wikinews.org/w/index.php?title=Special:NewsFeed&feed=atom&categories=Published&count=20', 'https://www.voanews.com/api/zq$omekvi_', 'https://www.nasa.gov/feed/', 'https://science.nasa.gov/feed/', 'https://www.noaa.gov/rss.xml', 'https://www.esa.int/rssfeed/Our_Activities', 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3'],
};
for (const [k, list] of Object.entries(FEEDS)) {
  console.log('== feeds: ' + k);
  for (const u of list) {
    const r = await get(u, 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*');
    const items = (r.text.match(/<item[\s>]|<entry[\s>]/g) || []).length;
    const first = (r.text.match(/<item[\s\S]*?<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || r.text.match(/<entry[\s\S]*?<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
    const date = (r.text.match(/<(?:pubDate|updated|published)>([^<]+)</) || [])[1] || '';
    const dev = (first.match(/[ऀ-ॿ]/g) || []).length;
    console.log(`${items > 0 && r.s === 200 ? 'OK  ' : 'FAIL'} ${r.s} items=${String(items).padStart(3)} ${r.ms}ms ${u}\n      first: ${first.replace(/\s+/g, ' ').slice(0, 90)}${dev ? ' [Devanagari]' : ''} · ${date.slice(0, 31)}${r.err ? ' · ' + r.err : ''}`);
  }
}
// Openverse: free licences only, wide, large
const ov = async q => {
  const u = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) + '&license=cc0,pdm,by,by-sa&license_type=commercial&mature=false&page_size=10';
  const r = await get(u, 'application/json');
  let j = null; try { j = JSON.parse(r.text); } catch (e) { j = null; }
  const res = (j && j.results) || [];
  const rl = ['x-ratelimit-limit-anon_burst', 'x-ratelimit-remaining-anon_burst', 'x-ratelimit-limit-anon_sustained', 'x-ratelimit-remaining-anon_sustained'].map(h => r.h && r.h.get(h)).join('/');
  const wide = res.filter(x => x.width >= 640 && x.height >= 360 && x.width >= x.height);
  console.log(`openverse "${q}": ${r.s} total=${j && j.result_count} wide=${wide.length} rate=${rl} ${r.ms}ms`);
  for (const x of wide.slice(0, 2)) console.log(`   ${x.license} ${x.license_version} · ${String(x.creator || '').slice(0, 30)} · ${x.provider}/${x.source} · ${x.width}x${x.height} · ${String(x.title).slice(0, 50)} · ${String(x.url).slice(0, 70)}`);
};
const cm = async q => {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=10&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1280';
  const r = await get(u, 'application/json'); let j = null; try { j = JSON.parse(r.text); } catch (e) { j = null; }
  const pages = Object.values((j && j.query && j.query.pages) || {});
  const free = pages.filter(p => { const m = (p.imageinfo && p.imageinfo[0] && p.imageinfo[0].extmetadata) || {}; const lic = String((m.LicenseShortName || {}).value || ''); return /^(public domain|pd|cc0|cc by(-sa)? [0-9.]+)/i.test(lic) && !/nc|nd/i.test(lic); });
  console.log(`commons "${q}": ${r.s} results=${pages.length} free=${free.length} ${r.ms}ms`);
};
console.log('== photos');
for (const q of ['Reserve Bank of India', 'Narendra Modi', 'Mumbai skyline', 'artificial intelligence', 'data center', 'cricket stadium', 'United Nations headquarters', 'Bombay Stock Exchange', 'laboratory scientist', 'smartphone', 'sunrise Ganges', 'banyan tree', 'Wayanad', 'Haiti troops']) { await ov(q); await cm(q); }
