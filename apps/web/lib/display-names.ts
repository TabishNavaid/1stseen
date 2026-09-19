/**
 * How company names, program titles, and places read on the page.
 *
 * The stored values are keys for matching, not names for reading: collection lower-cases a title, replaces every
 * character outside a-z, 0-9 and "+" with a space (so "Stagiaire en développement" became "Stagiaire En D Veloppement"),
 * and title-cases the rest ("C++ Or Python", "Co Op"). Places are stored the same way ("new york ny"). Nothing here
 * changes a stored value; it only decides what a person reads.
 *
 * - A title is shown as the company published it whenever one of the role's recorded titles (role_aliases) folds to
 *   exactly the stored title, which brings back accents and punctuation from the source itself. Otherwise the stored
 *   title is tidied: known acronyms, "Co-op", and joining words in lower case.
 * - A company name is the stored name with a few corrections the stored names need ("Imc" is IMC).
 * - A place is title-cased with its codes in capitals and commas before the region: "chicago il" is "Chicago, IL".
 *
 * Pure, so the tests read it directly.
 */

/** Stored company names that do not read as the company writes its own name. */
const COMPANY_NAMES: Record<string, string> = {
  imc: "IMC",
  jumptrading: "Jump Trading",
  "vercel inc.": "Vercel",
  "vercel inc": "Vercel",
};

export function displayCompany(name: string): string {
  const trimmed = name.trim();
  return COMPANY_NAMES[trimmed.toLowerCase()] ?? trimmed.replace(/,?\s+Inc\.?$/i, "");
}

/** Words that are written in capitals, or in their own mixed case, inside a title. Keys are lower case. */
const TITLE_WORDS: Record<string, string> = {
  ai: "AI", ml: "ML", nlp: "NLP", llm: "LLM", vlm: "VLM", genai: "GenAI", cv: "CV",
  phd: "PhD", phds: "PhDs", ms: "MS", bs: "BS", mba: "MBA",
  fpga: "FPGA", asic: "ASIC", rf: "RF", dv: "DV", iot: "IoT", bci: "BCI", ota: "OTA", hpc: "HPC", gpu: "GPU", cpu: "CPU",
  sre: "SRE", qa: "QA", api: "API", ui: "UI", ux: "UX", ios: "iOS", it: "IT", pm: "PM", apm: "APM", tpm: "TPM",
  us: "US", uk: "UK", eu: "EU", nyc: "NYC", sf: "SF", eit: "EIT",
  devops: "DevOps", mlops: "MLOps", fintech: "FinTech", javascript: "JavaScript", typescript: "TypeScript",
};

/** Joining words, lower case anywhere but the start of a title. */
const SMALL_WORDS = new Set(["an", "and", "at", "de", "des", "du", "en", "et", "for", "in", "of", "on", "or", "the", "to", "with"]);

function capitalize(word: string): string {
  return word ? word.charAt(0).toLocaleUpperCase("en-US") + word.slice(1) : word;
}

/** A stored title, tidied for reading. Accents and letters already present are kept as they are. */
export function tidyTitle(title: string): string {
  const joined = title
    .replace(/\s+/g, " ")
    .trim()
    // "Co Op", "Co-Op", "Coop", "co-op": the program is a co-op.
    .replace(/\b(co)[\s-]?(op)s?\b/gi, (match) => (/s$/i.test(match) ? "Co-ops" : "Co-op"));
  return joined
    .split(" ")
    .map((word, index) => {
      const bare = word.replace(/^[("'“]+|[)"'”,:;.]+$/g, "");
      const lower = bare.toLowerCase();
      let next = bare;
      if (TITLE_WORDS[lower]) next = TITLE_WORDS[lower];
      else if (index > 0 && SMALL_WORDS.has(lower)) next = lower;
      else if (/^[a-z]/.test(bare)) next = capitalize(bare);
      return word.replace(bare, next);
    })
    .join(" ");
}

/** A title as collection stored it: lower case, and every run of other characters one space. */
export function foldTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
}

export type RecordedTitle = { title: string; lastSeenAt: string };

/**
 * The title to show for a role: the most recently seen of its recorded titles that folds to the stored title, as the
 * company wrote it; otherwise the stored title, tidied.
 */
export function displayTitle(stored: string, recorded: readonly RecordedTitle[] = []): string {
  const key = foldTitle(stored);
  const source = [...recorded]
    .filter((item) => item.title.trim() && foldTitle(item.title) === key)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  return source ? source.title.replace(/\s+/g, " ").trim() : tidyTitle(stored);
}

const US_STATES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming", "ontario", "quebec", "british columbia", "alberta",
]);

const COUNTRIES = new Set([
  "united states", "united kingdom", "canada", "france", "germany", "netherlands", "ireland", "switzerland", "singapore",
  "australia", "india", "japan", "south korea", "korea", "china", "hong kong", "taiwan", "israel", "spain", "italy",
  "portugal", "poland", "romania", "turkey", "vietnam", "mexico", "brazil", "costa rica", "sweden", "denmark", "norway",
  "finland", "belgium", "austria", "czech republic", "hungary", "united arab emirates",
]);

/** A stored place as a place name; "unspecified" is a statement, not a place. */
export function displayPlace(scope: string | null | undefined): string {
  if (!scope || scope.trim().toLowerCase() === "unspecified") return "Location not stated";
  let words = scope.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  const parts: string[] = [];
  // "washington d c" is Washington, D.C.
  if (words.slice(-2).join(" ") === "d c") {
    words = words.slice(0, -2);
    parts.unshift("D.C.");
  }
  // Trailing two-letter codes (a state, province, or country) are capitals, each after a comma.
  while (words.length > 1 && /^[a-z]{2}$/.test(words[words.length - 1])) {
    parts.unshift(words.pop()!.toUpperCase());
  }
  // A trailing region or country written out is its own part.
  for (const size of [3, 2, 1]) {
    if (words.length <= size) continue;
    const tail = words.slice(-size).join(" ");
    if (US_STATES.has(tail) || COUNTRIES.has(tail)) {
      parts.unshift(tail.split(" ").map(capitalize).join(" "));
      words = words.slice(0, -size);
      break;
    }
  }
  const head = words.map((word) => (TITLE_WORDS[word] && word.length <= 3 ? TITLE_WORDS[word] : capitalize(word))).join(" ");
  return [head, ...parts].filter(Boolean).join(", ");
}
