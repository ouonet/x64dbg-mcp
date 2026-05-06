# Security Policy

## Supported Versions

Security fixes are applied to the latest released version on the default branch.
Older releases may not receive backports.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use one of these private channels instead:

- GitHub Security Advisories for this repository, if enabled
- A private maintainer contact published in the repository profile or project homepage

When reporting, include:

- A clear description of the issue
- Affected version or commit
- Reproduction steps or proof of concept
- Impact assessment
- Any suggested mitigation

You can expect acknowledgement, triage of severity and scope, and a coordinated fix plan when the issue is confirmed.

## Scope Notes

This project interacts with debuggers, binary analysis workflows, downloaded toolchains, and local automation. Security reports are especially helpful for issues involving:

- Authentication or authorization flaws in the bridge
- Unsafe file deployment or path handling
- Insecure update or download behavior
- Code execution risks beyond the intended local debugging model
- Sensitive data exposure through logs, config, or transport handling