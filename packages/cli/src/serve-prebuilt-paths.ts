// Where the image's prebuilt store lives and the one command that writes it. A leaf with no
// import, so the Dockerfile template, the build command and the container boot all spell them
// from here without loading each other.

/**
 * App-root-relative. NOT under `.x/`: that is the state directory, which the scaffolded compose
 * topology mounts a tmpfs over and every ignore file drops, so a store written there never reached
 * a running container. Under `node_modules` because that is the one directory every tool already
 * leaves alone — git, the linter, every source walker and the image context — and the one the
 * image build has just written, so it is in a layer and readable under a read-only root.
 */
export const PREBUILT_DIR = 'node_modules/.cache/ultimate';

export const PREBUILT_ISLANDS_DIR = `${PREBUILT_DIR}/islands`;

export const PREBUILT_SASS_DIR = `${PREBUILT_DIR}/sass`;

/** The Dockerfile line that writes the store — one spelling, for the template and every `fix:`. */
export const PREBUILT_COMMAND = 'bun node_modules/@ultimat3/cli/src/bin.ts build --target prebuilt';
