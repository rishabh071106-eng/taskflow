import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ProductCard from "@/components/ProductCard";
import { categories, categoryOrder, type CategorySlug } from "@/lib/categories";
import { getByCategory } from "@/data/products";

export async function generateStaticParams() {
  return categoryOrder.map((slug) => ({ slug }));
}

export async function generateMetadata(
  { params }: { params: { slug: string } }
): Promise<Metadata> {
  const cat = categories[params.slug as CategorySlug];
  if (!cat) return {};
  return {
    title: `${cat.name} finds`,
    description: `${cat.blurb} Curated Amazon India picks, most under ₹999.`,
  };
}

export default function CategoryPage({ params }: { params: { slug: string } }) {
  const cat = categories[params.slug as CategorySlug];
  if (!cat) notFound();
  const items = getByCategory(params.slug);

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <h1 className="text-4xl font-black md:text-5xl">{cat.name}</h1>
      <p className="mt-3 max-w-2xl text-lg text-ink/65">{cat.blurb}</p>

      {items.length === 0 ? (
        <p className="mt-10 text-ink/60">
          Nothing here yet — we're curating. Follow us on Instagram for drops.
        </p>
      ) : (
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((p) => (
            <ProductCard key={p.slug} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
