import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "1stseen.example";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: { default: "1stSeen — Recruiting intelligence before the opening", template: "%s · 1stSeen" },
    description: "Evidence-backed forecasts for recurring internships, new-grad programs, and early-career roles.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "1stSeen — Recruiting intelligence before the opening",
      description: "Evidence-backed forecasts, recruiting signals, and preparation deadlines for recurring early-career roles.",
      type: "website",
    },
    // No social image yet: a production screenshot is added with the og:image and twitter:image tags.
    twitter: { card: "summary" },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The page grows to fill the viewport and the footer follows it, so a short page ends at the bottom of the screen.
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} flex min-h-screen flex-col antialiased`}>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
