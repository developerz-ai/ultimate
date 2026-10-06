// The image half of what `x new` writes under `.github/`: publish `docker/Dockerfile` to the
// repository's own GitHub Container Registry, only for a commit `ci.yml` already passed on the
// default branch. It runs no gate of its own — a second gate is a second definition of one — and
// it deploys nothing: the image digest is the handoff, axiom 7's one deploy artifact.

import { DEFAULT_RUNNER } from './runner';

/** Where the workflow lands, beside the gate it waits on. */
export const IMAGE_WORKFLOW_PATH = '.github/workflows/image.yml';

/** The Dockerfile `containerFiles` writes — the one image every role runs. */
export const IMAGE_DOCKERFILE = 'docker/Dockerfile';

/** `gate` is the `name:` of the workflow whose verdict this one waits on — `ci.yml`'s own. */
export const imageWorkflow = (gate: string): string => `name: image

# Builds ${IMAGE_DOCKERFILE} and pushes it to ghcr.io/<owner>/<repo>, tagged \`sha-<7>\` and the full
# commit SHA — never \`latest\`, a pointer a late run moves backwards. Only GITHUB_TOKEN: GHCR takes
# the job's own token, so there is no secret to create.
#
# Triggered by \`${gate}\` FINISHING, never by the push both would start from: a second
# workflow on the same push is not a dependency, and this one must publish only what the gate
# judged. A \`workflow_run\` has no branch filter here for the reason ci.yml's \`on:\` has none —
# \`x new\` never decided what the default branch is called — so the job's \`if:\` asks GitHub.
on:
  workflow_run:
    workflows: [${gate}]
    types: [completed]

# One publish per commit, never cancelled mid-push: a half-pushed manifest is worse than a queue.
concurrency:
  group: image-\${{ github.event.workflow_run.head_sha }}
  cancel-in-progress: false

permissions:
  contents: read
  packages: write

jobs:
  publish:
    # A green gate, from a push (never a fork's pull request, whose head would build with a
    # registry token in scope), to the default branch of THIS repository.
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_branch == github.event.repository.default_branch &&
      github.event.workflow_run.head_repository.full_name == github.repository
    # NOT \`vars.CI_RUNNER\`: the gate may move to any runner, but this job needs bash (\`\${SHA::7}\`,
    # \`\${GITHUB_REPOSITORY,,}\`) and a Docker daemon, and a Windows or self-hosted label may have
    # neither — a green gate would then publish nothing. The free GitHub-hosted Linux runner has both.
    runs-on: ${DEFAULT_RUNNER}
    defaults:
      run:
        shell: bash
    timeout-minutes: 30
    steps:
      # The commit the gate judged, not the tip of the branch when this run started.
      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
          persist-credentials: false
      # GHCR refuses an upper-case repository path, and \`github.repository\` keeps the owner's case.
      - name: name the image
        id: image
        env:
          SHA: \${{ github.event.workflow_run.head_sha }}
        run: |
          repo="ghcr.io/\${GITHUB_REPOSITORY,,}"
          {
            echo "short=\${repo}:sha-\${SHA::7}"
            echo "full=\${repo}:\${SHA}"
          } >> "$GITHUB_OUTPUT"
      # The plain docker CLI every GitHub-hosted runner ships — no third-party action holds the
      # token. BUILD_ID is the commit, the stamp ${IMAGE_DOCKERFILE} documents.
      - name: log in to ghcr.io
        env:
          TOKEN: \${{ github.token }}
        run: printf '%s' "$TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
      - name: build
        env:
          SHA: \${{ github.event.workflow_run.head_sha }}
          SHORT: \${{ steps.image.outputs.short }}
          FULL: \${{ steps.image.outputs.full }}
        run: docker build -f ${IMAGE_DOCKERFILE} --build-arg "BUILD_ID=$SHA" -t "$SHORT" -t "$FULL" .
      - name: push
        env:
          SHORT: \${{ steps.image.outputs.short }}
          FULL: \${{ steps.image.outputs.full }}
        run: |
          docker push "$SHORT"
          docker push "$FULL"
`;
