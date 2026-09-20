import type { Metadata } from "next";
import { Caveat, Fraunces, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

/*
 * Four faces, all self-hosted: the build downloads the files and serves them from this origin, so font-src stays
 * 'self'. Only the two a first screen is actually set in are preloaded. The other two are asked for when a page that
 * uses them is parsed, and until they arrive their fallback stands in: a system monospace under a source URL, and
 * the body face under a note or a stamp. Preloading all four put four fonts in front of the first paint on a phone
 * for the sake of a URL below the fold and a word inside a sticker.
 */
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], preload: false });
// Headings only.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["opsz", "SOFT"] });
// The one handwritten voice: notes on the chart, and the words inside a sticker or a stamp. Nowhere else.
const caveat = Caveat({ variable: "--font-caveat", subsets: ["latin"], weight: ["600", "700"], preload: false });

// A photograph of the production landing page at 1200 by 630, the size link previews expect, with the bird's tile set
// into its corner. It shows real data as it was on the day it was taken: retake it from the live site into
// scripts/assets/og-source.png and run `npm run build:brand-art`, never from a development server.
const SOCIAL_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  alt: "The 1stSeen landing page: Know when internships open, before everyone else, beside one program's likely opening date.",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  // Absolute URLs (the link preview image) use the host the page was asked for; without one, the configured app URL.
  const origin = host ? `${protocol}://${host}` : process.env.NEXT_PUBLIC_APP_URL || "http://localhost";

  return {
    metadataBase: new URL(origin),
    title: { default: "1stSeen: know when internships open", template: "%s · 1stSeen" },
    description: "Likely opening dates for internships, new-grad programs, and co-ops, from each program's own posting history.",
    // The scalable tile first; the 32 pixel copy is for the browsers that will not take an SVG, and the 180 is what
    // a home screen draws. All three are written by scripts/build-brand-art.mjs from the same drawing.
    icons: {
      icon: [{ url: "/favicon.svg", type: "image/svg+xml" }, { url: "/icon-32.png", sizes: "32x32", type: "image/png" }],
      shortcut: "/favicon.svg",
      apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
    },
    openGraph: {
      title: "1stSeen: know when internships open",
      description: "Likely opening dates, the postings behind them, and a prep plan for the programs you save.",
      type: "website",
      images: [SOCIAL_IMAGE],
    },
    twitter: { card: "summary_large_image", images: [SOCIAL_IMAGE] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The page grows to fill the viewport and the footer follows it, so a short page ends at the bottom of the screen.
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${caveat.variable} flex min-h-screen flex-col antialiased`}>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
