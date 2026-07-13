# Revalidate and resync after source reactivation

Disabling a Corpus Source stops discovery, synchronization, fetching, and token renewal and immediately deactivates every associated Project while retaining selection policy, metadata, indexes, and history. Re-enabling first validates the connection and then runs each selected Source Collection independently. A Project returns to active retrieval only after its own authoritative Sync Run succeeds; ReasonKB never exposes indexes that may have become stale while the source was disabled.
