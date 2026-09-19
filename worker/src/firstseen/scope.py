"""Product scope for canonical roles: early-career technical programs only.

The classifier is deterministic and reads evidence in a fixed order: the role's own titles, then how
its applicant tracking system files it (department, team, function, experience level, employment
type), then seniority and employment markers. It never invents a discipline. Missing or conflicting
evidence makes a role `ambiguous`, a reviewable bucket, and only there may a model be consulted
(`LlmScopeClassifier`), and only to suggest a listed discipline it can quote verbatim. A person decides an
ambiguous role through `firstseen review-scope` (scope_review.py), and reclassification keeps that decision
while the role's titles and ATS filing are unchanged.

Out-of-scope roles stay as evidence. They are never surfaced and never forecast.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Protocol, get_args
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from .inference import DeterministicFirstInferencePolicy, ScopeInferenceDecision
from .models import AtsCategories
from .providers import CompletionClient, CompletionResult, ModelRoutingError
from .security import UNTRUSTED_EVIDENCE_SYSTEM_PROMPT

SCOPE_CLASSIFIER_VERSION = "early-career-technical-scope-v3"
# Evidence is stored with the role; the cap keeps a row inside its 16 KiB check with room to spare.
SCOPE_EVIDENCE_LIMIT = 24

Discipline = Literal[
    "software_engineering",
    "machine_learning",
    "infrastructure",
    "security",
    "hardware",
    "robotics",
    "data",
    "quantitative",
    "product_management",
    "design",
    # Widened 2026-09-16: every engineering discipline counts when the role is early-career.
    "mechanical_engineering",
    "aerospace_engineering",
    "manufacturing_engineering",
    "materials_engineering",
    "chemical_engineering",
    "civil_engineering",
    "biomedical_engineering",
]
# Technical apprenticeships are early-career (2026-09-16); a non-technical one falls out on discipline.
EarlyCareerType = Literal["internship", "co_op", "new_grad", "graduate_program", "rotational", "apprenticeship"]
ScopeStatus = Literal["in_scope", "out_of_scope", "ambiguous"]
ScopeReason = Literal[
    "in_scope",
    "not_early_career",
    "senior_role",
    "contract_or_temporary",
    "non_technical_function",
    "unlisted_technical_discipline",
    "discipline_unknown",
    "design_or_advocacy_boundary",
    "function_and_discipline_conflict",
    "seniority_conflict",
    "early_career_type_conflict",
    "alias_conflict",
    "not_a_role",
    "discipline_conflict",
]
EvidenceKind = Literal[
    "early_career",
    "discipline",
    "function",
    "seniority",
    "employment",
    "boundary",
    "unlisted_discipline",
    "navigation",
    "decision",
]
# `reviewer` is a person's stated decision (scope_review.py); every other tier is inferred from the evidence.
EvidenceTier = Literal["title", "ats_category", "model", "reviewer"]
ScopeMethod = Literal["deterministic", "model_assisted", "human_review"]

DISCIPLINES: tuple[Discipline, ...] = get_args(Discipline)
EARLY_CAREER_TYPES: tuple[EarlyCareerType, ...] = get_args(EarlyCareerType)
SCOPE_REASONS: tuple[ScopeReason, ...] = get_args(ScopeReason)

# Specific before general: an embedded software engineer is hardware, an ML infrastructure engineer
# is machine learning, and software engineering is what remains.
DISCIPLINE_PRECEDENCE: tuple[Discipline, ...] = (
    "security",
    "robotics",
    "aerospace_engineering",
    "biomedical_engineering",
    "mechanical_engineering",
    "hardware",
    "materials_engineering",
    "chemical_engineering",
    "civil_engineering",
    "manufacturing_engineering",
    "machine_learning",
    "quantitative",
    "data",
    "infrastructure",
    "design",
    "product_management",
    "software_engineering",
)
_TYPE_PRECEDENCE: tuple[EarlyCareerType, ...] = (
    "co_op", "internship", "apprenticeship", "rotational", "graduate_program", "new_grad"
)
_INTERNSHIP_FAMILY = frozenset({"co_op", "internship"})


class ScopeEvidence(BaseModel):
    tier: EvidenceTier
    kind: EvidenceKind
    rule: str = Field(min_length=1, max_length=80)
    matched: str = Field(min_length=1, max_length=300)
    field: str = Field(min_length=1, max_length=40)


class TitleEvidence(BaseModel):
    """One observed title with the ATS categories and employment types of the postings that carried it."""

    title: str
    categories: tuple[AtsCategories, ...] = ()
    employment_types: tuple[str, ...] = ()


class RoleScopeInput(BaseModel):
    """Everything the classifier may read: titles verbatim, then how the ATS filed the postings.

    `title_evidence` ties ATS evidence to the title it came with. Role-level `categories` and
    `employment_types` apply to every title only when no per-title evidence is given; pooled, an
    intern posting's "Intern" employment type once made a merged full-time alias look like an
    internship and hid the merge.
    """

    titles: tuple[str, ...] = Field(min_length=1)
    categories: tuple[AtsCategories, ...] = ()
    employment_types: tuple[str, ...] = ()
    title_evidence: tuple[TitleEvidence, ...] = ()
    description_excerpt: str = Field(default="", max_length=4_000)


class RoleScopeClassification(BaseModel):
    status: ScopeStatus
    reason: ScopeReason
    discipline: Discipline | None = None
    early_career_type: EarlyCareerType | None = None
    evidence: list[ScopeEvidence] = Field(default_factory=list)
    method: ScopeMethod = "deterministic"
    classifier_version: str = SCOPE_CLASSIFIER_VERSION

    @model_validator(mode="after")
    def in_scope_is_fully_evidenced(self) -> RoleScopeClassification:
        if (self.status == "in_scope") != (self.reason == "in_scope"):
            raise ValueError("the in_scope status and reason must agree")
        if self.status == "in_scope" and (self.discipline is None or self.early_career_type is None):
            raise ValueError("an in-scope role needs an evidenced discipline and early-career type")
        return self


def _fold(value: str) -> str:
    """Accent-free, lowercase tokens separated and padded by single spaces."""
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return " " + " ".join(re.findall(r"[a-z0-9+#]+", ascii_text.casefold())) + " "


def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


# People who run early-career programs are not in them: "Early Careers Interns Specialist",
# "University Recruiter", "Internship Program Manager".
_PROGRAM_STAFF = _rx(
    r"\b(?:interns?|internships?|early careers?|university|campus|students?|graduates?|new grads?)"
    r" (?:program(?:me)?s? )?(?:specialists?|coordinators?|recruit\w*|managers?|leads?|partners?|advisors?"
    r"|experience|relations|ambassadors?)\b"
)
_CONTRACT = _rx(r"\bcontract(?:or|ors)?\b|\btemporary\b|\btemp\b|\bfreelance\w*\b|\bfixed term\b|\bbefristet\w*\b")
_APPRENTICESHIP = _rx(r"\bapprentices?\b|\bapprenticeships?\b|\bausbildung\b|\bauszubildende[rn]?\b")
_CO_OP = _rx(r"\bco ?ops?\b|\bduales studium\b|\bdual study\b|\bwork study\b")
_INTERNSHIP = _rx(
    r"\binterns?\b|\binternships?\b|\bworking students?\b|\bwerkstudent(?:in)?\b|\bpraktik(?:um|ant|antin)\b"
    r"|\bpflichtpraktikum\b|\bpracticas\b|\bpracticum\b|\bestagi(?:o|ario|aria)\b|\bstagiaire\b|\btirocinio\b"
    r"|\bgyakornok\b|\bstagiair\b|\bthesis\b|\bindustrial placement\b|\bplacement year\b"
    r"|\bstudent (?:researcher|engineer|developer|scientist|worker|assistant|programmer)s?\b"
)
_ROTATIONAL = _rx(r"\brotation(?:al)?\b")
# "2026/2027 Grads" and "Dec 2026 Grads" name a graduating cohort.
_NEW_GRAD = _rx(r"\bnew grads?\b|\bnew graduates?\b|\b(?:university|college|recent) grad(?:uate)?s?\b|\b20\d\d grads\b")
# "Junior Software Engineer" is an early-career role by any reading (2026-09-16).
_JUNIOR = _rx(r"\bjunior\b|\bjr\b")
# An APM or rotational product manager title names the entry-level program itself.
_APM_PROGRAM = _rx(r"\bassociate product managers?\b|\bapms?\b|\brotational product managers?\b")
# "APM" is also a product: Datadog's Application Performance Monitoring. The abbreviation names the program only
# when the title has no other role noun, so "Manager I, Engineering - APM Serverless" is not an APM.
_APM_ABBREVIATION = _rx(r"\bapms?\b")
_OTHER_ROLE_NOUN = _rx(
    r"\b(?:engineer\w*|engineering|developer\w*|programmer\w*|scientist\w*|designer\w*|analysts?|architect\w*"
    r"|managers?|specialists?|consultants?|monitoring)\b"
)
_GRADUATE_PROGRAM = _rx(r"\bgraduate (?:program(?:me)?|scheme)s?\b|\bgrad program(?:me)?s?\b|\btrainee(?: program(?:me)?)?s?\b")
_BARE_GRADUATE = _rx(r"\bgraduates?\b(?! (?:students?|schools?|degrees?|levels?|studies|study)\b)")
_TYPE_RULES: tuple[tuple[EarlyCareerType, str, re.Pattern[str]], ...] = (
    ("co_op", "co_op", _CO_OP),
    ("internship", "internship", _INTERNSHIP),
    ("rotational", "rotational", _ROTATIONAL),
    ("new_grad", "new_grad", _NEW_GRAD),
    ("apprenticeship", "apprenticeship", _APPRENTICESHIP),
    ("new_grad", "associate_product_manager_program", _APM_PROGRAM),
    ("graduate_program", "graduate_program", _GRADUATE_PROGRAM),
    ("new_grad", "junior", _JUNIOR),
)
_GENERIC_EARLY_CAREER = _rx(r"\bearly careers?\b|\bentry level\b|\bcampus (?:hire|full time)\b")
# "Executive" is seniority on its own and a function inside "Account Executive" or "Executive Assistant".
_SENIORITY = _rx(
    r"\b(?:senior|sr|staff|principal|lead|leader|head of|director|vp|vice president|chief"
    r"|(?<!account )(?<!sales )executive(?! assistants?\b)|distinguished|expert|mid level|experienced)\b"
)
_PRODUCT_OR_PROGRAM_MANAGER = _rx(r"\b(?:\w+ )?(?:product|program) managers?\b")
_MANAGER = _rx(r"\bmanagers?\b")

# Careers-page labels captured as postings: "Internships & Early Careers", "Internship Tracker".
_NAVIGATION = _rx(
    r"^ (?:(?:internships?|interns|early|careers?|students|university|graduates|programs?|opportunities|tracker"
    r"|jobs|overview|and|at|our|for|the|join|us|explore|all|open|roles) )+$"
)
# Stories and page furniture linked from careers pages: "Nick's experience as a 2x trading intern".
# Careers-page stories and articles: Optiver's "CompSci major to Trading intern: Sean's internship experience" and
# "Chinmay's journey as a tech intern" are about an internship, not postings of one.
_CONTENT_LABEL = _rx(
    r"\b(?:experience as|day in the life|meet (?:our|the)|stor(?:y|ies)|blog|webinar|podcast|faq|what it s like"
    r"|life at|tips for|insights?|spotlights?|frequently asked questions"
    r"|intern(?:ship)? (?:experience|journey)|journey as|s guide to)\b"
)
_NAVIGATION_PLURAL = _rx(r"\b(?:internships|interns|careers|students|graduates|programs|opportunities|tracker|jobs|overview|roles)\b")

_TECH_NOUN = _rx(
    r"\b(?:engineer\w*|developer\w*|programmer\w*|scientist\w*|researcher\w*|research|technologist\w*"
    r"|technicians?|architect\w*|interns?|internships?|co ?ops?|apprentices?|apprenticeships?)\b"
)

# (discipline, rule, pattern). Strong rules name the role itself.
_STRONG: tuple[tuple[Discipline, str, re.Pattern[str]], ...] = (
    (
        "security",
        "security_engineering",
        _rx(
            r"\bcyber ?security\b|\binfosec\b|\bappsec\b|\bsecurity (?:engineer\w*|research\w*|software)\b"
            r"|\b(?:application|product|offensive|network|cloud|infrastructure|platform) security\b"
            r"|\bdetection (?:and )?response\b|\bpenetration test\w*\b|\bred team\w*\b"
            r"|\bthreat (?:intelligence|detection|research)\b|\bvulnerability research\w*\b"
        ),
    ),
    (
        "robotics",
        "robotics_controls_autonomy",
        _rx(
            r"\brobotic\w*\b|\bcontrols? (?:engineer\w*|systems?|software)\b|\bmotion planning\b"
            r"|\bperception (?:engineer\w*|software)\b|\bmechatronic\w*\b|\bgnc\b|\bguidance navigation\b"
            r"|\bautonomy (?:engineer\w*|software)\b|\bautonomous (?:systems?|vehicles?|driving)\b"
        ),
    ),
    (
        "hardware",
        "hardware_electrical_embedded",
        _rx(
            r"\bhardware\b|\belectrical (?:systems? )?(?:engineer\w*|integration)\b|\belectronics? engineer\w*\b"
            r"|\bembedded\b|\bfirmware\b|\bfpga\b|\basic\b|\bsilicon\b|\bchip design\b|\banalog\b|\bmixed signal\b"
            r"|\brf (?:engineer\w*|design)\b|\bpcb\b|\bcircuit design\b|\bic design\b|\bvlsi\b|\bdesign verification\b"
            r"|\bphysical design\b|\bdigital design\b|\bsignal integrity\b|\bpower electronics\b|\bsemiconductor\b"
            r"|\bavionics\b|\boptical engineer\w*\b|\bphotonics\b|(?<!software )(?<!automation )(?<!qa )(?<!ux )\btest engineer\w*\b"
            r"|\b(?:product|regulatory) compliance engineer\w*\b|\bemc engineer\w*\b"
        ),
    ),
    (
        "machine_learning",
        "machine_learning_ai",
        _rx(
            r"\bmachine learning\b|\bdeep learning\b|\bcomputer vision\b|\bnatural language processing\b|\bnlp\b"
            r"|\bllms?\b|\bgen ?ai\b|\bgenerative ai\b|\bapplied (?:scientist|science)\b|\bresearch scientist\w*\b"
            r"|\bresearch engineer\w*\b|\bartificial intelligence\b|\breinforcement learning\b"
            r"|\b(?:ai|ml)(?: (?:platform|infrastructure|research|systems?|product|applied|ops|software|safety))?"
            r" (?:engineer\w*|research\w*|scientist\w*|developer\w*)\b"
        ),
    ),
    (
        "quantitative",
        "quantitative",
        _rx(
            r"\bquants?\b|\bquantitative\b(?! (?:ux|user) )|\btraders?\b|\btrading (?:interns?|internships?|analysts?)\b"
            r"|\balgorithm(?:ic)? (?:development|trading)\b"
        ),
    ),
    ("data", "data_analyst", _rx(r"\bdata analysts?\b")),
    (
        "data",
        "data_engineering_science",
        _rx(r"\bdata (?:engineer\w*|scien\w*|analytics|platform engineer\w*|infrastructure)\b|\banalytics engineer\w*\b"),
    ),
    (
        "infrastructure",
        "infrastructure_platform_systems",
        _rx(
            r"\binfrastructure\b|\bplatform engineer\w*\b|\bsite reliability\b|\bsre\b|\bdevops\b"
            r"|\bsystems? engineer\w*\b|\bcloud (?:engineer\w*|infrastructure|platform)\b|\bnetwork engineer\w*\b"
            r"|\bproduction engineer\w*\b|\bbuild (?:and )?release\b|\bdistributed systems\b|\bkernel\b"
            r"|\bstorage (?:engineer\w*|systems)\b|\bdatabase engineer\w*\b|\bcompilers?\b"
        ),
    ),
    (
        "design",
        "product_ux_design",
        _rx(
            r"\bproduct design\w*\b|\bux\b|\bui designers?\b|\buser experience\b|\buser research\w*\b"
            r"|\binteraction design\w*\b|\bdesign engineer\w*\b|\bdesign technologist\w*\b"
        ),
    ),
    (
        "product_management",
        "product_management",
        _rx(
            r"\b(?:associate |rotational |technical )?product manag(?:er|ers|ement)\b|\bapms?\b"
            r"|\b(?:technical|engineering) program manag(?:er|ers|ement)\b|\btpms?\b"
        ),
    ),
    (
        "mechanical_engineering",
        "mechanical_engineering",
        _rx(
            r"\bmechanical (?:design )?(?:engineer\w*|design\w*|systems?|integration)\b|\bmechanical engineering\b"
            r"|\bthermal (?:engineer\w*|systems?)\b|\bhvac engineer\w*\b"
        ),
    ),
    (
        "aerospace_engineering",
        "aerospace_engineering",
        _rx(
            r"\baerospace\b|\baeronautic\w*\b|\bastronautic\w*\b|\bpropulsion\b|\bspacecraft\b"
            r"|\bflight (?:test|sciences?|dynamics|software)\b|\bstructures engineer\w*\b"
        ),
    ),
    (
        "manufacturing_engineering",
        "manufacturing_process",
        _rx(
            r"\bmanufacturing (?:engineer\w*|technolog\w*|process\w*|systems?|design)\b|\bprocess engineer\w*\b"
            r"|\bprocess development engineer\w*\b|\bindustrial engineer\w*\b|(?<!software )(?<!automation )(?<!qa )"
            r"\bquality engineer\w*\b|\bsupplier quality\b|\bwelding engineer\w*\b|\btooling engineer\w*\b"
            r"|\bmetrolog\w*\b|\bindustrial engineering\b|\bwirtschaftsingenieur\w*\b|\bengenharia (?:e gestao )?(?:de operacoes|industrial)\b"
        ),
    ),
    (
        "materials_engineering",
        "materials_engineering",
        _rx(
            r"\bmaterials? (?:engineer\w*|scien\w*|characterization)\b|\bmetallurg\w*\b"
            r"|\bpolymer (?:engineer\w*|scien\w*)\b|\bfailure analysis\b|\bcorrosion engineer\w*\b"
        ),
    ),
    (
        "chemical_engineering",
        "chemical_engineering",
        _rx(r"\bchemical (?:process )?engineer\w*\b|\bchemical engineering\b|\belectrochemi\w*\b|\bcell chemistry\b"),
    ),
    (
        "civil_engineering",
        "civil_engineering",
        _rx(
            r"\bcivil (?:engineer\w*|engineering)\b|\bstructural engineer\w*\b|\bgeotechnical\b"
            r"|\bconstruction engineer\w*\b|\benvironmental engineer\w*\b|\btransportation engineer\w*\b"
        ),
    ),
    (
        "biomedical_engineering",
        "biomedical_engineering",
        _rx(r"\bbiomedical\b|\bbio ?engineer\w*\b|\bbioengineering\b|\bmedical device engineer\w*\b"),
    ),
    (
        "software_engineering",
        "software_engineering",
        _rx(
            r"\bsoftware (?:(?:test|quality|qa|development|engineering|systems?|applications?|platform|embedded"
            r"|backend|frontend|infrastructure|reliability|security|tools|data|ml|ai|mobile|web|game) )?"
            r"(?:engineer\w*|develop(?:er|ers|ment))\b|\bswe\b|\bsde\b|\bsdet\b"
            r"|\b(?:back ?end|front ?end|full ?stack|mobile|ios|android|web|game(?:play)?|engine|tools|graphics"
            r"|client|server) (?:software )?(?:engineer\w*|developer\w*|programmer\w*)\b|\bprogrammer\w*\b"
            r"|\bdeveloper interns?\b|\bsoftware ?entwickl\w*\b|\b(?:automation|software|qa|manual) testers?\b"
            r"|\bsoftware testing\b|\btest automation\b|\bqa engineer\w*\b|\bdeveloppeur\w*\b|\blogiciels?\b"
        ),
    ),
)
# Rules whose titles meet marketing and business roles: next to a function word they abstain.
# Manufacturing meets supply-chain and operations titles the same way.
_BOUNDARY_RULES = frozenset({"product_management", "product_ux_design", "data_analyst", "manufacturing_process"})

# Topics count as discipline evidence only beside a technical noun in a title ("Security Intern"),
# and on their own in ATS categories ("Data Science", "Backend").
_TOPICS: tuple[tuple[Discipline, str, re.Pattern[str]], ...] = (
    ("security", "security_topic", _rx(r"\bsecurity\b")),
    ("robotics", "autonomy_topic", _rx(r"\bautonom\w*\b|\bcontrols\b|\bperception\b")),
    ("hardware", "electrical_topic", _rx(r"\belectrical\b|\belectronics?\b|\biot\b")),
    ("machine_learning", "ai_ml_topic", _rx(r"\bai\b|\bml\b")),
    ("quantitative", "trading_topic", _rx(r"\btrading\b")),
    ("data", "data_topic", _rx(r"\bdata\b|\banalytics\b")),
    ("mechanical_engineering", "mechanical_topic", _rx(r"\bmechanical\b")),
    ("manufacturing_engineering", "manufacturing_topic", _rx(r"\bmanufacturing\b")),
    ("materials_engineering", "materials_topic", _rx(r"\bmaterials\b")),
    ("chemical_engineering", "chemical_topic", _rx(r"\bchemical\b")),
    # "Privacy and Civil Liberties Engineer" is a software role, not civil engineering.
    ("civil_engineering", "civil_topic", _rx(r"\bcivil\b(?! liberties)|\bstructural\b")),
    ("infrastructure", "infrastructure_topic", _rx(r"\bplatforms?\b|\bcloud\b|\bsystems\b|\breliability\b")),
    (
        "software_engineering",
        "software_topic",
        _rx(r"\bsoftware\b|\bbackend\b|\bfrontend\b|\bfull ?stack\b|\bmobile\b|\bios\b|\bandroid\b|\bc\+\+|\bpython\b|\bjava\b|\bgolang\b|\brust\b"),
    ),
)

_FUNCTION = _rx(
    r"\bsales\b|\baccount (?:executive|manager|management|development|director)s?\b|\baccounts? (?:payable|receivable)\b"
    r"|\bbusiness development\b|\bbdrs?\b|\bsdrs?\b|\bgo to market\b|\bgtm\b|\bmarketing\b"
    r"|\bbrand (?:manager|marketing|strategy|partnerships?)\b|\bcommunications\b|\bpublic relations\b"
    r"|\brecruit\w*\b|\btalent (?:acquisition|partner|sourc\w*)\b|\bsourcers?\b"
    r"|\bpeople (?:partner|operations|ops|team|programs?)\b|\bhuman resources\b|\bhr\b|\bfinance\b|\bfinancial\b"
    r"|\baccounting\b|\baccountants?\b|\baudit\w*\b|\btax\b|\btreasury\b|\bpayroll\b|\bcredit\b|\brisk analyst\w*\b"
    r"|\bunderwrit\w*\b|\bactuar\w*\b|\binvestment\w*\b|\bventures?\b|\bdeals?\b|\blegal\b|\bcounsel\b|\bparalegal\b"
    r"|\bcompliance\b|\bregulatory\b|\boperations\b|\bops\b|\blogistics\b|\bsupply chain\b|\bprocurement\b"
    r"|\bpurchasing\b|\bcustomer (?:engineer\w*|success|support|experience|service|care|enablement|onboarding)\b"
    r"|\bsupport (?:engineer\w*|specialist|technician|agent|analyst)s?\b|\btechnical support\b|\bhelp ?desk\b"
    r"|\bit (?:support|specialist|technician|helpdesk)\b|\bsolutions? (?:engineer\w*|consultant|architect|specialist)s?\b"
    r"|\bsales engineer\w*\b|\bfield (?:engineer\w*|marketing|sales|application\w*)\b"
    r"|\bimplementation (?:consultant|engineer\w*|specialist|manager)s?\b|\bprofessional services\b|\bconsult\w*\b"
    r"|\bstrategy\b|\bstrategists?\b|\bbusiness analysts?\b|\bcoordinators?\b|\badministrat\w*\b|\bassistants?\b"
    r"|\breceptionist\b|\bfacilities\b|\bevents? (?:manager|coordinator|marketing|intern)\b"
    r"|\bcontent (?:writer|strategist|marketing|creator)s?\b|\bcopywrit\w*\b|\beditor\w*\b|\bsocial media\b"
    r"|\bcommunity (?:manager|management|support)\b|\bpartnerships?\b|\bpolicy\b|\beconomists?\b"
    r"|\bproduct (?:marketing|operations|specialist|support)\b|\bchief of staff\b|\bgrowth\b"
    r"|\btrust (?:and )?safety\b|\bwarehouse\b|\bdrivers?\b|\bfulfil+ment\b|\bcashier\b|\bbarista\b|\bchef\b|\bcook\b"
    r"|\bnurse\b|\bpharmac\w*\b|\bclinical\b|\bteachers?\b|\btutors?\b|\bjournalis\w*\b|\bwriters?\b"
    r"|\bexecutive assistant\b|\bdeployment strategist\w*\b|\bsustainability\b|\blearning (?:and )?development\b"
    r"|\bjunior managers? program\w*\b|\bmanagement trainee\w*\b|(?<!technical )(?<!engineering )\bprogram managers?\b"
    # Non-English function words from the corpus's European boards.
    r"|\beinkauf\w*\b|\bpersonal(?:management|entwicklung|wesen|abteilung|referent\w*)\b|\bcontrolling\b|\bvertrieb\w*\b"
    r"|\bbuchhaltung\b|\brechnungswesen\b|\blogistik\w*\b|\bjuridic\w*\b|\bjuristisch\w*\b|\bpolitik\w*\b"
    r"|\bregierung\w*\b|\bkommunikation\b|\badministracj\w*\b|\bsprzedaz\w*\b|\bventas\b|\bcompras\b|\bfinanzas\b"
    r"|\bcontabilidad\b|\boperacoes\b|\bgestao\b|\brecursos humanos\b|\bgebaudesicherheit\b|\bit (?:interns?|internships?)\b"
)
_BOUNDARY = _rx(
    r"\b(?:brand|graphic|visual|motion|marketing|communication|content|creative|packaging|game|level|technical"
    r"|industrial|fashion|interior|instructional|presentation) design\w*\b"
    r"|\b(?:developer|designer|design|technical) (?:advocate|evangelist|relations)s?\b|\bdevrel\b"
    r"|\bproduct analysts?\b|\bproduct owners?\b|\bbusiness intelligence\b"
)
# Technical work outside the listed disciplines. The engineering disciplines moved into the list on 2026-09-16; what is
# left is science and trade work without an engineering role noun.
_UNLISTED = _rx(
    r"\bwelding\b(?! engineer)|\btooling\b(?! engineer)|\bfacilities engineer\w*\b|\bconstruction\b(?! engineer)"
    r"|\bphysicists?\b|\bchemists?\b|\bbiologists?\b|\bnuclear\b"
)
_ATS_EARLY_CAREER = _rx(
    r"\b(?:university|campus|early careers?|students?|interns?|internships?|new grads?|graduates?|co ?ops?)\b"
)
_ATS_SENIOR_LEVELS = frozenset({"mid_senior_level", "director", "executive"})


@dataclass
class _Scan:
    types: dict[EarlyCareerType, ScopeEvidence] = field(default_factory=dict)
    generic_early_career: list[ScopeEvidence] = field(default_factory=list)
    contract: list[ScopeEvidence] = field(default_factory=list)
    seniority: list[ScopeEvidence] = field(default_factory=list)
    manager: list[ScopeEvidence] = field(default_factory=list)
    function: list[ScopeEvidence] = field(default_factory=list)
    boundary: list[ScopeEvidence] = field(default_factory=list)
    strong: dict[Discipline, ScopeEvidence] = field(default_factory=dict)
    topics: dict[Discipline, ScopeEvidence] = field(default_factory=dict)
    unlisted: list[ScopeEvidence] = field(default_factory=list)
    navigation: list[ScopeEvidence] = field(default_factory=list)
    tech_noun: bool = False

    def absorb(self, other: _Scan) -> None:
        for kind, evidence in other.types.items():
            self.types.setdefault(kind, evidence)
        for discipline, evidence in other.strong.items():
            self.strong.setdefault(discipline, evidence)
        for discipline, evidence in other.topics.items():
            self.topics.setdefault(discipline, evidence)
        self.generic_early_career += other.generic_early_career
        self.contract += other.contract
        self.seniority += other.seniority
        self.manager += other.manager
        self.function += other.function
        self.boundary += other.boundary
        self.unlisted += other.unlisted
        self.navigation += other.navigation
        self.tech_noun = self.tech_noun or other.tech_noun


def _evidence(
    tier: EvidenceTier, kind: EvidenceKind, rule: str, match: re.Match[str] | str, field_name: str
) -> ScopeEvidence:
    matched = match if isinstance(match, str) else match.group(0)
    return ScopeEvidence(tier=tier, kind=kind, rule=rule, matched=matched.strip()[:300], field=field_name)


def _remove(pattern: re.Pattern[str], text: str) -> str:
    return pattern.sub(" ", text)


def _scan_disciplines(scan: _Scan, text: str, tier: EvidenceTier, field_name: str) -> None:
    for discipline, rule, pattern in _STRONG:
        if discipline not in scan.strong and (match := pattern.search(text)):
            scan.strong[discipline] = _evidence(tier, "discipline", rule, match, field_name)
    for discipline, rule, pattern in _TOPICS:
        if discipline not in scan.topics and (match := pattern.search(text)):
            scan.topics[discipline] = _evidence(tier, "discipline", rule, match, field_name)
    for match in _FUNCTION.finditer(text):
        scan.function.append(_evidence(tier, "function", "non_technical_function", match, field_name))
    for match in _BOUNDARY.finditer(text):
        scan.boundary.append(_evidence(tier, "boundary", "design_or_advocacy_boundary", match, field_name))
    for match in _UNLISTED.finditer(text):
        scan.unlisted.append(_evidence(tier, "unlisted_discipline", "unlisted_technical_discipline", match, field_name))


def _scan_title(title: str) -> _Scan:
    scan = _Scan()
    text = _fold(title)
    if _NAVIGATION.match(text) and _NAVIGATION_PLURAL.search(text):
        scan.navigation.append(_evidence("title", "navigation", "navigation_label", text, "title"))
    if content := _CONTENT_LABEL.search(text):
        scan.navigation.append(_evidence("title", "navigation", "content_label", content, "title"))
    for match in _PROGRAM_STAFF.finditer(text):
        scan.function.append(_evidence("title", "function", "early_career_program_staff", match, "title"))
    rest = _remove(_PROGRAM_STAFF, text)
    if _OTHER_ROLE_NOUN.search(rest):
        rest = _remove(_APM_ABBREVIATION, rest)
    for match in _CONTRACT.finditer(rest):
        scan.contract.append(_evidence("title", "employment", "contract_or_temporary", match, "title"))
    for kind, rule, pattern in _TYPE_RULES:
        if kind not in scan.types and (found := pattern.search(rest)):
            scan.types[kind] = _evidence("title", "early_career", rule, found, "title")
    without_new_grad = _remove(_NEW_GRAD, rest)
    if "graduate_program" not in scan.types and (graduate := _BARE_GRADUATE.search(without_new_grad)):
        scan.types["graduate_program"] = _evidence("title", "early_career", "graduate", graduate, "title")
    for match in _GENERIC_EARLY_CAREER.finditer(rest):
        scan.generic_early_career.append(_evidence("title", "early_career", "generic_early_career", match, "title"))
    for match in _SENIORITY.finditer(rest):
        scan.seniority.append(_evidence("title", "seniority", "seniority", match, "title"))
    for match in _MANAGER.finditer(_remove(_PRODUCT_OR_PROGRAM_MANAGER, rest)):
        scan.manager.append(_evidence("title", "seniority", "manager", match, "title"))
    scan.tech_noun = bool(_TECH_NOUN.search(rest))
    _scan_disciplines(scan, rest, "title", "title")
    return scan


def title_early_career_types(title: str) -> frozenset[EarlyCareerType]:
    """Every early-career type a title states by itself, empty when it states none.

    The same reading the scope classifier uses, exposed so role identity can use it too. Before this,
    `role_resolution` had its own smaller vocabulary — no "Junior", no "20XX Grads" — and the two
    disagreed about what the same title said.
    """
    return frozenset(_scan_title(title).types)


def _scan_categories(categories: AtsCategories) -> _Scan:
    scan = _Scan()
    for field_name in ("department", "team", "function"):
        value = getattr(categories, field_name)
        if not value:
            continue
        text = _fold(value)
        if match := _ATS_EARLY_CAREER.search(text):
            word = match.group(0)
            kind: EarlyCareerType = (
                "co_op" if "co" in word.split() or "coop" in word else "internship" if "intern" in word else "new_grad"
            )
            if kind == "new_grad" and not re.search(r"new grad|graduate", word):
                scan.generic_early_career.append(_evidence("ats_category", "early_career", "generic_early_career", match, field_name))
            else:
                scan.types.setdefault(kind, _evidence("ats_category", "early_career", kind, match, field_name))
        _scan_disciplines(scan, text, "ats_category", field_name)
    level = (categories.experience_level or "").strip().casefold()
    if level == "internship":
        scan.types["internship"] = _evidence("ats_category", "early_career", "internship", level, "experience_level")
    elif level == "entry_level":
        scan.types["new_grad"] = _evidence("ats_category", "early_career", "entry_level", level, "experience_level")
    elif level in _ATS_SENIOR_LEVELS:
        scan.seniority.append(_evidence("ats_category", "seniority", "seniority", level, "experience_level"))
    return scan


def _scan_employment(employment_type: str) -> _Scan:
    scan = _Scan()
    text = _fold(employment_type)
    for match in _CONTRACT.finditer(text):
        scan.contract.append(_evidence("ats_category", "employment", "contract_or_temporary", match, "employment_type"))
    if co_op := _CO_OP.search(text):
        scan.types["co_op"] = _evidence("ats_category", "early_career", "co_op", co_op, "employment_type")
    # Word-bounded like the title rule: Shield AI's Lever employment type "International" once made every one of its
    # postings an internship.
    elif intern := _INTERNSHIP.search(text):
        scan.types["internship"] = _evidence("ats_category", "early_career", "internship", intern, "employment_type")
    return scan


def _unique(items: Iterable[ScopeEvidence]) -> list[ScopeEvidence]:
    seen: set[tuple[str, ...]] = set()
    result: list[ScopeEvidence] = []
    for item in items:
        key = (item.tier, item.kind, item.rule, item.matched, item.field)
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result[:SCOPE_EVIDENCE_LIMIT]


def classify_role_scope(role: RoleScopeInput) -> RoleScopeClassification:
    """Classify one canonical role; see the module docstring.

    Each observed title is classified on its own, with the role's ATS categories, and the titles must
    agree. A role whose aliases disagree, such as a resolver merge of an internship with full-time
    postings, is ambiguous rather than whichever title carries the stronger marker.
    """
    def ats_scan(categories: Iterable[AtsCategories], employment_types: Iterable[str]) -> _Scan:
        scan = _Scan()
        for item in categories:
            scan.absorb(_scan_categories(item))
        for employment_type in employment_types:
            if employment_type.strip():
                scan.absorb(_scan_employment(employment_type))
        return scan

    if role.title_evidence:
        pairs = [
            (item.title, ats_scan(item.categories, item.employment_types))
            for item in role.title_evidence
            if item.title.strip()
        ]
    else:
        shared = ats_scan(role.categories, role.employment_types)
        pairs = [(title, shared) for title in dict.fromkeys(role.titles) if title.strip()]
    results = [_decide(_scan_title(title), ats) for title, ats in pairs] or [
        _decide(_Scan(), ats_scan(role.categories, role.employment_types))
    ]
    evidence = _unique(item for result in results for item in result.evidence)
    first = results[0]

    def outcome(result: RoleScopeClassification) -> tuple[object, ...]:
        return (result.status, result.reason, result.discipline, result.early_career_type)

    if all(result.status == "out_of_scope" for result in results) or all(
        outcome(result) == outcome(first) for result in results
    ):
        return first.model_copy(update={"evidence": evidence})
    return RoleScopeClassification(status="ambiguous", reason="alias_conflict", evidence=evidence)


def _decide(title: _Scan, ats: _Scan) -> RoleScopeClassification:
    def decide(
        status: ScopeStatus,
        reason: ScopeReason,
        evidence: Iterable[ScopeEvidence],
        *,
        discipline: Discipline | None = None,
        early_career_type: EarlyCareerType | None = None,
    ) -> RoleScopeClassification:
        return RoleScopeClassification(
            status=status,
            reason=reason,
            discipline=discipline,
            early_career_type=early_career_type,
            evidence=_unique(evidence),
        )

    if title.navigation:
        return decide("out_of_scope", "not_a_role", title.navigation)
    if title.contract or ats.contract:
        return decide("out_of_scope", "contract_or_temporary", title.contract + ats.contract)

    # Early-career type: titles first; ATS categories only when the titles state none.
    source = title if title.types or title.generic_early_career else ats
    types = dict(source.types)
    if _INTERNSHIP_FAMILY & set(types) and types.get("graduate_program") and types["graduate_program"].rule == "graduate":
        del types["graduate_program"]  # "Graduate Intern": the graduate is the intern
    if _INTERNSHIP_FAMILY & set(types) and types.get("new_grad") and types["new_grad"].rule in {"associate_product_manager_program", "junior"}:
        del types["new_grad"]  # "Associate Product Manager Intern", "Junior Developer Intern": the intern marker says which
    internship_family = [types[kind] for kind in ("co_op", "internship") if kind in types]
    full_time_family = [types[kind] for kind in ("graduate_program", "new_grad") if kind in types]
    if internship_family and full_time_family:
        return decide("ambiguous", "early_career_type_conflict", internship_family + full_time_family)
    early_career_type = next((kind for kind in _TYPE_PRECEDENCE if kind in types), None)
    type_evidence = list(types.values())
    if early_career_type is None and source.generic_early_career:
        early_career_type = "new_grad"
        type_evidence = source.generic_early_career[:1]
    if early_career_type is None:
        seniority = title.seniority + title.manager + ats.seniority
        if seniority:
            return decide("out_of_scope", "senior_role", seniority)
        return decide("out_of_scope", "not_early_career", [])
    if early_career_type == "internship" and "rotational" in types:
        type_evidence = [types["internship"], types["rotational"]]
    seniority = title.seniority + ats.seniority
    if seniority:
        return decide("ambiguous", "seniority_conflict", type_evidence + seniority, early_career_type=early_career_type)

    # Discipline: title evidence first, then ATS categories.
    strong = title.strong
    if title.function and not strong:
        return decide(
            "out_of_scope", "non_technical_function", type_evidence + title.function, early_career_type=early_career_type
        )
    if title.function and all(item.rule in _BOUNDARY_RULES for item in strong.values()):
        return decide(
            "ambiguous",
            "function_and_discipline_conflict",
            type_evidence + list(strong.values()) + title.function,
            early_career_type=early_career_type,
        )
    if not strong and title.boundary:
        return decide(
            "ambiguous", "design_or_advocacy_boundary", type_evidence + title.boundary, early_career_type=early_career_type
        )
    if strong and title.unlisted:
        # "Manufacturing Intern, Surgery & Robot Hardware", "Product Design Mechanical Engineer": a listed
        # discipline word beside an unlisted role noun is not evidence of which one the role is.
        return decide(
            "ambiguous",
            "discipline_conflict",
            type_evidence + list(strong.values()) + title.unlisted,
            early_career_type=early_career_type,
        )
    listed = dict(strong) or (dict(title.topics) if title.tech_noun else {})
    if not listed:
        if title.unlisted:
            return decide(
                "out_of_scope",
                "unlisted_technical_discipline",
                type_evidence + title.unlisted,
                early_career_type=early_career_type,
            )
        listed = {**ats.topics, **ats.strong}
        if not listed:
            if ats.function:
                return decide(
                    "out_of_scope",
                    "non_technical_function",
                    type_evidence + ats.function,
                    early_career_type=early_career_type,
                )
            return decide("ambiguous", "discipline_unknown", type_evidence, early_career_type=early_career_type)
    discipline = next(item for item in DISCIPLINE_PRECEDENCE if item in listed)
    ordered = [listed[discipline]] + [listed[item] for item in DISCIPLINE_PRECEDENCE if item in listed and item != discipline]
    return decide("in_scope", "in_scope", type_evidence + ordered, discipline=discipline, early_career_type=early_career_type)


class _ScopeProposal(BaseModel):
    discipline: Discipline | Literal["abstain"]
    quote: str = Field(default="", max_length=300)


class LlmScopeClassifier:
    """Suggest a listed discipline for a role the rules left `discipline_unknown`, for a reviewer to accept or reject.

    A suggestion is kept only when its quote appears verbatim in the evidence the model was shown, and it never decides
    scope: the role stays ambiguous, with the suggestion recorded as model-tier evidence. On 2026-09-16 the local model's
    31 in-scope decisions were checked by hand and 15 were wrong ("Business Controller Intern" as product management,
    "Payment Risk Intern" as security), their quotes being degree requirements and company boilerplate that were
    verbatim but said nothing about the role. `firstseen review-scope` shows the suggestion; a person decides.
    """

    def __init__(self, client: CompletionClient) -> None:
        self.client = client
        self.last_completion: CompletionResult | None = None

    def resolve(self, role: RoleScopeInput, classification: RoleScopeClassification) -> RoleScopeClassification | None:
        if classification.reason != "discipline_unknown" or classification.early_career_type is None:
            return None
        evidence = {
            "titles": list(role.titles),
            "ats_categories": [item.model_dump(exclude_none=True) for item in role.categories],
            "description_excerpt": role.description_excerpt[:2_000],
        }
        result = self.client.complete(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Choose the one discipline this early-career posting belongs to, from allowed_disciplines, "
                        "or abstain. Return JSON: discipline (an allowed value or \"abstain\") and quote, a short "
                        "exact excerpt from the evidence that shows the discipline. Abstain unless the evidence "
                        f"states it. {UNTRUSTED_EVIDENCE_SYSTEM_PROMPT}"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({"evidence": evidence, "allowed_disciplines": list(DISCIPLINES)}),
                },
            ],
            response_model=_ScopeProposal,
        )
        self.last_completion = result
        try:
            proposal = _ScopeProposal.model_validate_json(result.content)
        except ValueError:
            return None
        quote = " ".join(proposal.quote.split())
        if proposal.discipline == "abstain" or len(quote) < 3:
            return None
        haystacks = [*role.titles, role.description_excerpt]
        haystacks += [value for item in role.categories for value in item.model_dump(exclude_none=True).values()]
        if not any(quote.casefold() in " ".join(str(value).split()).casefold() for value in haystacks):
            return None
        return classification.model_copy(
            update={
                "evidence": [
                    *classification.evidence,
                    ScopeEvidence(tier="model", kind="discipline", rule=proposal.discipline, matched=quote, field="model_quote"),
                ],
                "method": "model_assisted",
            }
        )


class RoleScopeClassifier:
    """The deterministic classifier, consulting a model only when the inference policy allows it."""

    def __init__(
        self,
        llm: LlmScopeClassifier | None = None,
        inference_policy: DeterministicFirstInferencePolicy | None = None,
    ) -> None:
        self.llm = llm
        self.inference_policy = inference_policy or DeterministicFirstInferencePolicy()

    def classify(self, role: RoleScopeInput) -> tuple[RoleScopeClassification, ScopeInferenceDecision]:
        deterministic = classify_role_scope(role)
        decision = self.inference_policy.decide_scope_classification(
            status=deterministic.status, reason=deterministic.reason, llm_enabled=self.llm is not None
        )
        if decision.action != "escalated" or self.llm is None:
            return deterministic, decision
        try:
            proposed = self.llm.resolve(role, deterministic)
        except ModelRoutingError:
            return deterministic, decision
        return proposed or deterministic, decision


def scope_input_fingerprint(role: RoleScopeInput) -> str:
    """A hash of everything the classifier reads, independent of alias order: what a person's decision was made on."""
    if role.title_evidence:
        items = [
            (
                item.title,
                sorted(json.dumps(category.model_dump(exclude_none=True), sort_keys=True) for category in item.categories),
                sorted(item.employment_types),
            )
            for item in role.title_evidence
        ]
    else:
        shared = (
            sorted(json.dumps(category.model_dump(exclude_none=True), sort_keys=True) for category in role.categories),
            sorted(role.employment_types),
        )
        items = [(title, *shared) for title in dict.fromkeys(role.titles)]
    canonical = json.dumps(sorted(items), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


class StoredRoleScope(BaseModel):
    """A canonical role's classification input and whatever classification is already stored.

    `reviewed_fingerprint` is the input fingerprint of the latest person's decision on the role, when there is one.
    """

    role_id: UUID
    role: RoleScopeInput
    current: RoleScopeClassification | None = None
    classified_at: datetime | None = None
    reviewed_fingerprint: str | None = None


class RoleScopeStore(Protocol):
    def list_role_scope_inputs(self, company_id: UUID | None = None) -> list[StoredRoleScope]: ...

    def role_description_excerpt(self, role_id: UUID) -> str: ...

    def save_role_scope(self, role_id: UUID, classification: RoleScopeClassification) -> None: ...


@dataclass
class RoleScopeSummary:
    roles: int = 0
    written: int = 0
    unchanged: int = 0
    failures: int = 0
    model_escalations: int = 0
    model_assisted: int = 0
    human_reviewed: int = 0
    by_status: Counter[str] = field(default_factory=Counter)
    by_reason: Counter[str] = field(default_factory=Counter)
    in_scope_by_discipline: Counter[str] = field(default_factory=Counter)
    in_scope_by_type: Counter[str] = field(default_factory=Counter)

    def record(self, classification: RoleScopeClassification) -> None:
        self.by_status[classification.status] += 1
        self.by_reason[classification.reason] += 1
        if classification.status == "in_scope":
            self.in_scope_by_discipline[str(classification.discipline)] += 1
            self.in_scope_by_type[str(classification.early_career_type)] += 1

    def absorb(self, other: RoleScopeSummary) -> None:
        self.roles += other.roles
        self.written += other.written
        self.unchanged += other.unchanged
        self.failures += other.failures
        self.model_escalations += other.model_escalations
        self.model_assisted += other.model_assisted
        self.human_reviewed += other.human_reviewed
        self.by_status.update(other.by_status)
        self.by_reason.update(other.by_reason)
        self.in_scope_by_discipline.update(other.in_scope_by_discipline)
        self.in_scope_by_type.update(other.in_scope_by_type)

    def as_dict(self) -> dict[str, object]:
        return {
            "roles": self.roles,
            "written": self.written,
            "unchanged": self.unchanged,
            "failures": self.failures,
            "model_escalations": self.model_escalations,
            "model_assisted": self.model_assisted,
            "human_reviewed": self.human_reviewed,
            "by_status": dict(sorted(self.by_status.items())),
            "by_reason": dict(sorted(self.by_reason.items())),
            "in_scope_by_discipline": dict(sorted(self.in_scope_by_discipline.items())),
            "in_scope_by_early_career_type": dict(sorted(self.in_scope_by_type.items())),
        }


class RoleScopeService:
    """Classify stored canonical roles and write only classifications that changed."""

    def __init__(self, store: RoleScopeStore, classifier: RoleScopeClassifier | None = None) -> None:
        self.store = store
        self.classifier = classifier or RoleScopeClassifier()

    def classify(self, company_id: UUID | None = None) -> RoleScopeSummary:
        summary = RoleScopeSummary()
        # A store that saves many decisions at once (the Supabase repository: save_role_scopes) gets them together
        # after the loop; any other store saves each as it is decided.
        save_many = getattr(self.store, "save_role_scopes", None)
        changed: list[tuple[UUID, RoleScopeClassification]] = []
        for stored in self.store.list_role_scope_inputs(company_id):
            summary.roles += 1
            try:
                result = self._classify(stored, summary)
                if stored.current is not None and stored.current.model_dump() == result.model_dump():
                    summary.unchanged += 1
                elif save_many is not None:
                    changed.append((stored.role_id, result))
                    continue
                else:
                    self.store.save_role_scope(stored.role_id, result)
                    summary.written += 1
            except Exception:  # noqa: BLE001 - roles classify independently; the count is reported
                summary.failures += 1
                continue
            summary.record(result)
        if changed and save_many is not None:
            self._save_all(changed, save_many, summary)
        return summary

    def _save_all(
        self,
        changed: list[tuple[UUID, RoleScopeClassification]],
        save_many: Callable[[list[tuple[UUID, RoleScopeClassification]]], object],
        summary: RoleScopeSummary,
    ) -> None:
        """Save the changed decisions together; if the store refuses, save them one at a time, each failing alone."""
        try:
            save_many(changed)
            saved = changed
        except Exception:  # noqa: BLE001 - retried role by role below
            saved = []
            for role_id, result in changed:
                try:
                    self.store.save_role_scope(role_id, result)
                except Exception:  # noqa: BLE001 - roles classify independently; the count is reported
                    summary.failures += 1
                    continue
                saved.append((role_id, result))
        for _, result in saved:
            summary.written += 1
            summary.record(result)

    def _classify(self, stored: StoredRoleScope, summary: RoleScopeSummary) -> RoleScopeClassification:
        current = stored.current
        if (
            current is not None
            and current.method == "human_review"
            and stored.reviewed_fingerprint == scope_input_fingerprint(stored.role)
        ):
            # A person decided on exactly this evidence. Once a title or ATS filing changes, the rules speak again,
            # and a role they still find ambiguous returns to the review queue with the earlier decision shown.
            summary.human_reviewed += 1
            return current
        deterministic = classify_role_scope(stored.role)
        if (
            current is not None
            and current.method == "model_assisted"
            # A stored suggestion is kept; a model decision written before suggestions stopped deciding is replaced.
            and current.status == "ambiguous"
            and current.classifier_version == deterministic.classifier_version
            and deterministic.reason == "discipline_unknown"
            and [item for item in current.evidence if item.tier != "model"] == deterministic.evidence
        ):
            # A verified model answer for unchanged evidence is kept, not asked for again.
            return current
        if self.classifier.llm is None or deterministic.reason != "discipline_unknown":
            return deterministic
        role = stored.role.model_copy(
            update={"description_excerpt": self.store.role_description_excerpt(stored.role_id)[:4_000]}
        )
        result, decision = self.classifier.classify(role)
        if decision.llm_escalated:
            summary.model_escalations += 1
        if result.method == "model_assisted":
            summary.model_assisted += 1
        return result
