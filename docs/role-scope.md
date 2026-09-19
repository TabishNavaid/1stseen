# Product scope: early-career technical roles

1stSeen forecasts early-career technical programs only. Every canonical role carries a scope
classification, and only `in_scope` roles are forecast or surfaced: the dashboard and its counts,
role pages, watchlists and follows, the calendar, digests, Forecast Replay, backtest targets, signal
recomputation, and the RecruitingAgent. Out-of-scope roles are never deleted and collection never
stops for them. An archived careers page that lists a marketing role is still evidence about that page,
and their opening events still inform company and role-family seasonal priors.

## What is in scope

**Early-career type**, which must be evidenced:

| Type | Evidence |
| --- | --- |
| `internship` | intern, internship, working student / Werkstudent, Praktikum, prácticas, estágio, thesis, industrial placement, student researcher |
| `co_op` | co-op, duales Studium, work study |
| `new_grad` | new grad, new graduate, university / college / recent graduate, early career, entry level, campus hire, junior; an associate or rotational product manager title, or "APM" when the title has no other role noun ("APM" is also Datadog's Application Performance Monitoring) |
| `graduate_program` | graduate program or scheme, trainee program, a title beginning "Graduate" ("Graduate Trader") |
| `rotational` | rotation, rotational (an intern in a rotation program stays an internship) |
| `apprenticeship` | apprentice, apprenticeship, Ausbildung; a technical one is in scope, and a non-technical one falls out on discipline |

**Discipline**, which must be evidenced, from one of seventeen:

| Discipline | Includes |
| --- | --- |
| `software_engineering` | backend, frontend, full stack, mobile, general SWE, programmers, software testing |
| `machine_learning` | ML engineering, AI research, applied science, research scientists and engineers |
| `infrastructure` | platform, systems, SRE, DevOps, build and release, distributed systems |
| `security` | security engineering and research |
| `hardware` | hardware, electrical, embedded, firmware, FPGA, ASIC, IC design |
| `robotics` | robotics, controls, autonomy, perception, motion planning |
| `data` | data engineering, data science, data analysts |
| `quantitative` | quantitative developers, researchers, traders; algorithm development |
| `product_management` | PM, APM, rotational PM, technical and engineering program managers |
| `design` | product design, UX design and research, design engineering |
| `mechanical_engineering` | mechanical engineering and design, thermal systems, HVAC engineering |
| `aerospace_engineering` | aerospace, aeronautics, propulsion, spacecraft, flight test and flight software |
| `manufacturing_engineering` | manufacturing, process, industrial, and non-software quality engineering; metrology |
| `materials_engineering` | materials engineering and science, metallurgy, polymers, failure analysis |
| `chemical_engineering` | chemical engineering, electrochemistry, cell chemistry |
| `civil_engineering` | civil, structural, geotechnical, construction, environmental, and transportation engineering |
| `biomedical_engineering` | biomedical engineering, bioengineering, medical device engineering |

Hardware also covers optical engineering, photonics, and non-software test engineering. A technician counts as technical
work when an engineering discipline names it ("Apprentice Controls Technician").

Out of scope: sales, business development, marketing, recruiting, finance, legal, operations, support,
customer success, and every other non-technical function; anything senior, staff, principal, lead,
manager, director, or head of; contract and temporary roles; non-technical apprenticeships; and technical work
outside the list above, which is now science and trade work without an engineering role noun (physicists, chemists,
biologists, welding, tooling, construction, nuclear), reported under its own reason so the list can be widened
deliberately. The engineering disciplines and technical apprenticeships were widened into scope on 2026-09-16.

## How a role is classified

`worker/src/firstseen/scope.py` is deterministic and reads evidence in a fixed order:

1. **Titles.** Each observed alias is classified on its own, and the aliases must agree. The canonical
   title is used only for a role with no alias, because normalization strips cohort words such as
   "early career".
2. **ATS categories.** Department and team (Greenhouse, Lever, Ashby, SmartRecruiters), SmartRecruiters'
   function and experience level, and the employment type. They speak only where the titles are silent:
   an internship title in a Sales department is still an internship, but a bare "Intern" in Sales is a
   sales role. Each title is classified with the ATS evidence of the postings that carried it, never with
   evidence pooled across a role's aliases.
3. **Seniority and employment markers.** A contract or temporary marker anywhere excludes the role. A
   senior marker excludes a role without early-career evidence and makes a role with it ambiguous
   ("Senior Machine Learning Engineer … PhD Early Career").

An employment type's words are matched whole, as a title's are: Shield AI's Lever employment type "International"
once made every one of its postings an internship.

Within a title, people who run a program are not in it ("Early Careers Interns Specialist", "University
Recruiter"), careers-page labels, stories, spotlights, and FAQs are not roles ("Internships & Early Careers",
"Intern Spotlight: HRT AI Labs Summer Projects"), and a function word
excludes a role unless an engineering role noun outweighs it ("Software Engineer Intern, Stripe Tax"). When
several listed disciplines match, the more specific one wins: security, robotics, aerospace, biomedical,
mechanical, hardware, materials, chemical, civil, manufacturing, machine learning, quantitative, data,
infrastructure, design, product management, then software engineering.

## Reasons

| Status | Reason | Meaning |
| --- | --- | --- |
| `in_scope` | `in_scope` | Early-career type and discipline both evidenced |
| `out_of_scope` | `not_early_career` | No early-career evidence |
| `out_of_scope` | `senior_role` | A seniority marker and no early-career evidence |
| `out_of_scope` | `contract_or_temporary` | A contract or temporary marker in a title or employment type |
| `out_of_scope` | `non_technical_function` | A non-technical function with no technical role noun |
| `out_of_scope` | `unlisted_technical_discipline` | Technical, but not a listed discipline |
| `out_of_scope` | `not_a_role` | A careers-page label or story captured as a posting ("Nick's experience as a 2x trading intern") |
| `ambiguous` | `discipline_unknown` | Early-career, but nothing names the discipline ("Research Intern") |
| `ambiguous` | `design_or_advocacy_boundary` | Brand, graphic, game, or technical design; developer or designer advocacy |
| `ambiguous` | `function_and_discipline_conflict` | A product, design, data-analyst, or manufacturing title beside a function word ("Product Manager Intern, Marketing Platform", "Manufacturing Process Intern, Supply Chain") |
| `ambiguous` | `seniority_conflict` | Early-career evidence and a seniority marker |
| `ambiguous` | `early_career_type_conflict` | An internship and a full-time program in one title |
| `ambiguous` | `alias_conflict` | The role's aliases classify differently, usually a resolver merge |
| `ambiguous` | `discipline_conflict` | A listed discipline word beside an unlisted role noun ("Welding Intern, Robot Hardware") |

Ambiguous roles are the review queue (`canonical_roles_scope_review_idx`). They are not surfaced until a person decides
them (see [Reviewing ambiguous roles](#reviewing-ambiguous-roles)).

## Evidence and storage

`canonical_roles` stores `scope_status`, `scope_reason`, `discipline`, `early_career_type`, the rules
that fired (`scope_evidence`: tier, kind, rule, matched text, field), `scope_method`, the classifier
version, and when it ran. A check constraint refuses an in-scope role without both a discipline and an
early-career type. A null status means unclassified and is treated as out of scope.

`scope_method` says who decided: `deterministic` (the rules), `model_assisted` (the rules, with a model suggestion kept
beside an ambiguous outcome), or `human_review` (a person). Evidence tiers follow the same split: `title` and
`ats_category` are inferred by rules, `model` is a suggestion, and `reviewer` is a person's stated decision.

## The model

A model may be consulted only for `discipline_unknown`, gated by
`DeterministicFirstInferencePolicy.decide_scope_classification`. Conflicts and boundaries are a
reviewer's call, never a tiebreak. The model chooses one listed discipline or abstains, and its answer
is kept only when it quotes the evidence it was shown verbatim; the early-career type is never its to
decide. **A model answer is a suggestion, never a decision.** The role stays ambiguous, with the suggestion stored as
model-tier evidence (`scope_method = model_assisted`), and it is not requested again while the evidence is unchanged.
On 2026-09-16 the local model's 31 in-scope decisions were checked by hand: 15 were wrong, because a verbatim quote of a
degree requirement or company boilerplate says nothing about the role. A person decides through `firstseen review-scope`.

## Reviewing ambiguous roles

A person decides the roles the rules abstain on, from the command line (migration 202608140033):

```bash
.venv/bin/firstseen review-scope list [--reason discipline_unknown] [--company "Bosch"] [--limit 20]
```

Each role is printed with the evidence that made it ambiguous:

- each title as the rules classify it alone, with the ATS department, team, and employment type it was filed under;
- any model suggestion, labeled as one;
- an earlier decision, when the role's titles have changed since;
- up to three recent postings with an excerpt.

Merges come first, then unknown disciplines. Scraped text is printed with control and formatting characters removed, so
a posting cannot write terminal escape sequences.

```bash
FIRSTSEEN_REVIEWER="Tabish" .venv/bin/firstseen review-scope decide <role id> \
  --in-scope --discipline mechanical_engineering --type internship \
  --basis titles --note "Heat pump R&D is mechanical engineering."

.venv/bin/firstseen review-scope decide <role id> --out-of-scope non_technical_function \
  --basis posting --note "The posting is sales operations." --reviewer "Tabish"
```

What a decision writes:

- **Provenance.** A `role_scope_reviews` row records the outcome, who decided, when, the basis, the note, a fingerprint
  of the titles and ATS filing decided on, and exactly what was shown. The table is service-only.
- **The outcome.** `canonical_roles` gets `scope_method = human_review`, and its evidence starts with a `reviewer`-tier
  statement: the review id, the basis, and the note. The role row and the review are written in one transaction
  (`record_role_scope_review`), and only if the role is unchanged since it was listed and is still ambiguous or already
  decided by a person. A role the rules decide cannot be overridden one role at a time.
- **Persistence.** `classify-roles` and enrichment keep the decision while the fingerprint matches. When a title or
  filing changes, the rules classify again. If the role is still ambiguous, it returns to the queue with the earlier
  decision shown.
- **The labeled case.** The decision is added to `worker/tests/fixtures/role_resolution_cases.json`, replacing an
  earlier review of the same role, so the classifier improves rather than asking again:
  - `--basis titles` means the titles and filing decide it, so the case expects the decision.
    `test_every_labeled_case` fails, naming the review, until a rule reaches it. The next role with those titles is
    then decided without review.
  - `--basis posting` means the posting itself was needed ("Summer Intern" whose description is backend work). The case
    expects the rules' abstention, which guards against a rule that starts guessing from titles that cannot decide.
  - A merge (`alias_conflict`) can be decided only from the posting. No rule should decide a merge from its titles; say
    in the note which title the role really is.
- **Program type.** An out-of-scope decision keeps the early-career type the rules found unless `--type` says
  otherwise. It decides scope, not the program.

The decision needs a checkout, since it writes the labeled cases. `--fixtures` points elsewhere. A decision is refused,
and nothing is written, when the file cannot be read.

## Running it

Enrichment classifies every role of each company it processes. For a corpus enriched before migration
0026, or after a classifier version change:

```bash
.venv/bin/firstseen classify-roles --all
```

It writes only classifications that changed and prints counts by status, reason, discipline, and type.
`npm run verify:supabase` fails while any role is unclassified.

## Tests

`worker/tests/fixtures/role_resolution_cases.json` holds the labeled cases under `"scope"`, including the
adversarial pairs (Product Marketing Manager against Product Manager, Brand Designer against Product
Designer), the Director of Field Marketing whose title repeats the company name, Cohere's four location
splits, and Figma's two winter internships that differ only by specialization. The splits must survive
classification as separate roles. `worker/tests/test_role_scope.py` runs them;
`apps/web/tests/integration/scope-read-paths.test.mjs` proves every product read path excludes
out-of-scope, ambiguous, and unclassified roles.
