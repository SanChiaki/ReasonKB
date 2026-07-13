# Apply source configuration at runtime

Corpus Sources are runtime-managed entities persisted through the administrative API rather than a fixed set of startup environment variables. Creating, editing, enabling, or disabling a source must take effect without recreating containers. Source workers dynamically observe configuration revisions, while environment variables remain limited to deployment-wide defaults and secret-store bootstrap settings. This is required for an unbounded number of concurrently configured sources.
