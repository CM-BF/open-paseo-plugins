# Runtime dependency installation

The reported installation failed at `server/authored-source.ts` with `Could not resolve "linkedom"`. The package and lock already declared `linkedom` as a production dependency. The Git plugin manifest omitted its preparation command, so a fresh checkout reached compilation without that dependency. Earlier clean-build checks explicitly installed dependencies first and did not test this missing preparation step.

## Change

The manifest now runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` during managed Git preparation. This consumes the existing lock and does not run dependency lifecycle scripts. The committed client bundle needs no install-time build. A local directory install still requires the user to run the dependency command in the plugin directory before installation or reload; the README documents both paths.

## Verification

Source commit `d81fe8b17cd411b1cb06883c147c12e60b5e6196` was exported with `git archive` to a fresh temporary directory without `node_modules`.

- The installed Paseo 0.14.0 compiler reproduced the missing `linkedom` error before preparation.
- The installed host's manifest reader and preparation runner executed the declared command successfully. Exactly the production tree was installed; the plugin-local development SDK and TypeScript packages were absent.
- Canonical dependency resolution stayed inside the fresh plugin's `node_modules`. A real `linkedom` parse and DOM edit succeeded.
- The installed host compiler compiled the unchanged server and client entries from that production-only tree. Its directory candidate validation also accepted the prepared plugin.
- The committed client bundle was unchanged: SHA-256 `05374df4222dc2d74995a81a55ca55179eec6371d328e367ee17b9c5f195ab9e`.

The host compiler ran under Node 24.20.0. Dependency preparation used the Node 24 toolchain on PATH. Independent review found no blocking issue. Private evidence is retained under `~/.paseo/verification/paseo-board/install-linkedom-20261031/`, including the source archive, preparation log, original missing-dependency error and verification receipt.

## Limits and retained failures

These checks execute the actual preparation and compiler modules, not a mocked bundler. They do not install a second plugin on the live daemon, exercise a complete Git download/update transaction, or establish that the user's other computer has recovered. Runtime source and generated client code did not change, so browser behavior suites were not rerun for this configuration fix. Existing Board data and the running local plugin were untouched.

The first background launcher entered the desktop application instead of Node; the retry set `ELECTRON_RUN_AS_NODE` explicitly at the process boundary. A subsequent containment check compared `/var` to macOS's canonical `/private/var` and failed despite correct isolated resolution; the revised check uses `realpath` and retains a strict directory boundary. Original failure evidence is preserved.

The daemon host still needs a compatible Node/npm installation and registry access. This preparation command does not make local directory installs automatic or remove the production dependency tree's Node requirements.
