import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Headings only. Self-hosted like Geist: the build downloads the files and serves them from this origin.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["opsz", "SOFT"] });

// A screenshot of the production landing page at 1200 by 630, the size link previews expect. It shows real data as it
// was on the day it was taken; retake it from the live site rather than from a development server.
const SOCIAL_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  alt: "The 1stSeen landing page: Know when internships open, before everyone else, beside a real program's likely opening date.",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  // Absolute URLs (the link preview image) use the host the page was asked for; without one, the configured app URL.
  const origin = host ? `${protocol}://${host}` : process.env.NEXT_PUBLIC_APP_URL || "http://localhost";

  return {
    metadataBase: new URL(origin),
    title: { default: "1stSeen — Recruiting intelligence before the opening", template: "%s · 1stSeen" },
    description: "Evidence-backed forecasts for recurring internships, new-grad programs, and early-career roles.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "1stSeen — Recruiting intelligence before the opening",
      description: "Evidence-backed forecasts, recruiting signals, and preparation deadlines for recurring early-career roles.",
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
      <body className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} flex min-h-screen flex-col antialiased`}>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
