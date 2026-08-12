# Versioned Evaluation Report

`index.html` is the public, versioned ReasonKB evaluation summary published by
GitHub Pages. Update it with each accepted benchmark snapshot so Git history
retains the result associated with each ReasonKB version.

The public report may include:

- corpus size and evaluation date
- aggregate recall, readability, latency, and reliability metrics
- methodology, failure categories, and implementation priorities
- anonymized examples that contain no source content or confidential metadata

Do not copy the raw self-contained audit report into this directory. The raw
report embeds questions, filenames, document paths, excerpts, complete evidence
content, and structured page blocks from restricted corpora. Keep that artifact
in the controlled evaluation workspace.

Before publishing an update:

1. Re-run the benchmark against the intended ReasonKB revision and corpus.
2. Update the date, corpus scope, data version, aggregate metrics, and findings.
3. Check the HTML for source filenames, project IDs, document IDs, source text,
   confidentiality markings, credentials, and service endpoints.
4. Serve `docs/` locally and browser-test `/`, `/evaluation/`, and the System
   Atlas at desktop and mobile widths.
5. Commit the summary in the same branch as the version whose behavior it
   describes.
