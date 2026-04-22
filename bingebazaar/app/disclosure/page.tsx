import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Affiliate disclosure",
  description: "BingeBazaar's affiliate disclosure for Amazon India.",
};

export default function DisclosurePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-4xl font-black md:text-5xl">Affiliate disclosure</h1>
      <div className="prose prose-lg mt-8 max-w-none text-ink/80">
        <p>
          BingeBazaar is a participant in the Amazon Services LLC Associates Program, an affiliate
          advertising programme designed to provide a means for sites to earn advertising fees by
          advertising and linking to Amazon.in.
        </p>
        <p>
          When you click a product link on this site and make a purchase on Amazon.in, we may
          receive a small commission from Amazon. This does not affect the price you pay.
        </p>
        <p>
          Prices, offers and availability shown on BingeBazaar are indicative and change frequently
          on Amazon — please always confirm the final price on the Amazon product page before
          purchasing.
        </p>
        <p>
          Product selection is based on our own editorial judgement. We are not paid by brands to
          feature specific products.
        </p>
      </div>
    </div>
  );
}
