# WorkLens / ChromeBoost — build & release

Extension ID: `giilognapghfgeifheoiipaenikdiflf`
Fleet updates from: `https://raw.githubusercontent.com/biotecnika/chromeboost-new/main/update.xml`
(Google Workspace force-installs by that update URL.)

## Source of truth
`wl-ext/` in this repo is the authoritative extension source (manifest.json holds the
version AND the `key` that fixes the extension ID). Edit here. Current live: **2.2.9**.

## Two-thread workflow (IMPORTANT)
The code-signing key (`wl.pem`) is **NOT in this repo** and must never be committed here
(this is a public repo). Signing is done only in the thread/environment that holds the key.

- **Code-change thread:** pull `wl-ext/`, make changes, bump `version` in
  `wl-ext/manifest.json` (must be higher than live), commit + push the **source only**.
  Do NOT try to produce the final `.crx` — you can't sign it correctly without the key.
  (Do NOT use the `crx3` CLI: its `-k` flag silently signs with a random key — this broke 2.2.7.)
- **Signing thread (holds `wl.pem`):** pull, pack + sign `wl-ext/` with `wl.pem`, verify the
  signing-key-derived ID == `giilognapghfgeifheoiipaenikdiflf` and the signature is valid,
  commit the new `worklens-extension-<ver>.crx`, then bump `update.xml` (codebase + version).

## Signing (reference)
Use the Python CRX3 packer (not crx3 CLI). It reads `wl-ext/` + `wl.pem`, writes
`worklens-extension-<ver>.crx`, and prints the ID + signature check. Full script and a
copy of the key live in the owner's offline kit / Google Drive backup, not here.
