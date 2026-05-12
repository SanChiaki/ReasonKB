# PageIndex Patch Boundary

`vendor/pageindex` is kept as an unmodified snapshot of `VectifyAI/PageIndex`.

ReasonKB-specific behavior is applied outside the vendored tree:

- `services/common/pageindex_vendor.py` adds `vendor/pageindex` to the Python import path.
- `services/common/llm_environment.py` maps deployment-facing `PAGEINDEX_LLM_*` variables to the LiteLLM/OpenAI-compatible variables expected by upstream PageIndex.
- `services/common/pageindex_runtime.py` patches runtime behavior for ReasonKB defaults, LLM/token metrics, and table-of-contents fallback handling.
- `services/common/pageindex_config.yaml` stores ReasonKB's default PageIndex model settings.

If a future upstream change requires editing PageIndex source directly, put the patch artifact or a short audit note in this directory instead of modifying `vendor/pageindex` silently.

