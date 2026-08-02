# Releasing PiLink to npm

PiLink publishes through npm trusted publishing. The GitHub Actions workflow uses short-lived OIDC credentials and does not require an `NPM_TOKEN` repository secret.

## One-time repository setup

1. On npmjs.com, open the `pilink` package settings and add a trusted publisher for:
   - GitHub owner: `roccoangelella`
   - Repository: `PiLink`
   - Workflow filename: `release.yml`
   - Environment: `npm`
   - Allowed action: `npm publish`
2. In the GitHub repository settings, create an environment named `npm`.
3. Add required reviewers to that environment when releases should require manual approval.
4. After the first OIDC release succeeds, disable or revoke legacy npm automation tokens that can publish this package.

The workflow grants only `contents: read` and `id-token: write`. npm automatically attaches provenance when a public package is published from a public GitHub repository through trusted publishing.

## Release procedure

1. Update `version` in `package.json` and `package-lock.json`.
2. Update release notes and run:

   ```bash
   npm ci --ignore-scripts --audit=false
   npm audit signatures
   npm audit --audit-level=moderate
   npm test
   npm pack --dry-run
   ```

3. Merge the version change into the default branch.
4. Create a GitHub release whose tag is exactly `v<package version>`, such as `v1.2.0`.
5. Publish the GitHub release. This triggers `.github/workflows/release.yml`.
6. Approve the `npm` environment deployment when required.
7. Confirm that the workflow completed and that npm displays provenance for the published version.

The workflow checks out the release tag rather than the mutable default branch, does not persist GitHub credentials in the checkout, verifies the tag against `package.json`, uses an exact Node.js LTS release and verifies its npm CLI supports OIDC, installs the locked dependency graph with lifecycle scripts disabled, verifies registry signatures and available provenance attestations, rejects moderate-or-higher known vulnerabilities, runs the full test suite, inspects the package contents, and only then executes `npm publish`.

## Failure behavior

A release is not published when:

- the tag does not exactly match `v${version}` from `package.json`;
- installation, compilation, tests, or package inspection fail;
- the GitHub `npm` environment is not approved;
- the npm trusted-publisher configuration does not match the repository, workflow, or environment;
- npm rejects the version because it already exists.

Do not add a long-lived `NPM_TOKEN` fallback to the workflow. Fix the trusted-publisher configuration instead.
