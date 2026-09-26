import { COMPANY_LOGOS } from "@/lib/brand/company-logos";
import { cn } from "@/lib/utils";

/**
 * A company's own mark beside its programs, or its initials when 1stSeen does not have one.
 *
 * The mark is the favicon the company publishes, fetched once and served from this origin
 * (scripts/fetch-company-logos.mjs), so a card never tells a company who is looking at it and the
 * Content-Security-Policy stays `img-src 'self'`. A company with no usable favicon keeps its letter tile, which is
 * what every card had before and is a perfectly good mark.
 *
 * Either way it is decoration: the company's name is written beside it. A mark is fetched lazily and decoded off the
 * main thread, so a list of forty of them costs a phone nothing until they are scrolled to; `priority` is for the one
 * mark that is already on the first screen, which should not be queued behind anything.
 */

/** The key a logo is filed under: the company's name, folded the way scripts/fetch-company-logos.mjs folds it. */
export function companyKey(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function companyInitials(company: string): string {
  const parts = company.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}

const SIZE = {
  sm: { box: "size-8", text: "text-micro", pixels: 32 },
  md: { box: "size-10", text: "text-caption", pixels: 40 },
} as const;

export function CompanyMark({ company, size = "md", priority = false, className }: { company: string; size?: keyof typeof SIZE; priority?: boolean; className?: string }) {
  const logo = COMPANY_LOGOS[companyKey(company)];
  const style = SIZE[size];
  return (
    <span
      aria-hidden="true"
      /*
       * One tile, whichever it holds. A logo used to sit on a bordered white square and a monogram on an unbordered
       * warm one, so a column of them alternated between two shapes and read as half-finished rather than as a column.
       * The ground, the border and the radius are now the same for both, and the monogram is quiet, because it is
       * what the product has rather than what the company published. A cell is never empty: `companyInitials` answers
       * "?" for a name it cannot read.
       */
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-control border border-line bg-surface",
        style.box,
        !logo && "font-semibold tracking-tight text-ink-subtle",
        !logo && style.text,
        className,
      )}
    >
      {logo
        // eslint-disable-next-line @next/next/no-img-element -- a small self-hosted icon, which the image optimizer skips
        ? <img src={`/logos/${logo}`} alt="" width={style.pixels} height={style.pixels} className="size-full object-contain p-1.5" loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "low"} decoding="async" />
        : companyInitials(company)}
    </span>
  );
}
