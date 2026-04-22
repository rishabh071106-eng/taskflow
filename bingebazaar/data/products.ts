import type { CategorySlug } from "@/lib/categories";

export type Product = {
  slug: string;
  title: string;
  tagline: string;
  priceInr: number;
  mrpInr?: number;
  image: string;
  amazonUrl: string;
  category: CategorySlug;
  highlights: string[];
  whyItsCool: string;
  addedAt: string;
  featured?: boolean;
};

// HOW TO ADD A PRODUCT
// 1. Copy the Amazon India product URL (the /dp/XXXXXXXXXX one).
// 2. Right-click the product image -> copy image address (m.media-amazon.com URL).
// 3. Add a new object below. The `tag` is appended automatically in lib/affiliate.ts.
// 4. Commit + push -> Vercel auto-deploys.

export const products: Product[] = [
  {
    slug: "silicone-sponge-holder",
    title: "Self-draining silicone sink caddy",
    tagline: "No more gross, soggy sponge puddle",
    priceInr: 299,
    mrpInr: 599,
    image:
      "https://m.media-amazon.com/images/I/71dummy-placeholder-kitchen.jpg",
    amazonUrl: "https://www.amazon.in/dp/B0EXAMPLE01",
    category: "kitchen",
    highlights: [
      "Self-draining ribbed base",
      "Sticks with no drilling",
      "Holds sponge, brush and soap bar",
    ],
    whyItsCool:
      "The one thing in your kitchen that is always wet and gross. Fixed for under 300 rupees.",
    addedAt: "2026-04-20",
    featured: true,
  },
  {
    slug: "under-bed-storage-bag",
    title: "Zippered under-bed storage bag (pack of 2)",
    tagline: "Winter quilts, gone. Floor space, back.",
    priceInr: 499,
    mrpInr: 999,
    image:
      "https://m.media-amazon.com/images/I/71dummy-placeholder-organize.jpg",
    amazonUrl: "https://www.amazon.in/dp/B0EXAMPLE02",
    category: "organize",
    highlights: [
      "Fits a double-bed quilt each",
      "Clear window — no guessing",
      "Dust & moisture proof",
    ],
    whyItsCool:
      "The 1BHK cheat code. Two of these empty out half a cupboard.",
    addedAt: "2026-04-19",
    featured: true,
  },
  {
    slug: "led-strip-bias-light",
    title: "TV backlight LED strip with remote",
    tagline: "Makes your living room look like a café",
    priceInr: 449,
    mrpInr: 899,
    image:
      "https://m.media-amazon.com/images/I/71dummy-placeholder-home.jpg",
    amazonUrl: "https://www.amazon.in/dp/B0EXAMPLE03",
    category: "home",
    highlights: [
      "Sticks to back of any TV",
      "16 colours + music sync",
      "USB powered, no extra plug",
    ],
    whyItsCool:
      "Every aesthetic Reel you save uses one of these. Now you can too.",
    addedAt: "2026-04-18",
    featured: true,
  },
  {
    slug: "laptop-riser-foldable",
    title: "Foldable laptop stand",
    tagline: "Your neck will un-clench in a week",
    priceInr: 599,
    mrpInr: 1299,
    image:
      "https://m.media-amazon.com/images/I/71dummy-placeholder-desk.jpg",
    amazonUrl: "https://www.amazon.in/dp/B0EXAMPLE04",
    category: "desk",
    highlights: [
      "Folds flat, fits in laptop bag",
      "Aluminium, holds up to 10kg",
      "Raises screen to eye level",
    ],
    whyItsCool:
      "WFH without one of these is why your back hurts. Fixed once, forever.",
    addedAt: "2026-04-17",
  },
  {
    slug: "neck-massager-pulse",
    title: "Pulse neck massager",
    tagline: "Like a masseuse lives in your collar",
    priceInr: 899,
    mrpInr: 1999,
    image:
      "https://m.media-amazon.com/images/I/71dummy-placeholder-wellness.jpg",
    amazonUrl: "https://www.amazon.in/dp/B0EXAMPLE05",
    category: "wellness",
    highlights: [
      "6 modes, 15 intensity levels",
      "USB rechargeable",
      "Heat + vibration combo",
    ],
    whyItsCool:
      "Ten minutes of this after a workday feels illegal for 899.",
    addedAt: "2026-04-16",
  },
  {
    slug: "portable-blender",
    title: "USB rechargeable portable blender",
    tagline: "Smoothies anywhere. Yes, anywhere.",
    priceInr: 799,
    mrpInr: 1499,
    image:
      "https://m.media-amazon.com/images/I/71dummy-placeholder-gadget.jpg",
    amazonUrl: "https://www.amazon.in/dp/B0EXAMPLE06",
    category: "gadgets",
    highlights: [
      "400ml bottle doubles as the jar",
      "One-button operation",
      "Charges via USB-C",
    ],
    whyItsCool:
      "Gym → protein shake → rinse → done. No jug, no mess.",
    addedAt: "2026-04-15",
  },
];

export function getFeatured(): Product[] {
  return products.filter((p) => p.featured);
}

export function getByCategory(cat: string): Product[] {
  return products.filter((p) => p.category === cat);
}

export function getBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}
