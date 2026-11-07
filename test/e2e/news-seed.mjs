// News Desk stories for the e2e suites: seedNews(dbPath, mediaDir) writes a few written stories into news_stories and
// their photos into MEDIA_DIR/news-img (what modules/newsdesk.js serves at /api/news/img/<id>), plus the edition they
// came in. Call it on a copy of the template database before the server boots (the boot cleanup keeps them: every
// summary has 70+ words, English fields carry no Devanagari, every photo has its free-licence credit).
//   n36land  India     landscape photo (16:9)          n36port  World     portrait photo (2:3)
//   n36none  Science   no photo at all (never shown)   n36gone  Business  credited photo the test answers 404 for
//   n36sq    Tech      square photo                    n36pano  AI        very wide photo (3:1)
//   n36bad   Life      a "photo" file that is not an image (the browser cannot draw it)
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(ROOT + '/package.json');

// stand-in "photos": drawn scenes (no outside files in tests), in the shapes real photos come in
const scene = {
  land: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1600 900"><defs>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B3A67"/><stop offset=".55" stop-color="#E07A5F"/><stop offset="1" stop-color="#F2CC8F"/></linearGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C46A55"/><stop offset="1" stop-color="#2B2D42"/></linearGradient></defs>
<rect width="1600" height="900" fill="url(#s)"/><circle cx="1080" cy="520" r="120" fill="#FFE8B0" opacity=".95"/>
<path d="M0 560 L220 380 L380 500 L560 300 L760 520 L980 360 L1180 540 L1380 400 L1600 520 L1600 900 L0 900Z" fill="#3D405B"/>
<path d="M0 640 L260 520 L480 610 L700 480 L940 620 L1160 520 L1400 640 L1600 580 L1600 900 L0 900Z" fill="#26283B"/>
<rect y="700" width="1600" height="200" fill="url(#w)" opacity=".9"/><rect x="1020" y="720" width="120" height="6" fill="#FFE8B0" opacity=".7"/><rect x="1040" y="750" width="80" height="5" fill="#FFE8B0" opacity=".5"/></svg>`,
  port: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 900 1350"><defs>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D4E89"/><stop offset="1" stop-color="#9AD1D4"/></linearGradient></defs>
<rect width="900" height="1350" fill="url(#s)"/><ellipse cx="220" cy="260" rx="160" ry="46" fill="#fff" opacity=".7"/><ellipse cx="660" cy="420" rx="200" ry="52" fill="#fff" opacity=".55"/>
<path d="M390 1350 L420 420 L480 420 L510 1350Z" fill="#F4F1DE"/><rect x="404" y="560" width="92" height="70" fill="#E07A5F"/><rect x="398" y="800" width="104" height="70" fill="#E07A5F"/>
<rect x="400" y="340" width="100" height="80" fill="#3D405B"/><path d="M380 340 L450 270 L520 340Z" fill="#E07A5F"/><circle cx="450" cy="380" r="22" fill="#FFE8B0"/>
<path d="M0 1180 Q220 1120 450 1190 T900 1170 L900 1350 L0 1350Z" fill="#2A6F4E"/></svg>`,
  sq: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1200 1200"><defs>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B132B"/><stop offset="1" stop-color="#3A506B"/></linearGradient></defs>
<rect width="1200" height="1200" fill="url(#s)"/><circle cx="900" cy="250" r="70" fill="#F0F3BD"/>
${[[60, 520, 150], [230, 380, 120], [370, 600, 140], [530, 300, 160], [710, 470, 130], [860, 560, 150], [1030, 420, 140]].map(([x, y, bw]) => `<rect x="${x}" y="${y}" width="${bw}" height="${1200 - y}" fill="#1C2541"/>` + Array.from({ length: 8 }, (_, k) => `<rect x="${x + 20 + (k % 3) * 40}" y="${y + 40 + Math.floor(k / 3) * 70}" width="18" height="26" fill="#FFD166" opacity=".8"/>`).join('')).join('')}</svg>`,
  pano: (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 2100 700"><defs>
<linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5F0F40"/><stop offset=".5" stop-color="#9A031E"/><stop offset="1" stop-color="#FB8B24"/></linearGradient></defs>
<rect width="2100" height="700" fill="url(#s)"/>${Array.from({ length: 14 }, (_, k) => `<circle cx="${80 + k * 150}" cy="${350 + Math.sin(k) * 120}" r="${30 + (k % 4) * 14}" fill="#fff" opacity="${0.15 + (k % 3) * 0.12}"/>`).join('')}
<path d="M0 520 C400 420 700 640 1050 520 S1700 420 2100 540 L2100 700 L0 700Z" fill="#0F0A0A" opacity=".8"/></svg>`,
};
function png(svg) { const { Resvg } = require('@resvg/resvg-js'); return new Resvg(svg).render().asPng(); }

