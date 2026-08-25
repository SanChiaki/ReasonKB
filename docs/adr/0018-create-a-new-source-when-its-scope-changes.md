# Create a new source when its scope changes

The first multi-source release does not support silently relocating a Corpus Source. Its endpoint and root-defining Source Scope is immutable through the ordinary update API: changing an SMB host/share/base path or local root path still requires a distinct Corpus Source.

Seeyon is the controlled exception because deployments commonly move the same OA instance from an intranet URL to a public URL. Administrators may start an explicit Seeyon URL migration. The worker validates the target endpoint and scans every selected registered collection before applying anything. The old endpoint remains the active source while the target is being staged; a failed or cancelled migration leaves the old scope, credentials, projects, documents, and indexes untouched. After all scans succeed, one transaction updates the existing source scope and credentials, keeps the stable Seeyon document identities (`fr_id`), and queues reindexing only for items whose source revision changed. This preserves projects and reusable indexes without making an unverified URL authoritative.

Display names, credentials, and Synchronization Policies remain editable at runtime, except while a migration is active. Administrators can cancel an in-flight migration and retain the old source configuration.
