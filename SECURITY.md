# SECURITY POLICY

_Last reviewed: 2026-05-26_

This repository maintains a security posture consistent with enterprise vulnerability management practices. It includes supported security update tracks, a structured off-band vulnerability reporting mechanism, and documented triage and mitigation service levels.

## Supported Versions Matrix

| Version / Release Track | Security Updates | Feature Additions | Security Patch Backports | Notes |
|---|---:|---:|---:|---|
| `main` (current development) | ✅ | ✅ | N/A (patches land directly) | Preferred branch for verification. |
| Latest tagged release (LTS-style) | ✅ | ⚠️ (limited) | ✅ | Receives backports after validation; feature additions follow release governance. |
| Prior tagged release (active maintenance window) | ✅ | ❌ | ✅ | Receives only security fixes and dependency security upgrades. |
| Older releases | ❌ | ❌ | ❌ | Only addressed if a supported release track is applicable. |

**Policy rationale:** The repository treats security updates as a first-class release objective. Backports are limited to fixes that are demonstrably safe, tested, and compatible with the target branch.

## Vulnerability Reporting Protocol

The security team accepts reports only through controlled channels to prevent public disclosure and to enable coordinated remediation.

### Preferred method: Private Vulnerability Reporting

Submit vulnerabilities via GitHub’s **Private Vulnerability Reporting** mechanism:

1. Use the repository’s GitHub **security** interface.
2. Choose **Private Vulnerability Reporting**.
3. Provide a minimal reproduction, impact description, and any relevant environment details.

### Alternative method: Simulated secure email channel

If GitHub Private Vulnerability Reporting is unavailable, contact:

**security-triage@example.com**

### What to include in your report

- A concise summary of the issue and observed impact
- Affected versions or branches
- Steps to reproduce (preferably minimal)
- Expected vs. actual behavior
- Any logs or non-sensitive evidence
- A suggested severity assessment (if known)

### What not to do

- Do **not** open a public issue describing a vulnerability
- Do **not** publish exploit code or technical details before the team has completed coordinated disclosure

### Off-band confidentiality expectations

All reports are handled as confidential until a coordinated fix is released or the issue is otherwise resolved.

## Triage & Mitigation SLA

The repository follows an enterprise-grade service level agreement for vulnerability intake and remediation. Times are measured from the moment a report is received through the approved channels.

| Stage | Target Time | Outcome |
|---|---:|---|
| Acknowledgment | **≤ 48 hours** | Confirmation that the report was received and a named triage owner is assigned. |
| Initial triage complete | **≤ 5 business days** | Classification (security / non-security), affected components, preliminary impact, and proposed remediation path. |
| Severity and risk validation | **≤ 10 business days** | Confirm severity rating and validate whether mitigation is required immediately. |
| Mitigation delivery target | **≤ 7 days** (for high severity) / **≤ 30 days** (for medium severity) | A tested mitigation PR or configuration change (e.g., feature flag, hardening, patch release candidate). |
| Fix verification and rollout | **≤ 15 business days** (high) / **≤ 45 business days** (medium) | Verified fix merged and released to supported tracks. |
| Closure and disclosure | **Coordinated timeline** | Public advisory only after fix availability and retesting; otherwise, closure remains confidential. |

### Mitigation delivery standards

Mitigation PRs must include:
- Tests or validation steps
- Backward compatibility assessment
- Documentation updates where required
- Evidence that the change does not introduce new security regressions

## Security Hardening Expectations

This repository expects contributors to:
- Keep dependencies updated using the existing CI workflows
- Avoid hardcoding sensitive values in source code
- Use environment-based configuration and secret management
- Perform security-relevant code review and regression testing for any changes touching authentication, authorization, crypto, or data validation

## Contact and Ownership

For security governance, the repository designates an internal triage owner responsible for:
- Routing reports to relevant maintainers
- Coordinating fix and verification
- Ensuring disclosure decisions are consistent with the SLA

When reporting, include enough information for verification without sharing unnecessary sensitive details.


