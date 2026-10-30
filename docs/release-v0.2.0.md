# v0.2.0 publication repair

## Observed on 2026-10-30

- `main`: `ab38c36f32d85ae526d3526cfaff41e5cbb762fe`; package/server/runtime version 0.2.0.
- Public lightweight tag `v0.2.0`: `0d60d01e806193decd9f0eb31e2b56b393cc4863`; package/server version 0.1.1. It is two commits behind main and lacks API v2 / asof.
- GitHub Actions: one successful v0.1.0 push run, no v0.2.0 publication run.
- GitHub Releases: v0.1.0 only.
- npm: versions 0.1.0 and 0.1.1, latest 0.1.1; no 0.2.0.
- MCP Registry: active latest server/package 0.1.1; no claim of a published 0.2.0.
- npm Trusted Publisher registration remains unverified: the management UI was blocked by a Cloudflare verification loop. Public registry metadata does not establish this setting.

## npm account configuration

Package: `@codeagentjp/egov-law-mcp`. In package settings, register or verify a GitHub Actions Trusted Publisher with:

| Field | Value |
| --- | --- |
| Organization or user | `SHAYOUWORLD` |
| Repository | `egov-law-mcp` |
| Workflow filename | `publish.yml` |
| Environment | empty (the job has no GitHub environment) |
| Allowed actions, if shown | direct `npm publish` |

The workflow uses GitHub-hosted Ubuntu, Node 24, npm >=11.5.1, and `id-token: write`. It does not use NPM_TOKEN. Do not revoke a shared token as part of this repair. No additional secret is needed for MCP Registry GitHub OIDC.

## Approval required before replacing the public tag

Published Git tags are not automatically replaced in existing clones. Git dependencies pinned to `#v0.2.0`, source archive downloads, and cached artifacts could therefore refer to different contents after a retag. The number of affected users cannot be determined from the public data. npm users of 0.1.1 are unaffected by a Git tag move; publishing 0.2.0 advances unpinned npm consumers to API v2.

Git recommends a new name for an already public tag. Publishing 0.2.1 would avoid retagging but would change the requested release version. To retain the requested v0.2.0, obtain explicit owner approval for this exception, preserve the old SHA under an archival ref, and disclose the correction in the release notes. Do not delete the tag and recreate it without a lease.

After approval, merge the repair PR and resolve its exact merge SHA as `RELEASE_SHA`. Verify the remote tag is still the old SHA. Preserve the old ref under a name that does not match the `v*` publish trigger, then update with a lease:

```bash
OLD_SHA=0d60d01e806193decd9f0eb31e2b56b393cc4863
# Set RELEASE_SHA to the reviewed repair commit on main, never a guessed SHA.
git fetch origin main
git merge-base --is-ancestor "$RELEASE_SHA" origin/main
git push origin "$OLD_SHA:refs/tags/archive/incorrect-v0.2.0-20261030"
git push --force-with-lease="refs/tags/v0.2.0:$OLD_SHA" origin "$RELEASE_SHA:refs/tags/v0.2.0"
```

A tag push authenticated by a GitHub App/GITHUB_TOKEN may not start another workflow. Verify an actual publish run exists. If none starts, use `workflow_dispatch` on main with input `tag=v0.2.0`, authenticated as a user with Actions write access. The workflow checks that the tag resolves to the checked-out commit and that it belongs to main. The repository integration used for this repair may lack tag-write or workflow-dispatch capabilities; do not substitute a branch named like a tag.

## Publication and recovery

The workflow tests the source, runs a real stdio initialize/tools-list exchange, packs the exact npm artifact, and checks whether that version already exists. An existing npm version is accepted only when its integrity equals the freshly packed artifact. A different artifact fails closed. After npm publication, an exact-version npx installation must report 0.2.0 and all four asof tools before MCP registration proceeds. An existing active MCP version is accepted only when its package identity/version/transport match server.json.

If npm succeeds but MCP registration fails, rerun the same reviewed tag using workflow_dispatch. Do not unpublish npm, overwrite a version, move the tag again, or bump versions merely to retry. Registry/network errors other than an exact version's 404 stop publication. Final checks require both registries' latest versions to be 0.2.0 and npm artifact integrity to match. If propagation is delayed, inspect the exact-version endpoints and retry after it becomes visible.

Create the GitHub Release for the corrected tag only after the workflow succeeds. Include the following disclosure, replacing `<RELEASE_SHA>` with the full actual SHA:

> The original v0.2.0 tag pointed to 0d60d01e806193decd9f0eb31e2b56b393cc4863, whose internal version was 0.1.1 and which lacked API v2/asof. With owner approval, it was corrected to <RELEASE_SHA>. npm/MCP 0.2.0 is the first registry publication of this version. Existing Git clones must explicitly refresh the tag if they previously fetched it.

```bash
git tag -d v0.2.0
git fetch origin tag v0.2.0
git rev-parse 'v0.2.0^{commit}'
```

Deleting the local tag is only needed for users who fetched the incorrect tag. Record the successful workflow URL, corrected SHA, npm integrity and MCP metadata in the release.

## Sources

- https://docs.npmjs.com/trusted-publishers/
- https://git-scm.com/docs/git-tag#_on_re_tagging
- https://github.com/SHAYOUWORLD/egov-law-mcp/compare/v0.2.0...ab38c36f32d85ae526d3526cfaff41e5cbb762fe
- https://registry.npmjs.org/@codeagentjp%2Fegov-law-mcp
- https://registry.modelcontextprotocol.io/v0.1/servers/io.github.SHAYOUWORLD%2Fegov-law-mcp/versions/latest
