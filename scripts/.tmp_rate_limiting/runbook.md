# Rate Limiting Load Simulation

**Timestamp:** 2026-05-18T11:50:03Z

## Verification Results
- Method: Node harness mirroring RateLimitingService sliding-window logic
- Verdict: PASS

## Protection Score Sheet
| Metric | Value |
|---|---|
| MaxRequests | 5 |
| BurstCount | 20 |
| Allowed200 | 5 |
| Rejected429 | 15 |
| Determinism | deterministic window-bound behavior |

Runbook output: /home/oajj2/Desktop/universal-trust-layer/scripts/.tmp_rate_limiting/runbook.md
