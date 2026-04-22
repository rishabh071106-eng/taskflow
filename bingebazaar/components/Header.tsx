import Link from "next/link";
import { site } from "@/lib/site";
import { categories, categoryOrder } from "@/lib/categories";

export default function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink/5 bg-cream/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-baseline gap-1">
          <span className="text-2xl font-black tracking-tight">Binge</span>
          <span className="text-2xl font-black tracking-tight text-mango">Bazaar</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm font-medium text-ink/70 md:flex">
          {categoryOrder.slice(0, 4).map((c) => (
            <Link key={c} href={`/category/${c}`} className="hover:text-ink">
              {categories[c].name}
            </Link>
          ))}
          <Link href="/about" className="hover:text-ink">About</Link>
        </nav>
        <a
          href={site.instagram}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full bg-ink px-4 py-2 text-xs font-semibold text-cream hover:bg-ink/85"
        >
          Follow on IG
        </a>
      </div>
    </header>
  );
}
