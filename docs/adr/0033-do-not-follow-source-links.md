# Do not follow source links

Corpus Connectors do not follow local symbolic links or SMB junctions, DFS links, and recognizable reparse points. Ignored links are counted as skipped with an administrator-visible reason, and resolved local paths are revalidated against the Local Source Access Root. This prevents path escape, traversal cycles, and accidental duplicate ingestion. Administrators connect a link target through its real path as a separate Corpus Source when that content is required.
