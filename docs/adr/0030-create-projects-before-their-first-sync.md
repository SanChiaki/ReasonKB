# Create projects before their first sync

Enabling a Source Collection immediately creates its stable Project in pending-sync state so administrators can see configuration, progress, and errors. The Project does not enter retrieval until its first authoritative Sync Run succeeds. A successful empty scan activates an explicitly empty Project, while initial failure retains a visible sync-failed Project with retry controls. ReasonKB does not delay Project identity creation until remote content happens to be available.
