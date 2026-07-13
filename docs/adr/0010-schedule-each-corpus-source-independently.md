# Schedule each corpus source independently

Each Corpus Source has its own configurable Synchronization Policy and may also be synchronized immediately by an administrator. A source never runs overlapping scans; a system-wide concurrency limit fairly schedules due sources. Failures apply exponential backoff only to the affected source, while successful synchronization restores its normal schedule. The scheduler observes runtime configuration changes, so adding, editing, enabling, or disabling sources requires no container restart.
