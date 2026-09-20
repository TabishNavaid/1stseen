import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { getContactEmail } from "@/lib/config";
import { publishedSitePages, sitePage } from "@/lib/site-links";

/**
 * The one product-wide disclosure, on every page. Uncertainty that belongs to a particular forecast (its interval,
 * evidence class, cycle count, and confidence) stays on that forecast; what is true of every forecast is said here,
 * once, and the methodology page carries the detail and the current backtest position.
 */
export function SiteFooter() {
  const methodology = sitePage("methodology");
  return (
    <footer className="border-t border-line bg-surface-sunken">
      <div className="mx-auto grid max-w-[1500px] gap-4 px-4 py-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10 md:px-6">
        <div className="max-w-3xl">
          <BrandMark markId="brand-mark-foot" className="-ml-1" />
          <p className="mt-2 text-caption leading-5 text-ink-muted">
            Opening dates on 1stSeen are predictions from each program&apos;s public posting history, and their accuracy is
            not yet validated. 1stSeen is independent, and not affiliated with or endorsed by any company it lists.{" "}
            <Link href={methodology.href} className="link-accent focus-ring">How forecasts are made, and how accurate they are</Link>
          </p>
        </div>
        <nav aria-label="About 1stSeen">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 md:max-w-[340px] md:justify-end">
            {publishedSitePages(getContactEmail() !== null).map((page) => (
              <li key={page.key}>
                <Link href={page.href} className="focus-ring inline-flex min-h-touch items-center text-caption text-ink-muted hover:text-ink sm:min-h-0">{page.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
