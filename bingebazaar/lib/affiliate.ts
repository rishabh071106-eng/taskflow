const DEFAULT_TAG = "bingebazaar-21";

export function amazonLink(url: string): string {
  const tag = process.env.NEXT_PUBLIC_AMAZON_TAG || DEFAULT_TAG;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("amazon.in") && !u.hostname.endsWith("amzn.to")) {
      return url;
    }
    u.searchParams.set("tag", tag);
    return u.toString();
  } catch {
    return url;
  }
}

export function extractAsin(url: string): string | null {
  const match = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}
