# Knowledge Corpus

ReasonKB organizes external content into isolated projects that can be indexed and selected for retrieval.

## Language

**Corpus Source**:
A deployment-scoped, read-only connection to a content origin, such as a local directory root, an SMB share, or a Seeyon server. It is managed by an administrator and may expose any number of Source Collections.
_Avoid_: Corpus, backend, directory

**Source Scope**:
The endpoint and root boundary that define a Corpus Source's content origin. Changing the Source Scope defines a different Corpus Source rather than relocating the existing one, except for the explicit Seeyon URL migration workflow, which stages and validates a replacement endpoint before switching the existing source identity.
_Avoid_: Editable connection setting, source name

**Source Display Name**:
The deployment-unique administrator-defined label used to distinguish a Corpus Source in the interface. It is editable and is not part of source, Project, or document identity.
_Avoid_: Source ID, project prefix

**Draft Source**:
A saved Corpus Source configuration that has not passed connection validation. It does not run discovery or synchronization and cannot enable Source Collections.
_Avoid_: Degraded source, disabled source, active connection

**Pending-Purge Source**:
A deleted Corpus Source retained for a limited recovery period while excluded from synchronization and retrieval. Restoring it preserves its prior collections, Projects, documents, and indexes.
_Avoid_: Disabled source, permanently deleted source

**Source Collection**:
A source-native content boundary discovered through a Corpus Source or registered by an administrator when discovery is unavailable, such as a top-level directory or a Seeyon document library. Enabling a Source Collection creates its corresponding Project.
_Avoid_: Project candidate, remote folder

**Root Collection**:
A synthetic Source Collection containing files located directly at a local or SMB source root. It exists only when such files are present and does not include content beneath top-level directories.
_Avoid_: Default project, source root directory

**Collection Selection Policy**:
The durable rule that determines which Source Collections are enabled for a Corpus Source: None, an Explicit set, or All current and future collections. Changing All to Explicit snapshots all currently known collections, changing Explicit to All includes future collections, and changing to None deactivates every Project without deleting retained data.
_Avoid_: Select all, checked items

**Collection Registration**:
An administrator's declaration of a Source Collection that the connector cannot discover. A Seeyon registration is identified by its document library ID and root archive ID; its display name is editable, and registration does not enable ingestion until validation succeeds and the collection is selected.
_Avoid_: Manual project, imported library

**Deregistered Collection**:
A manually declared Source Collection removed from active administration while its identity, Project, documents, and indexes remain retained. Registering the same collection identity again restores the retained collection rather than creating a replacement.
_Avoid_: Deleted project, purged collection, missing collection

**Collection Root**:
The source-native traversal entry point for a Source Collection. A Project includes the complete hierarchy beneath this root and preserves source-relative paths within it.
_Avoid_: Project folder, partial library

**Project**:
An isolated, deployment-shared retrieval scope created from one enabled Source Collection whose display name follows that collection. Projects from different sources remain distinct even when they have the same name and are identified in the interface together with their Corpus Source.
_Avoid_: Source, data source

**Source Administrator**:
A deployment administrator permitted to configure Corpus Sources, collection selection, synchronization, and purge operations. Project retrieval is shared with ordinary deployment users, who cannot administer sources.
_Avoid_: Source Principal, Project owner, connector user

**Pending Project**:
A Project created for an enabled Source Collection that has not yet completed its first authoritative Sync Run. It is visible for administration but excluded from retrieval.
_Avoid_: Active project, failed project

**Pending-Purge Project**:
A Project scheduled for permanent data removal after a limited recovery period. It is excluded from synchronization and retrieval but can be restored with its identity and retained data until purge completes.
_Avoid_: Inactive project, deleted project, pending project

**Retrieval Coverage**:
The current distribution of a Project's discovered documents across retrievable, queued, indexing, refreshing, failed, and excluded states. An active Project may provide partial retrieval while its coverage continues to grow.
_Avoid_: Sync progress, document count, Project status

**Inactive Project**:
A Project retained with its documents and indexes but excluded from synchronization and retrieval. It can be reactivated without being imported as a new Project.
_Avoid_: Deleted project, paused source

**Access-Revoked Project**:
A retained Project whose registered Source Collection is definitively inaccessible to the current Source Principal. It is excluded from synchronization and retrieval until a later authoritative check restores access.
_Avoid_: Missing project, degraded source, deleted project

