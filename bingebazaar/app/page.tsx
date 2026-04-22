import Link from "next/link";
import ProductCard from "@/components/ProductCard";
import { products, getFeatured } from "@/data/products";
import { categories, categoryOrder } from "@/lib/categories";
import { site } from "@/lib/site";

export default function HomePage() {
  const featured = getFeatured();
  const latest = [...products].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 8);

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-haldi/30 via-cream to-mint/10" />
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
          <span className="pill">Curated weekly from Amazon India</span>
          <h1 className="mt-5 max-w-3xl text-4xl font-black leading-[1.05] md:text-6xl">
            Scroll-stopping finds.{" "}
            <span className="text-mango">Most under ₹999.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink/65">
            The stuff you save on Reels and then forget about — we keep it in one place, with the
            buy link one tap away.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="#latest" className="btn-primary">
              See this week's finds
            </Link>
            <a
              href={site.instagram}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-ink/15 px-5 py-3 text-sm font-semibold hover:bg-white"
            >
              Follow on Instagram
            </a>
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="mx-auto max-w-6xl px-4">
        <div className="mb-5 flex items-end justify-between">
          <h2 className="text-2xl font-extrabold">Shop by vibe</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {categoryOrder.map((slug) => (
            <Link
              key={slug}
              href={`/category/${slug}`}
              className="rounded-2xl bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-lg"
            >
              <div className="text-sm font-bold">{categories[slug].name}</div>
              <div className="mt-1 line-clamp-2 text-xs text-ink/55">
                {categories[slug].blurb}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Featured */}
      {featured.length > 0 && (
        <section className="mx-auto mt-16 max-w-6xl px-4">
          <div className="mb-5 flex items-end justify-between">
            <h2 className="text-2xl font-extrabold">This week's hero picks</h2>
            <span className="text-xs font-medium text-ink/50">Updated weekly</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((p) => (
              <ProductCard key={p.slug} product={p} />
            ))}
          </div>
        </section>
      )}

      {/* Latest */}
      <section id="latest" className="mx-auto mt-16 max-w-6xl px-4">
        <div className="mb-5 flex items-end justify-between">
          <h2 className="text-2xl font-extrabold">Latest drops</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {latest.map((p) => (
            <ProductCard key={p.slug} product={p} />
          ))}
        </div>
      </section>

      {/* IG strip */}
      <section className="mx-auto mt-20 max-w-6xl px-4">
        <div className="rounded-3xl bg-ink p-8 text-cream md:p-12">
          <div className="max-w-2xl">
            <div className="text-xs font-bold uppercase tracking-widest text-mango">
              See it in 15 seconds
            </div>
            <h3 className="mt-3 text-3xl font-black leading-tight md:text-4xl">
              Every find has a Reel on our Instagram.
            </h3>
            <p className="mt-4 text-cream/75">
              Watch the demo, then tap the link in bio. That's the whole flow.
            </p>
            <a
              href={site.instagram}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-mango px-6 py-3 text-sm font-bold text-white hover:bg-mangoDark"
            >
              Follow @bingebazaar
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
