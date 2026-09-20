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
 * Either way it is decoration: the company's name is written beside it.
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
  sm: { box: "size-8 rounded-control", text: "text-caption", pixels: 32 },
  md: { box: "size-11 rounded-control", text: "text-sm", pixels: 44 },
} as const;

export function CompanyMark({ company, size = "md", className }: { company: string; size?: keyof typeof SIZE; className?: string }) {
  const logo = COMPANY_LOGOS[companyKey(company)];
  const style = SIZE[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden border border-line bg-surface",
        style.box,
        !logo && "border-transparent bg-warm-soft font-bold text-warm-ink",
        !logo && style.text,
        className,
      )}
    >
      {logo
        // eslint-disable-next-line @next/next/no-img-element -- a small self-hosted icon, which the image optimizer skips
        ? <img src={`/logos/${logo}`} alt="" width={style.pixels} height={style.pixels} className="size-full object-contain p-1.5" loading="lazy" decoding="async" />
        : companyInitials(company)}
    </span>
  );
}
