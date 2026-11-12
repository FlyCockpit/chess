## Summary

<!-- What does this change do, and why? Link related issues (for example "Closes #123"). -->

## Checks run

- [ ] `pnpm verify:fast`
- [ ] Other (describe):

## Checklist

- [ ] If this adds or changes an oRPC procedure, route gate or schema field, `docs/access-matrix.md` is updated in this change.
- [ ] User-facing strings go through `t()`, with keys in both English and Spanish locale files; new environment variables, public pages and docs are updated as described in `AGENTS.md`.
- [ ] No secrets or personal data in code, tests, fixtures or logs.
