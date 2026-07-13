# Guard index publication by expected revision

Every index job carries its expected Source Revision. The worker abandons work as superseded if the document already expects another revision, verifies transferred metadata after fetching, and publishes the index with a compare-and-swap that succeeds only while the document still expects that revision. A newer Sync Run may therefore queue revision B while revision A is running without allowing A to overwrite B or re-enter retrieval. Superseded jobs remove temporary artifacts and consume neither failure retries nor error budget.
