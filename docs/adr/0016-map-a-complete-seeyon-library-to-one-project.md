# Map a complete Seeyon library to one project

Each registered Seeyon document library maps to one isolated ReasonKB Project and is traversed recursively from its registered root `doc_resources` ID. ReasonKB preserves the library's folder-relative paths within the Project. The first release will not register subfolders as separate Projects, apply include or exclude subtrees, or register multiple roots for the same `docLibId`; those capabilities can be added later without changing the document library's identity.
