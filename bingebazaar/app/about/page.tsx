import type { Metadata } from "next";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "How BingeBazaar works",
  description: "We curate the most useful, genuinely cool stuff on Amazon India so you don't have to scroll forever.",
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-4xl font-black md:text-5xl">How this works</h1>
      <div className="prose prose-lg mt-8 max-w-none text-ink/80">
        <p>
          BingeBazaar is a hand-picked list of things on Amazon India that are genuinely useful,
          genuinely affordable, and visual enough to make you go <em>"oh wait, I need that."</em>
        </p>
        <p>
          Every week we sift through Reels, new launches and reviews, and surface a small batch.
          Most picks are under ₹999. We don't stock anything — tapping <strong>Buy on Amazon</strong>{" "}
          takes you straight to the product on Amazon.in, where you buy it normally.
        </p>
        <h2 className="mt-10 text-2xl font-bold">How we make money</h2>
        <p>
          BingeBazaar is part of the Amazon Associates programme. When you buy something using a
          link from this site, Amazon pays us a small commission at no extra cost to you. That's
          the entire business model — which is why we only list stuff we'd actually use.
        </p>
        <h2 className="mt-10 text-2xl font-bold">Follow the Reels</h2>
        <p>
          Every find has a 15-second Reel on our Instagram showing it in action.{" "}
          <a href={site.instagram} target="_blank" rel="noopener noreferrer" className="underline decoration-mango decoration-2 underline-offset-4">
            Follow @bingebazaar on Instagram
          </a>.
        </p>
      </div>
    </div>
  );
}
