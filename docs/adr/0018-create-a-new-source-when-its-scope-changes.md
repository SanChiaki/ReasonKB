# Create a new source when its scope changes

The first multi-source release does not support relocating a Corpus Source. Its endpoint and root-defining Source Scope is immutable after creation: changing a Seeyon endpoint, SMB host/share/base path, or local root path creates a distinct Corpus Source with distinct Projects and document identities. Display names, credentials, and Synchronization Policies remain editable at runtime. Administrators deactivate or delete the old source separately instead of silently repointing it at different content.
