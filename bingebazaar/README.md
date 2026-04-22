# BingeBazaar

Scroll-stopping Amazon India finds — curated weekly, most under ₹999.
Next.js 14 (App Router) · TypeScript · Tailwind. Static site. Runs free on Vercel.

The site is the supporting asset. **Instagram Reels is the traffic engine.**

---

## Quick start (local)

```bash
cd bingebazaar
cp .env.example .env.local   # put your real Amazon tag in here
npm install
npm run dev
```

Open http://localhost:3000.

## Env vars

| Var | Example | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_AMAZON_TAG` | `yourname-21` | Your Amazon Associates India tracking ID. Appended to every outbound link. |
| `NEXT_PUBLIC_SITE_URL` | `https://bingebazaar.in` | Used for SEO tags, sitemap, OG URLs. |
| `NEXT_PUBLIC_INSTAGRAM` | `https://instagram.com/bingebazaar` | Follow button target. |

## Add a new product

Every product is one entry in `data/products.ts`. Steps:

1. Pick something on **amazon.in** you actually like. Grab the `/dp/XXXXXXXXXX` URL.
2. Right-click the main image → Copy image address (the `m.media-amazon.com/...jpg` URL).
3. Append an object to the `products` array:

```ts
{
  slug: "short-url-friendly-id",
  title: "What it is, in one line",
  tagline: "Why someone would want it",
  priceInr: 599,
  mrpInr: 999,             // optional, shows strike-through + % off
  image: "https://m.media-amazon.com/images/I/XXXXX.jpg",
  amazonUrl: "https://www.amazon.in/dp/B0XXXXXXXX",
  category: "kitchen",     // see lib/categories.ts
  highlights: [
    "One-line bullet",
    "Another bullet",
  ],
  whyItsCool: "One punchy sentence for the product page.",
  addedAt: "2026-04-22",
  featured: true,          // optional, surfaces on homepage hero strip
}
```

4. Commit + push. Vercel rebuilds automatically.

You do **not** need to add `?tag=` manually. `lib/affiliate.ts` appends your tag from the env var on every outbound click.

## Deploy (free tier)

1. Push this repo to GitHub.
2. Go to [vercel.com](https://vercel.com), import the repo.
3. Set the root directory to `bingebazaar`.
4. Add the three env vars above in Vercel project settings.
5. Buy a domain (Namecheap / GoDaddy India, ~₹800/yr). Point it at Vercel.
6. Done. Free tier handles the traffic you'll realistically get in year 1.

## The actual playbook (read this)

The site is 10% of the game. The real work is on Instagram.

### Week-by-week (first 30 days)

- **Week 1 — Ship:** Finish 15 product entries. Create IG handle `@bingebazaar`. Buy domain. Set up link-in-bio tool (or just use the BingeBazaar homepage as your link).
- **Week 2 — Content sprint:** Shoot 14 Reels. Keep them 7–15 seconds. Hook in first 2 seconds. Caption has the product link. Post 1–2/day.
- **Week 3 — Post + engage:** Post daily. Spend 30 min/day commenting on bigger accounts in your niche. Aim for **3 qualifying affiliate sales** — family/friends buying through your link counts — to keep your Amazon Associates account active (180-day rule).
- **Week 4 — Double down:** Look at analytics. Kill what didn't work. Shoot more of what did. By now you should know if the niche has legs.

### Reel formula that works for product finds

1. **Hook (0–2s):** "Under ₹500 and I use it every day."
2. **Demo (2–10s):** Product in actual use. No talking head needed.
3. **Price reveal (10–13s):** Show the price on screen.
4. **CTA (13–15s):** "Link in bio. Saved it under [category]."

### Don't do

- Don't list the same product Amazon promotes in every festive sale — the commission drops to 0% during "Special Links" campaigns.
- Don't include price in the caption as a static number — Amazon ToS bans showing cached prices. Say "under ₹500" not "₹499".
- Don't use shortened Amazon links that hide the affiliate tag — use the full deep link.
- Don't buy through your own primary account (Amazon flags this and can close the Associates account).

### Amazon Associates India rules you must follow

- **Disclose affiliation** on the site (done — footer + `/disclosure`).
- **Don't cache prices.** Our product pages show prices but tell the user to confirm on Amazon. That's compliant but you must update `priceInr` when prices change materially.
- **3 qualifying sales in 180 days** or the account is closed. Plan a launch push.
- **Don't send affiliate links over email or DM** to strangers — that's against Associates ToS. On-site and public social is fine.

## Extracting to its own repo later

Currently this lives inside the `taskflow` repo as a subfolder. To split it out:

```bash
git clone <taskflow-repo> bingebazaar-standalone
cd bingebazaar-standalone
git filter-repo --subdirectory-filter bingebazaar
git remote set-url origin <new-repo-url>
git push -u origin main
```

## File map

```
bingebazaar/
├── app/
│   ├── layout.tsx            # site shell, SEO defaults
│   ├── page.tsx              # homepage (hero, categories, featured, latest)
│   ├── product/[slug]/page.tsx   # product detail + schema.org
│   ├── category/[slug]/page.tsx  # category grid
│   ├── about/page.tsx
│   ├── disclosure/page.tsx
│   ├── sitemap.ts            # auto sitemap.xml
│   ├── robots.ts
│   └── globals.css
├── components/
│   ├── Header.tsx
│   ├── Footer.tsx
│   └── ProductCard.tsx
├── data/
│   └── products.ts           # <-- you edit this to add products
├── lib/
│   ├── affiliate.ts          # appends your Amazon tag
│   ├── categories.ts
│   └── site.ts
├── .env.example
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```
