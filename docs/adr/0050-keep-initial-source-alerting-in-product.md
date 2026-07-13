# Keep initial source alerting in product

The initial multi-source release reports source health in the administration interface, including the latest successful synchronization time, consecutive failure count, next retry time, and sanitized error summary. It does not send email, SMS, or vendor-specific chat notifications, avoiding notification credentials and provider coupling in the first release; a later integration may expose optional generic webhooks without changing the source health model.
