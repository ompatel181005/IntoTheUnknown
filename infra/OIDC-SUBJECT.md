# GitHub OIDC subject selection (#23)

The setup helper reads `GET repos/{owner}/{repo}/actions/oidc/customization/sub`
before creating Azure identities, federation or grants. It requires the default
claim template, a boolean immutable-format setting and a string prefix. It accepts
either the exact name-only repository prefix with immutable format disabled, or
the exact repository names with positive numeric owner/repository IDs returned by
GitHub with immutable format enabled. It appends only `:ref:refs/heads/main`.
It does not guess IDs, accept wildcards, change GitHub's claim settings, or repair
an existing mismatched Azure trust automatically.

Reason: newer repositories use immutable IDs in their default subject. A fixed
`repo:owner/name` prefix can therefore reject valid main-branch deployments.
Custom claim templates, unreadable metadata, inconsistent format flags and
unexpected prefixes require review rather than a fallback grant.

Official sources checked on 2026-11-14:

- [GitHub OIDC REST API](https://docs.github.com/en/rest/actions/oidc)
- [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [Immutable subject announcement](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/)

Validation: `bash infra/check-scripts.sh` and `bash infra/tests/run.sh` use offline
fixtures only. This helper repair does not change a live federation or workflow.