**Access-Revoked Source Item**:
A retained document that is definitively inaccessible to the current Source Principal while its Source Collection remains accessible. It is excluded from retrieval until a later authoritative check restores access.
_Avoid_: Missing item, unsupported item, failed download

**Degraded Source**:
A Corpus Source whose latest discovery or synchronization attempt did not complete successfully. Its previously known collections and documents remain unchanged until an authoritative scan succeeds.
_Avoid_: Empty source, disconnected project

**Needs-Attention Source**:
A Corpus Source requiring administrator action because synchronization has failed three consecutive times or a non-retryable configuration, credential, or authorization problem is known. A later complete successful synchronization restores normal health and clears the consecutive failure count.
_Avoid_: Degraded source, disabled source, broken project

**Missing Source Item**:
A previously known collection or document that is absent from a complete successful source scan. It is excluded from retrieval but retained so that the same item can recover its prior identity if it reappears.
_Avoid_: Deleted item, failed item

**Source Tombstone**:
The retained identity and lifecycle record of a source item whose imported content has been removed. It allows the same Source Item ID to recover its prior ReasonKB identity if it reappears.
_Avoid_: Archived index, deleted document content

**Source Item ID**:
The identity of a collection or document within one Corpus Source. Connectors use a stable source-native identifier when available and otherwise fall back to the item's source-relative path.
_Avoid_: Download ID, storage path, content hash

**Source Item**:
A folder or document within a Source Collection, retaining its source-native hierarchy and path. Only document items are eligible for content indexing.
_Avoid_: Indexed document, local file

**Unsupported Source Item**:
A discovered document whose current format ReasonKB cannot index. Its source identity and metadata are retained, but its content is neither fetched nor queued for indexing.
_Avoid_: Skipped path, failed document, missing item

**Oversized Source Item**:
A discovered document whose reported or transferred size exceeds its Corpus Source's indexing limit. Its identity and metadata are retained without fetching or indexing content until the limit permits it.
_Avoid_: Unsupported item, failed download, large indexed document

**Source Revision**:
The connector-provided fingerprint of a source document's current content version. A changed Source Revision requires fetching and indexing new content without changing the document's Source Item ID.
_Avoid_: Document identity, creation time, scan time

**Refreshing Document**:
A document whose newer Source Revision is known but not yet indexed successfully. Its previous index is retained for recovery but excluded from retrieval until the new revision is ready.
_Avoid_: Indexed document, failed document, stale result

**Index-Failed Document**:
A document whose current Source Revision exhausted automatic fetch or indexing retries, or encountered a permanent content error. It remains excluded from retrieval until an administrator retries it or a new Source Revision appears.
_Avoid_: Unsupported item, missing item, degraded source

**Source Credential**:
Authentication material held for a deployment-scoped Corpus Source. It is persisted only as authenticated ciphertext and is distinct from short-lived connection tokens.
_Avoid_: Source configuration, token, password field

**Source Principal**:
The current remote user identity under which a Corpus Source evaluates visibility. It is editable connection configuration rather than source identity; changing it suspends existing retrieval until an authoritative synchronization reconciles the new principal's visibility.
_Avoid_: ReasonKB owner, Source ID, immutable scope

**Source Configuration Revision**:
The immutable version of a Corpus Source's connection settings and credentials under which source work is performed. Results from an older revision are non-authoritative once a newer revision has been saved.
_Avoid_: Document revision, source version, credential version

**Synchronization Policy**:
The per-source rule that determines when synchronization runs. It supports a configurable schedule and immediate manual runs while preventing overlapping scans of the same source.
_Avoid_: Global scan interval, watcher delay

**Sync Run**:
A single authoritative document synchronization attempt for one enabled Source Collection. Only a completed Sync Run may mark previously known documents in that collection as missing.
_Avoid_: Poll, page, index job

**Source Discovery Run**:
An attempt to refresh the Source Collections known for a discoverable Corpus Source. Its result affects collection presence but never substitutes for a collection's document Sync Run.
_Avoid_: Sync Run, project scan

**Local Source Access Root**:
The host directory mounted read-only into ingestion services as the allowed boundary for runtime-configured local Corpus Sources. Every local source path must be contained within this root.
_Avoid_: Projects root, host browse path, unrestricted host filesystem
