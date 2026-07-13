# Bound document size before fetching

ReasonKB applies a 100 MiB default maximum document size that administrators may override per Corpus Source up to a hard 1 GiB deployment limit. Documents over the effective limit remain Oversized Source Items with identity, path, type, and size metadata but are not fetched or indexed; raising the limit makes them eligible on a later Sync Run. Transfers stream to disk and enforce both the configured limit and expected metadata size so incorrect remote metadata cannot exhaust local resources.
