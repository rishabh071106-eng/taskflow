// Why do the India and World pool searches find nothing? The real finder, plus each Commons result's rejection reason.
const P = require('./newsphoto.cjs');
const QS = { india: ['India Gate New Delhi', 'Gateway of India Mumbai', 'Parliament House New Delhi', 'Howrah Bridge Kolkata', 'Charminar Hyderabad', 'Mysore Palace', 'Hawa Mahal Jaipur', 'Marine Drive Mumbai'], world: ['United Nations headquarters', 'Earth from space', 'Tower Bridge London', 'Sydney Opera House', 'Eiffel Tower Paris', 'Tokyo skyline', 'Brandenburg Gate', 'world map globe'], ai: ['data center servers'] };
const strip = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
(async () => {
  for (const [cat, qs] of Object.entries(QS)) for (const q of qs) {
    const t0 = Date.now(); console.log('== ' + q); const hit = await P.findDebug(q);
    console.log(`${cat} "${q}": ${hit ? 'FOUND ' + hit.license + ' · ' + hit.title.slice(0, 50) : 'none'} (${Date.now() - t0}ms)`);
    continue;
    const u = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrnamespace: '6', gsrlimit: '12', gsrsearch: q + ' filetype:bitmap', prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: '960', iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|NonFree|Restrictions|ObjectName|ImageDescription', origin: '*' });
    const r = await fetch(u, { headers: { 'User-Agent': P.UA } }); const j = await r.json().catch(() => null);
    for (const p of ((j && j.query && j.query.pages) || []).slice(0, 6)) {
      const ii = p.imageinfo && p.imageinfo[0] || {}; const m = ii.extmetadata || {};
      const why = [];
      if (!/^image\/(jpeg|png)$/.test(ii.mime || '')) why.push('mime ' + ii.mime);
      if ((ii.width || 0) < 640 || (ii.height || 0) < 360 || ii.height > ii.width * 1.25) why.push('size ' + ii.width + 'x' + ii.height);
      if (!P.freeLicense(m)) why.push('licence ' + strip(m.LicenseShortName && m.LicenseShortName.value));
      if (strip(m.Restrictions && m.Restrictions.value)) why.push('restrictions ' + strip(m.Restrictions.value).slice(0, 40));
      console.log(`     ${String(p.title).slice(5, 55)} → ${why.join('; ') || 'ok?? (relevance)'}`);
    }
  }
})();
