# COMSOLPilot Desktop Development

## Source of truth

This desktop repository is paired with the standalone COMSOLPilot repository:

- `https://github.com/waverlose/COMSOLPilot` is the canonical MCP core.
- `https://github.com/waverlose/COMSOLPilot-desktop` is this desktop shell.

The desktop repository keeps a synchronized copy under `core/`. The desktop
application uses that directory in development and bundles it into the
packaged sidecar.

Core changes should be developed and committed in the standalone core
repository first. After validation, promote the affected core files into this
repository's `core/`, run the desktop checks, and commit the synchronized copy.
Desktop-only changes stay in this repository. Do not create a third core copy.

Core code belongs under `core/src`, `core/scripts`, `core/docs`, and
`core/tests`. The desktop shell is under `src/`, `electron/`, `src-tauri/`, and
`python-sidecar/`.

## Two-repository workflow

1. Develop a core feature in the standalone `COMSOLPilot` checkout.
2. Run the core tests and push the core commit to its `main` branch.
3. Copy the changed core files into `comsolpilot-desktop/core`.
4. Run the desktop checks and push the desktop commit to its `main` branch.

The two repositories intentionally have separate commits. `mcp_targets.py` and
the sidecar integration may contain desktop-only adaptations and must be
reviewed instead of blindly overwritten during synchronization.

## Development commands

```text
npm install
npm run sidecar:setup
npm run electron:dev
npm run tauri:dev
```

Use `electron:dev` or `tauri:dev` according to the shell being developed. The
sidecar resolves the core through `python-sidecar/paths.py`, so both shells use
the same core implementation.

## Verification

```text
npm run typecheck
npm run build
python -m pytest core/tests -q
```

The COMSOL Server must be available for integration checks. Unit and schema
tests should run with the configured core Python environment, not the sidecar
runtime environment unless that environment has the core dependencies.

## Runtime and build files

`core/workspace/`, `node_modules/`, `.venv-sidecar/`, `dist/`, `release*/`,
`build/`, and generated sidecar binaries are local artifacts. They are ignored
by Git and can be recreated with the setup and build commands.
