# Set a testable multi-source capacity envelope

ReasonKB places no product-level fixed limit on Corpus Sources, Source Collections, or discovered documents, but capacity remains bounded by deployment resources and indexing cost. The first multi-source release must be verified with at least 100 concurrently enabled sources, 1,000 enabled collections and Projects, and 100,000 discovered documents. Discovery must use bounded-memory pagination or streaming, and indexing is asynchronous so a large discovery result may safely accumulate in the job queue rather than being processed at once.
