import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { products, getBySlug } from "@/data/products";
import { amazonLink } from "@/lib/affiliate";
import { categories } from "@/lib/categories";
import { site } from "@/lib/site";
import ProductCard from "@/components/ProductCard";

export async function generateStaticParams() {
  return products.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(
  { params }: { params: { slug: string } }
): Promise<Metadata> {
  const product = getBySlug(params.slug);
  if (!product) return {};
  return {
    title: product.title,
    description: `${product.tagline}. ${product.whyItsCool}`,
    openGraph: {
      title: product.title,
      description: product.tagline,
      images: [{ url: product.image }],
    },
  };
}

export default function ProductPage({ params }: { params: { slug: string } }) {
  const product = getBySlug(params.slug);
  if (!product) notFound();

  const link = amazonLink(product.amazonUrl);
  const discount =
    product.mrpInr && product.mrpInr > product.priceInr
      ? Math.round(((product.mrpInr - product.priceInr) / product.mrpInr) * 100)
      : 0;

  const related = products
    .filter((p) => p.category === product.category && p.slug !== product.slug)
    .slice(0, 4);

  return (
    <article className="mx-auto max-w-6xl px-4 py-10">
      <nav className="mb-6 text-sm text-ink/55">
        <Link href="/" className="hover:text-ink">Home</Link>
        <span className="mx-2">/</span>
        <Link href={`/category/${product.category}`} className="hover:text-ink">
          {categories[product.category].name}
        </Link>
      </nav>

      <div className="grid gap-10 md:grid-cols-2">
        <div className="overflow-hidden rounded-3xl bg-white shadow-card">
          <img
            src={product.image}
            alt={product.title}
            className="aspect-square w-full object-cover"
          />
        </div>

        <div>
          <div className="pill">{categories[product.category].name}</div>
          <h1 className="mt-4 text-3xl font-black leading-tight md:text-4xl">
            {product.title}
          </h1>
          <p className="mt-3 text-lg text-ink/65">{product.tagline}</p>

          <div className="mt-6 flex items-baseline gap-3">
            <span className="text-3xl font-extrabold">
              ₹{product.priceInr.toLocaleString("en-IN")}
            </span>
            {product.mrpInr && (
              <span className="text-lg text-ink/40 line-through">
                ₹{product.mrpInr.toLocaleString("en-IN")}
              </span>
            )}
            {discount > 0 && (
              <span className="rounded-full bg-mint/15 px-2.5 py-1 text-xs font-bold text-mint">
                {discount}% off
              </span>
            )}
          </div>

          <a
            href={link}
            target="_blank"
            rel="noopener sponsored noreferrer"
            className="btn-amazon mt-6 w-full"
          >
            Buy on Amazon →
          </a>
          <p className="mt-2 text-xs text-ink/50">
            Price and stock change often on Amazon.in — confirm on the Amazon page.
          </p>

          <div className="mt-8 rounded-2xl bg-white p-5 shadow-card">
            <div className="text-xs font-bold uppercase tracking-widest text-mango">
              Why it's cool
            </div>
            <p className="mt-2 text-ink/80">{product.whyItsCool}</p>
          </div>

          <div className="mt-6">
            <div className="text-xs font-bold uppercase tracking-widest text-ink/50">
              Highlights
            </div>
            <ul className="mt-3 space-y-2 text-sm text-ink/80">
              {product.highlights.map((h) => (
                <li key={h} className="flex gap-2">
                  <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-mango" />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <section className="mt-20">
          <h2 className="mb-5 text-xl font-extrabold">More in {categories[product.category].name}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((p) => (
              <ProductCard key={p.slug} product={p} />
            ))}
          </div>
        </section>
      )}

      {/* SEO-friendly structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: product.title,
            image: product.image,
            description: product.tagline,
            brand: { "@type": "Brand", name: site.name },
            offers: {
              "@type": "Offer",
              url: link,
              priceCurrency: "INR",
              price: product.priceInr,
              availability: "https://schema.org/InStock",
            },
          }),
        }}
      />
    </article>
  );
}