const credit = (by, license, file) => JSON.stringify({ by, license, page: 'https://commons.wikimedia.org/wiki/File:' + file, title: file.replace(/_/g, ' ').replace(/\.\w+$/, ''), source: 'Wikimedia Commons', via: 'writer' });
const src = (...names) => JSON.stringify(names.map(([name, link]) => ({ name, link })));
export const STORIES = [
  { id: 'n36land', category: 'india', photo: 'land', size: [1600, 900], credit: credit('Asha Menon', 'CC BY-SA 4.0', 'Backwaters_at_dusk.jpg'),
    headline: 'Kerala adds evening ferries on the backwaters as commuter numbers climb',
    summary: 'The state water transport department will run four more ferries every evening between Alappuzha and Kottayam from next week, after its counts showed more office workers using the boats than buses on the route. Each new ferry carries up to 75 passengers and runs on solar power for most of the trip. Tickets stay at the same price, and monthly passes can now be bought on the phone. Officials said the timetable will be checked again after three months, once they know which departures fill up first.',
    headline_hi: 'केरल में बैकवाटर पर शाम की नई फ़ेरी, यात्रियों की संख्या बढ़ी',
    summary_hi: 'राज्य जल परिवहन विभाग अगले हफ़्ते से अलाप्पुझा और कोट्टायम के बीच हर शाम चार और फ़ेरी चलाएगा। गिनती में पता चला कि इस रास्ते पर दफ़्तर जाने वाले लोग बसों से ज़्यादा नावों का इस्तेमाल कर रहे हैं। हर नई फ़ेरी में पचहत्तर यात्री बैठ सकते हैं और यह ज़्यादातर सफ़र सौर ऊर्जा से चलती है। टिकट का दाम वही रहेगा, और मासिक पास अब फ़ोन पर भी ख़रीदे जा सकते हैं। अधिकारियों ने कहा कि तीन महीने बाद समय-सारणी फिर से देखी जाएगी, जब पता चलेगा कि कौन सी फ़ेरी सबसे पहले भरती है।',
    sources: src(['thehindu.com', 'https://www.thehindu.com/news/national/kerala/'], ['indianexpress.com', 'https://indianexpress.com/section/india/'], ['pib.gov.in', 'https://pib.gov.in/']), source_count: 3 },
  { id: 'n36port', category: 'world', photo: 'port', size: [900, 1350], credit: credit('L. Ortega', 'CC BY 4.0', 'Harbour_lighthouse.jpg'),
    headline: 'Portugal restores a 19th-century lighthouse and opens it to visitors',
    summary: 'A lighthouse on the Atlantic coast that guided ships for more than a century has reopened after two years of repairs, with its original lens cleaned and put back in place. Visitors can now climb its spiral stairs on weekends, in small groups led by local guides. The town says the money from tickets will pay for the upkeep of the tower and the small museum at its base. Ships still use the light at night, now run by an automatic lamp that needs far less power than the old one.',
    headline_hi: 'पुर्तगाल ने उन्नीसवीं सदी का प्रकाश स्तंभ ठीक कराया, अब लोग देख सकेंगे',
    summary_hi: 'अटलांटिक तट पर सौ साल से ज़्यादा समय तक जहाज़ों को रास्ता दिखाने वाला प्रकाश स्तंभ दो साल की मरम्मत के बाद फिर खुल गया है। इसका पुराना लेंस साफ़ करके वापस लगाया गया है। अब लोग सप्ताहांत पर छोटे समूहों में स्थानीय गाइड के साथ इसकी घुमावदार सीढ़ियाँ चढ़ सकते हैं। शहर का कहना है कि टिकट से मिलने वाला पैसा मीनार और उसके नीचे बने छोटे संग्रहालय की देखभाल पर ख़र्च होगा। जहाज़ अब भी रात में इसकी रोशनी का इस्तेमाल करते हैं, जो अब एक स्वचालित लैंप से चलती है।',
    sources: src(['bbc.com', 'https://www.bbc.com/news/world'], ['reuters.com', 'https://www.reuters.com/world/']), source_count: 2 },
  { id: 'n36none', category: 'science', photo: null,
    headline: 'Researchers map the sleep patterns of migrating birds over the ocean',
    summary: 'A team that fitted small sensors to seabirds found that the birds take hundreds of very short naps while flying over open water, each lasting only a few seconds. Over a day the naps added up to less than an hour of sleep, far less than the birds get on land. The researchers say the birds seem to rest one half of the brain at a time, keeping watch with the other half. They plan to follow the same birds next season to see whether younger ones sleep differently.',
    sources: src(['sciencedaily.com', 'https://www.sciencedaily.com/']), source_count: 1 },
  { id: 'n36gone', category: 'business', photo: 'land', size: [1400, 900], credit: credit('R. Iyer', 'CC0', 'Port_cranes.jpg'),
    headline: 'Coastal ports report record container traffic for the October quarter',
    summary: 'Ports along the western coast handled more containers between August and October than in any quarter before, helped by faster customs checks and a new rail link to the inland depots. Shipping lines said waiting times for berths fell to under a day at the two busiest terminals. Exporters of textiles and machine parts made up most of the growth. The port authority expects the numbers to dip in the next quarter, as they usually do after the festival season, before rising again in spring.',
    sources: src(['livemint.com', 'https://www.livemint.com/'], ['economictimes.com', 'https://economictimes.indiatimes.com/']), source_count: 2 },
  { id: 'n36sq', category: 'tech', photo: 'sq', size: [1200, 1200], credit: credit('Mei Tan', 'CC BY-SA 3.0', 'City_lights_at_night.jpg'),
    headline: 'City switches its streetlights to sensors that dim when roads are empty',
    summary: 'A city council has finished fitting about 40,000 streetlights with motion sensors that dim the lamps on empty roads late at night and brighten them again when a car, bike or person comes near. In the first month the city used about a third less power for street lighting. Residents asked for the change to stop at busy junctions, so those lights stay fully on. The council says the sensors also report broken lamps on their own, so repairs now start the same day.',
    headline_hi: 'शहर की सड़कों पर ऐसी बत्तियाँ जो सड़क ख़ाली होने पर धीमी हो जाती हैं',
    summary_hi: 'एक नगर परिषद ने लगभग चालीस हज़ार स्ट्रीटलाइटों में ऐसे सेंसर लगा दिए हैं जो देर रात ख़ाली सड़क पर बत्ती धीमी कर देते हैं और किसी गाड़ी, साइकिल या व्यक्ति के पास आने पर फिर तेज़ कर देते हैं। पहले महीने में शहर ने सड़क की रोशनी पर लगभग एक तिहाई कम बिजली ख़र्च की। लोगों के कहने पर व्यस्त चौराहों की बत्तियाँ पूरी रोशनी में ही रहेंगी। परिषद का कहना है कि सेंसर ख़राब लैंप की जानकारी भी ख़ुद भेज देते हैं, इसलिए मरम्मत उसी दिन शुरू हो जाती है।',
    sources: src(['theverge.com', 'https://www.theverge.com/'], ['techcrunch.com', 'https://techcrunch.com/']), source_count: 2 },
  { id: 'n36pano', category: 'ai', photo: 'pano', size: [2100, 700], credit: credit('Open Lab Photos', 'CC BY 2.0', 'Lab_panorama.jpg'),
    headline: 'Open-source speech model learns twelve Indian languages from radio archives',
    summary: 'Researchers released a free speech-recognition model trained on decades of public radio recordings in twelve Indian languages, including Odia, Assamese and Konkani, which have had few such tools. In their tests it wrote down news broadcasts with about half the errors of the best earlier free model. The team published the model, the code and a list of the recordings it used, and says anyone can build on it. They now plan to add more languages and to make the model small enough to run on a phone.',
    sources: src(['huggingface.co', 'https://huggingface.co/blog'], ['analyticsindiamag.com', 'https://analyticsindiamag.com/']), source_count: 2 },
  { id: 'n36bad', category: 'life', photo: 'bad', credit: credit('Unknown', 'CC BY 4.0', 'Garden.jpg'),
    headline: 'Community gardens on school rooftops grow vegetables for midday meals',
    summary: 'Students at a group of government schools now grow tomatoes, spinach and beans on their school rooftops, and the harvest goes straight into the midday meals served in the same buildings. Teachers say the gardens also became outdoor science classes, where children measure plant growth and keep weather records. Each rooftop garden was set up with recycled containers and a simple drip system that uses rainwater collected from the roof. The district plans to add twenty more schools to the programme by next year.',
    sources: src(['ndtv.com', 'https://www.ndtv.com/']), source_count: 1 },
];
// the order the desk ranks them in (source_count desc, then newest): n36land, then the 2-source ones, then the rest
export const WITH_PHOTO = ['n36land', 'n36port', 'n36sq', 'n36pano'];
export const HIDDEN = ['n36none', 'n36gone', 'n36bad'];

