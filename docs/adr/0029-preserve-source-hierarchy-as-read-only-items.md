# Preserve source hierarchy as read-only items

ReasonKB persists both folder and document Source Items so Projects retain source-native hierarchy, paths, movement, and lifecycle state. Folders are never sent to PageIndex; they support traversal, Missing reconciliation, and a read-only project browser. The UI loads direct children lazily rather than rendering an entire large tree, and search results and citations include the full source-relative path. No hierarchy operation writes back to the Corpus Source.
