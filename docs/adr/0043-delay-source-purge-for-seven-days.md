# Delay source purge for seven days

Deleting a Corpus Source immediately stops synchronization and retrieval but places the source in pending-purge state for seven days, preserving credentials, collections, Projects, documents, and indexes for restoration. After the recovery window, background cleanup permanently cascades through source-owned operational data. Administrators may choose immediate permanent purge only after confirming the Source Display Name. Administration audit events remain under their 180-day retention policy and are not removed with the source.
