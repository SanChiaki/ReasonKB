# Purge demo upload data during migration

The formal multi-source migration permanently removes Projects, documents, indexes, jobs, conversation links, and managed files belonging to the demo-only manual upload capability. It does not create a Legacy Uploads source or preserve those records for retrieval. This is an intentional product boundary and accepted destructive migration: only data backed by supported external Corpus Sources is carried into the formal version.
