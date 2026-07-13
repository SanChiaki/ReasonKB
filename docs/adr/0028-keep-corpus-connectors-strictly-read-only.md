# Keep corpus connectors strictly read-only

Corpus Connectors may discover collections, scan metadata, and read or download source documents, but ReasonKB never uploads, overwrites, moves, deletes, or changes permissions in local directories, SMB shares, or Seeyon. Host mounts remain read-only, and deleting ReasonKB sources, Projects, or indexes affects only ReasonKB state. Source write-back would require a separate capability and security model rather than extending the ingestion connector contract.