export function seedNews(dbPath, mediaDir) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const now = Date.now();
  const img = path.join(mediaDir, 'news-img'); fs.mkdirSync(img, { recursive: true });
  const ins = db.prepare(`INSERT OR REPLACE INTO news_stories(id, cluster_key, category, headline, summary, why, headline_hi, summary_hi, why_hi, sources, image, writer, source_count, published_at, created_at, edition, image_credit, image_query)
    VALUES(@id, @id, @category, @headline, @summary, '', @headline_hi, @summary_hi, '', @sources, @image, 'gemini', @source_count, @published_at, datetime('now'), @edition, @image_credit, '')`);
  const ed = require(ROOT + '/modules/newsdesk.js').editionOf(new Date(now)), edition = ed.id, slot = ed.slot;
  STORIES.forEach((st, k) => {
    ins.run({ id: st.id, category: st.category, headline: st.headline, summary: st.summary, headline_hi: st.headline_hi || '', summary_hi: st.summary_hi || '', sources: st.sources, source_count: st.source_count,
      image: st.photo ? 'https://upload.wikimedia.org/wikipedia/commons/x/' + st.id + '.jpg' : null, image_credit: st.photo ? st.credit : null,
      published_at: new Date(now - (k + 1) * 47 * 60e3).toISOString(), edition });
    if (st.photo === 'bad') fs.writeFileSync(path.join(img, st.id + '.jpg'), Buffer.alloc(6000, 7));
    else if (st.photo) fs.writeFileSync(path.join(img, st.id + '.png'), png(scene[st.photo](st.size[0], st.size[1])));
  });
  db.prepare('INSERT OR REPLACE INTO news_editions(id, slot, at, stories, writer) VALUES(?,?,?,?,?)').run(edition, slot, ed.at, STORIES.length, 'gemini');
  db.close();
  return { edition };
}
