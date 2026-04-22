import Link from "next/link";
import type { Product } from "@/data/products";
import { categories } from "@/lib/categories";

export default function ProductCard({ product }: { product: Product }) {
  const discount =
    product.mrpInr && product.mrpInr > product.priceInr
      ? Math.round(((product.mrpInr - product.priceInr) / product.mrpInr) * 100)
      : 0;

  return (
    <Link
      href={`/product/${product.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-card transition hover:-translate-y-0.5 hover:shadow-lg"
    >
      <div className="relative aspect-square overflow-hidden bg-cream">
        <img
          src={product.image}
          alt={product.title}
          loading="lazy"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
        {discount > 0 && (
          <div className="absolute left-3 top-3 rounded-full bg-ink px-2.5 py-1 text-[10px] font-bold tracking-wide text-cream">
            {discount}% OFF
          </div>
        )}
        <div className="absolute right-3 top-3 rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-ink/70 backdrop-blur">
          {categories[product.category].name}
        </div>
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 font-semibold leading-snug">{product.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-ink/60">{product.tagline}</p>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-lg font-extrabold">₹{product.priceInr.toLocaleString("en-IN")}</span>
          {product.mrpInr && (
            <span className="text-sm text-ink/40 line-through">
              ₹{product.mrpInr.toLocaleString("en-IN")}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
