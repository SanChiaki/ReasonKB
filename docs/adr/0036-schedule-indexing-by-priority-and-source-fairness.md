# Schedule indexing by priority and source fairness

Index work is prioritized in this order: administrator-triggered document work, refresh of an existing document's new Source Revision, first indexing of newly discovered content, and automatic retries. Within a priority, the worker rotates fairly across Corpus Sources and Projects instead of consuming a global FIFO from one large source. Global concurrency remains configurable, each source defaults to one in-flight index job, and only one effective job exists for a document revision; a newer revision supersedes queued work for an older one.
