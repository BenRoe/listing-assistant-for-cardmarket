# Live-site testing with Playwright

Firefox cannot load extensions in Playwright, so tests use headed Chromium with the extension loaded unpacked. Extension code is plain MV3 JavaScript and runs in both browsers.

## Setup used

`/tmp/pw-cm/cli.config.json`:

```json
{
  "browser": {
    "browserName": "chromium",
    "userDataDir": "/home/ben/.cache/cm-profile",
    "launchOptions": {
      "headless": false,
      "args": [
        "--disable-extensions-except=<path-to-extension>",
        "--load-extension=<path-to-extension>"
      ]
    }
  }
}
```

Start: `playwright-cli open <url> --config /tmp/pw-cm/cli.config.json --headed --persistent`

## Notes

- Cardmarket serves a Cloudflare challenge ("Just a moment...", HTTP 403) to the automated browser; the user solves it and logs in manually in the visible window. The login cookies live in the persistent profile.
- Drive the page with `playwright-cli eval "<js>"`. The CLI writes snapshots/logs to `.playwright-cli/` in the current directory; that folder is git-ignored here.
- Never submit listing forms during tests without explicit consent. Opening the modal and filling it is safe.
- A fetch/XHR hook plus MutationObserver injected through `eval` before clicking submit was used to record the submit flow, see [submit-test.md](submit-test.md).

## Cleanup after a session

- Delete `~/.cache/cm-profile` (contains the login session).
- Delete any `.playwright-cli/` folders the CLI created (snapshots contain full page text of the logged-in account).
- Delete test listings on Cardmarket.
