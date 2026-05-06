# Contributing

Thanks for contributing to x64dbg-mcp.

## Before You Start

- Read [README.md](README.md) for project architecture, setup, and testing.
- Keep changes focused. Avoid mixing feature work, refactors, and unrelated cleanup in one pull request.
- If you change the bridge protocol between the TypeScript server and the Python bridge, update both sides together and document the change in [CHANGELOG.md](CHANGELOG.md).

## Development Setup

```bash
npm install
npm run build
npm run ci -- --no-loader
```

If you need bundled debugger assets or prebuilt loaders, use the setup scripts described in [README.md](README.md).

## Coding Expectations

- Follow the existing TypeScript, Python, and PowerShell style used in the repo.
- Prefer minimal, root-cause fixes over broad rewrites.
- Keep reusable verification scripts machine-agnostic. Do not commit local sample paths, usernames, process names, or secrets.
- Update user-facing documentation when adding or changing tools, scripts, or installation behavior.

## Tests

Run the narrowest relevant checks for your change first.

Common commands:

```bash
npm run build
npm run lint
npm test
python plugin/tests/test_bridge.py
npm run test:e2e
```

Notes:

- `npm run test:e2e` and scripts under `test/e2e/` may require explicit target selection through environment variables.
- Loader builds require Windows plus a working CMake/MSVC toolchain.

## Pull Requests

Please include:

- A clear problem statement and the change made
- Validation steps you ran
- Any platform, architecture, or debugger assumptions
- Documentation updates when behavior changes

Small, reviewable pull requests are preferred.

## Reporting Problems

- For bugs and feature requests, open a GitHub issue using the provided templates.
- For security issues, do not open a public issue. Follow [SECURITY.md](SECURITY.md).