# Security Policy — PEPAGI

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| < 0.4   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in PEPAGI, please report it responsibly:

1. **Do NOT open a public issue**
2. Contact the maintainer via GitHub (open a private security advisory)
3. Include: description, reproduction steps, severity assessment
4. Expected response time: 48 hours acknowledgment, 7 days initial fix

## Threat Model Summary

PEPAGI implements a **35-category security threat model** based on 29+ CVEs, 14+ independent audits, and 20+ academic papers on AI agent security (2024-2026).

### Architecture

```
User Input → InputSanitizer (SEC-01) → ContextBoundary → Mediator
                                                           │
                    ┌──────────────────────────────────────┘
                    ▼
              SecurityGuard ─── CostTracker (SEC-13)
                    │           CredentialLifecycle (SEC-25)
                    ▼           TLSVerifier (SEC-27)
              AgentPool ─────── AgentAuthenticator (SEC-18)
                    │           AgentIdentity (SEC-20)
                    ▼
              WorkerExecutor ── ToolGuard (SEC-06)
                    │           DLPEngine (SEC-11)
                    ▼
              MemorySystem ──── MemoryGuard (SEC-17)
                    │           SafeFS (SEC-24)
                    ▼
              Output ────────── OutputSanitizer (SEC-34)
                                CredentialScrubber (SEC-02)
                                SideChannel (SEC-19)
```

### Security Categories (35)

| ID | Category | Priority | Status |
|----|----------|----------|--------|
| SEC-01 | Prompt Injection Defense | P0 | Implemented |
| SEC-02 | Credential Leakage Prevention | P0 | Implemented |
| SEC-03 | Skill Supply Chain Security | P1 | Implemented |
| SEC-04 | MCP Network Security | P2 | Implemented |
| SEC-05 | Session Isolation | P2 | Implemented |
| SEC-06 | Tool Misuse Prevention | P0 | Implemented |
| SEC-07 | Log Poisoning Defense | P2 | Implemented |
| SEC-08 | Adversarial Testing (35 categories) | P3 | Implemented |
| SEC-09 | System Prompt Protection | P2 | Implemented |
| SEC-10 | Guardrail Decay Detection | P2 | Implemented |
| SEC-11 | Data Loss Prevention | P2 | Implemented |
| SEC-12 | MCP Schema Pinning | P2 | Implemented |
| SEC-13 | Cost Explosion Kill Switch | P4 | Implemented |
| SEC-14 | Multilingual Injection Detection | P4 | Implemented |
| SEC-15 | Incident Response & Rollback | P3 | Implemented |
| SEC-16 | RAG Poisoning Defense | P1 | Implemented |
| SEC-17 | Memory Integrity & Poisoning | P0 | Implemented |
| SEC-18 | Multi-Agent Trust (HMAC) | P0 | Implemented |
| SEC-19 | Side-Channel Mitigation | P4 | Implemented |
| SEC-20 | Agent Identity & NHI | P3 | Implemented |
| SEC-21 | Autonomy Escalation Prevention | P1 | Implemented |
| SEC-22 | Context Window DoS Defense | P3 | Implemented |
| SEC-23 | MCP Protocol Validation | P1 | Implemented |
| SEC-24 | Filesystem Race Conditions | P3 | Implemented |
| SEC-25 | OAuth & Credential Delegation | P4 | Implemented |
| SEC-26 | Supply Chain Security | P4 | Implemented |
| SEC-27 | Infrastructure & TLS Security | P4 | Implemented |
| SEC-28 | Browser Automation Defense | P3 | Implemented |
| SEC-29 | Local Model Security (Ollama) | P3 | Implemented |
| SEC-30 | Platform Rate Limiting | P1 | Implemented |
| SEC-31 | Calendar Weaponization Defense | P3 | Implemented |
| SEC-32 | Consciousness Exploitation Defense | P3 | Implemented |
| SEC-33 | Cognitive Hijacking Defense | P3 | Implemented |
| SEC-34 | Output Processing Security | P1 | Implemented |
| SEC-35 | Framework Compliance | P5 | Implemented |

### Framework Compliance

| Framework | Coverage |
|-----------|----------|
| OWASP ASI (Top 10 for AI) | All 10 ASI codes mapped |
| MITRE ATLAS | Key techniques mapped |
| NIST AI 600-1 | All sections mapped |

### Key Defenses

- **Input**: 25+ injection patterns, 5-language detection, Unicode homoglyph detection, invisible character stripping
- **Authentication**: HMAC-SHA256 inter-agent messages, UUID agent identity, PKCE OAuth, task-scoped tokens
- **Runtime**: Per-user cost limits, decomposition depth caps (3 levels, 10 subtasks), rate limiting (20 calls/min)
- **Output**: Credential scrubbing, response padding, timing jitter, metadata sanitization
- **Memory**: Provenance tracking, trust levels, deduplication, contradiction detection, TOCTOU-safe I/O
- **Monitoring**: 35-category adversarial self-testing, semantic drift detection, reasoning anomaly detection, cross-model verification, watchdog agent

## Test Coverage

- 683 security-related tests across 47 test files
- 0 build errors (TypeScript strict mode)
- Automated adversarial testing runs hourly in daemon mode

## Secure Configuration

1. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`
2. Keep API keys in `~/.pepagi/config.json` (auto-encrypted by vault)
3. Ollama must bind to `localhost` only (127.0.0.1:11434)
4. Set `MCP_TOKEN` environment variable before starting MCP server
5. Pin all npm dependencies to exact versions
