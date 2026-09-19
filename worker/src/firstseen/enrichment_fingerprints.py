"""Skip a company whose enrichment inputs are exactly those of its last pass that changed nothing.

Every collection run enriches every company it collected, and enrichment re-reads the company's observations, matches,
roles, aliases, opening events, and archive captures (about 45 MB of Supabase egress per run over the corpus) although
most companies have nothing new. Enrichment has no dependence on the clock: given the same stored evidence, the same
worker code, and the same model configuration, it makes the same decisions. So a pass that left a company's inputs
exactly as it found them would change nothing if it ran again on those inputs.

The database computes a fingerprint of everything enrichment reads for a company (company_enrichment_fingerprints,
migration 202608140046). After a complete pass, the fingerprint is taken again; if it did not move, the pass changed
nothing, and its key (the fingerprint with the worker's own) is kept in collection_checkpoints (pipeline
`enrichment_fingerprints`). A later
run skips a company whose key still matches. Anything that changes the inputs (a new posting, a changed one, a new
archive capture, a re-resolution, a scope review), the worker's code, or its model configuration changes the key, and
the company is enriched again.
"""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path

from .config import Settings

# The skip is recorded in each company's tool call so an audit shows why nothing was derived.
UNCHANGED_RESULT = "skipped_inputs_unchanged_since_a_pass_that_changed_nothing"


def worker_fingerprint(settings: Settings) -> str:
    """The worker's own source and its model configuration, so either changing makes every company enrich once.

    The model configuration is which routes classification uses and which providers are configured, never a key.
    """
    digest = sha256()
    root = Path(__file__).resolve().parent
    for path in sorted(root.rglob("*.py")):
        digest.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    models = {
        "classify_routes": list(settings.routes_for("classify")),
        "gemini_configured": bool(settings.gemini_api_key),
        "groq_configured": bool(settings.groq_api_key),
        "llm_api_key_configured": bool(settings.llm_api_key),
        "llm_api_base": str(settings.llm_api_base or ""),
        "ollama_api_base": str(settings.ollama_api_base or ""),
    }
    digest.update(json.dumps(models, sort_keys=True).encode())
    return digest.hexdigest()


def skip_key(inputs: str, worker: str) -> str:
    """What a company's recorded no-op pass is compared by: its inputs' fingerprint and the worker's."""
    return sha256(f"{inputs}|{worker}".encode()).hexdigest()
