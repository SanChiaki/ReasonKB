# Coalesce overlapping manual synchronization requests

Only one Sync Run may execute for a Source Collection at a time. A manual request made during an active run does not cancel or overlap that run; it records one high-priority follow-up run, and repeated requests coalesce into that same pending run. This preserves authoritative run boundaries and avoids duplicate source traffic while guaranteeing that an administrator's request observes source state again after the current run finishes.
