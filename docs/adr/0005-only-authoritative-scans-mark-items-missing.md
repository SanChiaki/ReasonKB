# Only authoritative scans mark items missing

A failed, interrupted, unauthorized, or otherwise incomplete source scan marks the Corpus Source as degraded and does not change the presence of previously known collections or documents. Only a complete successful scan may mark an absent item as missing. Missing items leave retrieval immediately but retain their records and indexes so that reappearing items can recover without unnecessary re-indexing. Permanent cleanup remains a separate retention or purge decision.
