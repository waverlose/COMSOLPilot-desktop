# COMSOLPilot Desktop Development

## Source of truth

This repository is the combined COMSOLPilot project. The canonical COMSOLPilot
core lives in `core/`. The desktop application uses that directory in
development and bundles it into the packaged sidecar.

Do not maintain a second working copy of the core outside this repository.
Core changes belong under `core/src`, `core/scripts`, `core/docs`, and
`core/tests`. The desktop shell is under `src/`, `electron/`, `src-tauri/`, and
`python-sidecar/`.

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
