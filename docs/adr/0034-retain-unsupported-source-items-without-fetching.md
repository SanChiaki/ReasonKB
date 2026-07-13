# Retain unsupported source items without fetching

Connectors persist identity and metadata for regular source documents whose formats ReasonKB does not currently index, marking them unsupported without downloading remote content or creating PageIndex jobs. Project Retrieval Coverage exposes unsupported counts and administrator-visible reasons. A later release that supports the format can transition the same Source Item into indexing on its next Sync Run. Hidden files, temporary artifacts, links, and explicitly ignored names remain scan-level skips rather than unsupported documents.
