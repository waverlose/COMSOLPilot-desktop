# Tauri Release

COMSOLPilot Desktop uses Tauri as the only official desktop release path.
Electron remains available for compatibility development and is not packaged or
published by the release workflow.

## Signed updates

The updater reads:

`https://github.com/waverlose/COMSOLPilot-desktop/releases/latest/download/latest.json`

The public key is embedded in `src-tauri/tauri.conf.json`. Keep the matching
private key out of git and configure these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Generate a key pair locally with:

```text
npm run signer:generate
```

The release workflow then creates signed NSIS/MSI artifacts and the updater
metadata. The Settings page can check, download, install, and restart into the
new version.
