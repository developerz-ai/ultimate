// The Dependabot config `x new` writes. Every `@ultimat3/*` package is released in lockstep, so a
// PR that bumps one of them alone is an install no release ever shipped: they move as ONE group,
// majors included. The base images the scaffold pins under `docker/` are watched beside them.

/** Where GitHub reads it. */
export const DEPENDABOT_PATH = '.github/dependabot.yml';

/** The directory `x new` writes its Dockerfile and compose files into. */
const DOCKER_DIR = '/docker';

export const dependabot = (): string => `version: 2

# Weekly, grouped, and small — a dependency PR nobody can review in one sitting gets merged unread.
updates:
  # \`bun\`, never \`npm\`: the tree is locked by \`bun.lock\` alone, which the npm ecosystem refuses.
  - package-ecosystem: bun
    directory: /
    schedule:
      interval: weekly
    # A release sits 14 days before it is proposed: most yanked versions are yanked by then.
    cooldown:
      default-days: 14
    open-pull-requests-limit: 5
    labels: [dependencies]
    groups:
      # Released in lockstep, so upgraded in lockstep: one PR, every update type. A bump of one
      # package alone is a combination no release shipped. A major is \`x upgrade\`'s job — the PR
      # says it is due; run \`bunx x upgrade\` on its branch.
      ultimate:
        patterns: ['@ultimat3/*', 'create-ultimate']
      dependencies:
        patterns: ['*']
        exclude-patterns: ['@ultimat3/*', 'create-ultimate']
        update-types: [minor, patch]
    ignore:
      # Bun is pinned by \`engines\` and the workflow's \`bun-version\`, not by a package bump.
      - dependency-name: bun

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
    labels: [dependencies, ci]
    groups:
      actions:
        patterns: ['*']

  # The base images the Dockerfile and the compose files pin.
  - package-ecosystem: docker
    directories: ['${DOCKER_DIR}']
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
    labels: [dependencies, docker]
    ignore:
      # A Postgres MAJOR is a planned migration (a new data directory), never a weekly bump.
      - dependency-name: postgres
        update-types: ['version-update:semver-major']

  - package-ecosystem: docker-compose
    directories: ['${DOCKER_DIR}']
    schedule:
      interval: weekly
    cooldown:
      default-days: 14
    labels: [dependencies, docker]
    ignore:
      - dependency-name: postgres
        update-types: ['version-update:semver-major']
`;
