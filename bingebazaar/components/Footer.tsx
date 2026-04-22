import Link from "next/link";
import { site } from "@/lib/site";
import { categories, categoryOrder } from "@/lib/categories";

export default function Footer() {
  return (
    <footer className="mt-20 border-t border-ink/10 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-black">Binge</span>
              <span className="text-xl font-black text-mango">Bazaar</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-ink/60">{site.tagline}</p>
            <a
              href={site.instagram}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-sm font-semibold text-ink underline decoration-mango decoration-2 underline-offset-4"
            >
              Follow the Reels on Instagram
            </a>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-ink/50">Shop</div>
            <ul className="mt-3 space-y-2 text-sm">
              {categoryOrder.map((c) => (
                <li key={c}>
                  <Link href={`/category/${c}`} className="text-ink/75 hover:text-ink">
                    {categories[c].name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-widest text-ink/50">About</div>
            <ul className="mt-3 space-y-2 text-sm">
              <li><Link href="/about" className="text-ink/75 hover:text-ink">How this works</Link></li>
              <li><Link href="/disclosure" className="text-ink/75 hover:text-ink">Affiliate disclosure</Link></li>
            </ul>
          </div>
        </div>
        <p className="mt-10 border-t border-ink/10 pt-6 text-xs leading-relaxed text-ink/50">
          As an Amazon Associate, BingeBazaar earns from qualifying purchases. Prices, availability
          and offers shown are indicative and change frequently on Amazon.in — always confirm the
          final price on the Amazon page before buying.
        </p>
      </div>
    </footer>
  );
}
