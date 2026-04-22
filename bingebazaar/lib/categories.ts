export type CategorySlug =
  | "kitchen"
  | "home"
  | "organize"
  | "gadgets"
  | "wellness"
  | "desk";

export const categories: Record<CategorySlug, { name: string; emoji: string; blurb: string }> = {
  kitchen: {
    name: "Kitchen",
    emoji: "",
    blurb: "Smart tools that make cooking faster and cleanup painless.",
  },
  home: {
    name: "Home Decor",
    emoji: "",
    blurb: "Small upgrades that make a room look ten times better.",
  },
  organize: {
    name: "Organize",
    emoji: "",
    blurb: "Bins, racks and hacks for a clutter-free life.",
  },
  gadgets: {
    name: "Gadgets",
    emoji: "",
    blurb: "Clever little things that feel like cheating.",
  },
  wellness: {
    name: "Wellness",
    emoji: "",
    blurb: "Self-care finds that actually get used daily.",
  },
  desk: {
    name: "Desk & WFH",
    emoji: "",
    blurb: "Set-up upgrades your back will thank you for.",
  },
};

export const categoryOrder: CategorySlug[] = [
  "kitchen",
  "home",
  "organize",
  "gadgets",
  "wellness",
  "desk",
];
