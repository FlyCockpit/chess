# Branch rulesets

`main.json` is an importable GitHub ruleset that requires a pull request before
changes land on the default branch, blocks force-pushes and branch deletion,
and requires the named jobs from `.github/workflows/pr-checks.yml` to pass.

GitHub does not apply a checked-in ruleset file automatically. A human with
admin access has to import it once.

## Import

1. Open the repository on GitHub → **Settings** → **Rules** → **Rulesets**.
2. Click **New ruleset** → **Import a ruleset**.
3. Choose `.github/rulesets/main.json`.
4. Review the required check. `PR validation` is the always-running aggregate
   in `pr-checks.yml`: on a ready PR it requires a successful setup plus every
   validation job; on a draft it records the intentional skips. If you add,
   remove, or rename a validation job, update that aggregate and `main.json` in
   the same change.
5. Click **Create**. Enforcement is `active`. Keep **Bypass list** empty.

Already imported an older copy? Edit the existing ruleset to match the file (or
delete it and import again): GitHub does not re-read `main.json` on its own.

Until this is imported, a direct push to `main` skips every PR check.
The file is the intended policy; importing it is what makes it real.

## Notes on the required list

- **`Install dependencies`** (`setup`) is an input to the required aggregate.
  If it fails, dependent jobs may be skipped by GitHub, but `PR validation`
  still runs and fails for a ready PR; skipped jobs can never hide install
  failure.
- **`pnpm audit`** is required, not advisory. It is the one check whose result
  can change without a code change (a new advisory lands against an unchanged
  lockfile), so it will occasionally turn a green PR red — that is the point.
  If it becomes noisy, raise `--audit-level` in `pr-checks.yml` rather than
  dropping the context here, so the gate stays required.
- A **skipped** required check counts as satisfied on GitHub. That is why
  `pr-checks.yml` listens for `ready_for_review`: without it, a PR opened as a
  draft would leave every job skipped and merge clean.
- **Companion CLI binaries** (`cli-build.yml`, with a macOS runner) build
  only on PRs that touch the CLI, its shared constants, its router, the
  lockfile, or its workflows. `PR validation` requires that build whenever
  `cli-changes` reports it was needed, and requires it skipped otherwise.
- **Docker** is represented twice inside `PR validation`: the matrix job result
  and its human-facing `docker-gate`. The aggregate requires both to succeed on
  ready PRs, so a skipped or failed matrix cannot satisfy the branch rule.
- **Merge methods** are limited to merge commits and squash
  (`allowed_merge_methods`); rebase merging is off. Every commit that lands on
  the default branch is then the merge result of a pull request that passed
  `PR validation`, never a replayed copy of its commits. Turn on **Require
  linear history** if you want squash only; do not re-enable rebase.
- **`PR validation` is pinned to GitHub Actions** (`integration_id` 15368, the
  GitHub Actions app). Any app or token with `statuses` access can post a
  commit status named `PR validation`; the pin makes the rule accept only a
  check reported by GitHub Actions. That is any workflow run for the pull
  request's head commit, including one the pull request itself adds or edits,
  so the pin stops outside apps and tokens, not a changed workflow; review
  workflow changes in the PR.
