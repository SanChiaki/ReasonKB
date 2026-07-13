# Deactivate projects before deleting imported data

Disabling a Source Collection deactivates its Project: synchronization stops, the Project immediately leaves the retrieval scope, and its documents, indexes, and historical references remain available for reactivation. Purging imported data is a separate explicit destructive action. This makes routine source selection reversible and prevents accidental deselection from forcing expensive re-indexing or breaking historical references.
