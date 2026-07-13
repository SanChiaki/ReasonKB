# Confine local sources to a pre-mounted host root

ReasonKB supports runtime creation of any number of local Corpus Sources only beneath an installation-time Local Source Access Root, mounted read-only at a stable container path in the web, source synchronization, and indexing services. Sources within that boundary require no container restart. Expanding the allowed host boundary still requires changing the Docker bind mount and recreating containers. This avoids a privileged host agent and does not expose the unrestricted host filesystem merely to satisfy dynamic source configuration.
