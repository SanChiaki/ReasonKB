# Represent root-level files as a source collection

Local and SMB connectors discover a synthetic Root Collection with stable connector identity `__root__` whenever supported files exist directly beneath the configured source root. Those files form an isolated Project rather than being silently ignored or assigned to a top-level directory Project. The Root Collection participates in explicit selection and the continuous all-collections policy, disappears from discovery when no root files remain, and never absorbs content beneath first-level directories.
