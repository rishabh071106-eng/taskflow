import type { MetadataRoute } from "next";
import { products } from "@/data/products";
import { categoryOrder } from "@/lib/categories";
import { site } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = site.url.replace(/\/$/, "");
  const now = new Date();
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/disclosure`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    ...categoryOrder.map((slug) => ({
      url: `${base}/category/${slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...products.map((p) => ({
      url: `${base}/product/${p.slug}`,
      lastModified: new Date(p.addedAt),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
