# BCRRS — Blockchain-based Contractor Reputation and Ranking System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue)](https://soliditylang.org)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.22.17-orange)](https://hardhat.org)
[![Tests](https://img.shields.io/badge/Tests-26%20passing-brightgreen)]()
[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System/blob/main/ml/BCRRS_CPEC_Simulation.ipynb)

Smart contract and ML implementation for the paper:

> **"A Blockchain-Based Dynamic Contractor Reputation and Ranking System with Machine Learning for Transparent Construction Procurement"**  
> Mujahid Ullah Khan Afridi and Hansuk Sohn  
> Department of Industrial Engineering, New Mexico State University  
> *Target: IEEE Access*

---

## Overview

BCRRS is a decentralized infrastructure that records every construction project milestone's schedule adherence, quality inspection scores, and material-compliance events as immutable on-chain transactions. A multi-criteria ML ranking engine (TOPSIS + Random Forest) uses this verified data to produce dynamic, tamper-proof contractor reputation scores.

### Key Features

- **Four production-ready smart contracts** — ContractorRegistry, ProjectMilestone, ReputationLedger, DisputeRegistry
- **Immutable performance records** — milestone completions attested by certified independent inspectors
- **Four reputation metrics** — SPI, DDS, MCR, FCI computed from on-chain data
- **Complexity-adjusted TOPSIS ranking** — weighted by contract value, technical class, and duration
- **Specialization categories** — Residential, Commercial, Infrastructure, Industrial
- **Geographic tiers** — National → State/Province → Municipality
- **Annual league rankings** — promotion/relegation with Soulbound Token badges
- **Anti-nepotism mechanisms** — bid snapshot, deviation alerts, justification hash commitment
- **Dispute Resolution Framework** — multi-signature DRC with additive on-chain corrections
- **Encrypted sealed-bid framework** — commit-reveal scheme preventing bid collusion
- **Cross-border contractor intelligence** — globally queryable Contractor Intelligence Passport (CIP)
- **Nine attack vector mitigations** — AV-1 through AV-9 documented and addressed

---

## System Architecture

```
Layer 1: User Interface
         (Owner Portal · Contractor Portal · Public Leaderboard · Dispute Portal)
              ↓
Layer 2: ML Ranking Engine
         (SPI · DDS · MCR · FCI · TOPSIS · Random Forest · DRC Corrections)
              ↓
Layer 3: Smart Contracts
         ├── ContractorRegistry.sol   — identity & onboarding
         ├── ProjectMilestone.sol     — evidence collection & bid snapshots
         ├── ReputationLedger.sol     — score aggregation & deviation logging
         └── DisputeRegistry.sol      — dispute resolution & correction events
              ↓
Layer 4: Blockchain Ledger (Hyperledger Besu IBFT 2.0 / Ethereum)
```

---

## Smart Contracts

| Contract | Responsibility | Key Functions |
|----------|---------------|---------------|
| `ContractorRegistry.sol` | Identity registry, Sybil prevention (AV-4) | `register()`, `deactivate()`, `reactivate()`, `isActive()` |
| `ProjectMilestone.sol` | Inspector management, milestone attestation, bid snapshot (AV-2, AV-3) | `certifyInspector()`, `registerProject()`, `assignInspector()`, `createMilestone()`, `completeMilestone()`, `getBidSnapshot()` |
| `ReputationLedger.sol` | Score aggregation, annual snapshots, deviation logging (AV-6) | `recordMilestone()`, `takeYearlySnapshot()`, `recordDeviationEvent()`, `getProfile()`, `computeSPI()`, `computeDDS()`, `computeMCR()`, `computeFCI()` |
| `DisputeRegistry.sol` | Dispute filing, DRC voting, correction events, court escalation (AV-8) | `fileDispute()`, `openForReview()`, `castVote()`, `issueCorrectionValues()`, `escalateToCourt()`, `getMilestoneCorrection()` |

All write functions are protected by role-based modifiers: `onlyAuthority`, `onlyMilestoneContract`, `onlyCertifiedInspector`, `onlyDRCMember`.

---

## Quick Start

### Requirements

- Node.js 18+
- npm 9+

### Installation

```bash
git clone https://github.com/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System.git
cd BCRRS-Blockchain-Contractor-Reputation-System
npm install
```

### Compile

```bash
npx hardhat compile
```

### Run Tests

```bash
# All 26 tests
npx hardhat test

# With gas report (reproduces Table V of the paper)
REPORT_GAS=true npx hardhat test

# 50-run gas measurement (reproduces exact Table V medians)
bash scripts/run_gas_50.sh
```

### Deploy Locally

```bash
npm run deploy:local
```

---

## Gas Measurements — Table V of the Paper (n=50)

Run `bash scripts/run_gas_50.sh` to reproduce. All values are medians of 50 automated runs.

| Contract | Function | Min (Gas) | Max (Gas) | Median (Gas) | ≈ USD |
|----------|----------|-----------|-----------|-------------|-------|
| ContractorRegistry | `register()` | 295,036 | 295,036 | **295,036** | $0.89 |
| ContractorRegistry | `deactivate()` | 30,190 | 30,190 | **30,190** | $0.09 |
| ProjectMilestone | `assignInspector()` | 50,857 | 50,857 | **50,857** | $0.15 |
| ProjectMilestone | `completeMilestone()` | 291,995 | 291,995 | **291,995** | $0.88 |
| DisputeRegistry | `fileDispute()` | 212,143 | 212,143 | **212,143** | $0.64 |
| DisputeRegistry | `castVote()` | 99,432 | 99,456 | **99,456** | $0.30 |
| DisputeRegistry | `issueCorrectionValues()` | 264,949 | 264,973 | **264,973** | $0.79 |
| DisputeRegistry | `escalateToCourt()` | 46,738 | 46,750 | **46,750** | $0.14 |
| View functions | `getProfile()`, `getMilestoneCorrection()` | — | — | **0** | $0.00 |

> USD estimates at 1 gwei gas price on Besu with ETH at $3,000.  
> Near-zero variance confirms deterministic EVM execution cost.

---

## ML Ranking Engine

### Reputation Metrics (Eqs. 3–6)

All four metrics are computed off-chain from on-chain data returned by `ReputationLedger.getProfile()`:

| Metric | Formula | Range |
|--------|---------|-------|
| **SPI** (Schedule Performance Index) | `(onTimeMilestones / total) × (1 − avgDelay / δ_max)` | [0, 1] |
| **DDS** (Defect Density Score) | `qualityScoreSum / totalMilestones` | [0, 100] |
| **MCR** (Material Compliance Rate) | `materialCompliantCount / totalMilestones` | [0, 1] |
| **FCI** (Financial Conduct Index) | `1 − disputeCount / totalMilestones` | [0, 1] |

### Complexity Weight (Eq. 7)

```
w_j = α·log(V_j / V_ref) + β·TechClass(p_j) + γ·Duration(p_j)
```

Baseline: α=0.50, β=0.30, γ=0.20 | V_ref = $1,000,000 | T_max = 36 months

### TOPSIS Ranking (Eqs. 9–15)

Weights: SPI=0.30, DDS=0.25, MCR=0.25, FCI=0.20

### CPEC Case Study (Section XIII)

The `ml/` directory contains a fully reproducible simulation:

- **50 contractors**, 3 categories, 2 geographic tiers (PK-KP, PK-PB)
- **73 projects** (8 cross-category), **178 milestones**
- **8 dispute filings** (4 upheld, 4 rejected) by 3 contractors
- DRC corrections improve affected ranks by **2–6 positions**
- Kendall's τ (score perturbation): **0.97**
- Kendall's τ (DRC corrections): **0.99**
- Grid perturbation min τ: **0.997** (Table VI)
- Monte Carlo (500 trials) mean τ: **0.996**, min: **0.987**, 0% below 0.80

**All results reproducible with seed = 42.**

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System/blob/main/ml/BCRRS_CPEC_Simulation.ipynb)

---

## Attack Vectors Mitigated

| AV | Name | Mitigation |
|----|------|-----------|
| AV-1 | Fabricated References | `ReputationLedger` — only inspector-attested milestones count |
| AV-2 | Inspector Collusion | `ProjectMilestone` — inspectors certified independently by authority |
| AV-3 | Material Substitution Fraud | `ProjectMilestone` — materialHash + inspector attestation |
| AV-4 | Sybil Registration | `ContractorRegistry` — `licenseHashToDID` prevents re-registration |
| AV-5 | Collusive Bidding | Public leaderboard makes collusion statistically detectable |
| AV-6 | Nepotistic Score Manipulation | `ReputationLedger.recordDeviationEvent()` — permanent audit trail |
| AV-7 | Bid Document Tampering | `BidRegistry.sol` — keccak256 hash anchoring at submission |
| AV-8 | Fraudulent Dispute Flooding | `DisputeRegistry` — `MAX_ACTIVE_DISPUTES = 3` per contractor |
| AV-9 | Bid Collusion via Visible Amounts | Commit-reveal sealed-bid framework (Section X of paper) |

---

## Dispute Resolution Framework

The `DisputeRegistry.sol` contract implements a five-state dispute lifecycle:

```
FILED → UNDER_REVIEW → UPHELD → (Correction issued)
                     → REJECTED → (Contractor may escalate)
                                → ESCALATED (court evidence)
```

- **Multi-signature governance**: 3-of-5 DRC member votes required
- **Immutability preserved**: original records never modified; corrections are additive
- **Court escalation path**: full on-chain record as admissible electronic evidence
- **Rate limiting**: max 3 simultaneous active disputes per contractor (AV-8)

---

## Repository Structure

```
BCRRS-Blockchain-Contractor-Reputation-System/
├── contracts/
│   ├── ContractorRegistry.sol    — contractor identity and onboarding
│   ├── ProjectMilestone.sol      — inspector management and milestone attestation
│   ├── ReputationLedger.sol      — score aggregation and annual snapshots
│   └── DisputeRegistry.sol       — dispute resolution and correction events
├── scripts/
│   ├── deploy.js                 — one-command deployment script
│   └── run_gas_50.sh             — 50-run gas measurement (Table V)
├── test/
│   └── bcrrs.test.js             — 26 passing tests with gas measurements
├── ml/
│   ├── cpec_simulation.py        — CPEC case study simulation (seed=42)
│   ├── BCRRS_CPEC_Simulation.ipynb — Google Colab notebook (run all figures)
│   ├── cpec_contractors.csv      — 50 contractors with metrics
│   ├── cpec_milestones.csv       — 178 milestones
│   ├── cpec_rankings.csv         — TOPSIS rankings
│   ├── cpec_results_report.txt   — full console output
│   ├── fig_heatmap.pdf           — Fig. 4 of the paper
│   └── fig_montecarlo.pdf        — Fig. 5 of the paper
├── docs/
│   └── architecture.md           — system architecture documentation
├── hardhat.config.js
├── package.json
└── README.md
```

---

## Reproducibility Checklist

| Artifact | How to reproduce |
|----------|-----------------|
| Smart contract tests (26 passing) | `npx hardhat test` |
| Gas measurements (Table V) | `bash scripts/run_gas_50.sh` |
| CPEC simulation (Section XIII) | `python3 ml/cpec_simulation.py` |
| All figures + verification | Open `ml/BCRRS_CPEC_Simulation.ipynb` in Colab |
| Sensitivity analysis (Table VI) | Included in cpec_simulation.py output |
| Monte Carlo (500 trials) | Included in cpec_simulation.py output |

---

## Citation

If you use this code in your research, please cite:

```bibtex
@article{afridi2025bcrrs,
  title   = {A Blockchain-Based Dynamic Contractor Reputation and Ranking
             System with Machine Learning for Transparent Construction
             Procurement},
  author  = {Afridi, Mujahid Ullah Khan and Sohn, Hansuk},
  journal = {Not decided yet},
  year    = {2026},
  note    = {Code: https://github.com/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System}
}
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
