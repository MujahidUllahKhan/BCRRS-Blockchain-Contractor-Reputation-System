# BCRRS — Blockchain-based Contractor Reputation and Ranking System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue)](https://soliditylang.org)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.22.17-orange)](https://hardhat.org)

Smart contract implementation for the paper:

> **"A Blockchain-Based Dynamic Contractor Reputation and Ranking System with Machine Learning for Transparent Construction Procurement"**
> Mujahid Ullah Khan Afridi — Department of Industrial Engineering, New Mexico State University
> *[Journal/Conference name — update after acceptance]*

---

## Overview

BCRRS is a decentralized infrastructure that records every construction project milestone's schedule adherence, quality inspection scores, and material-compliance events as immutable on-chain transactions. A multi-criteria ML ranking engine (TOPSIS + Random Forest) uses this verified data to produce dynamic, tamper-proof contractor reputation scores.

### Key Features

- **Immutable performance records** — milestone completions attested by certified independent inspectors
- **Four reputation metrics** — SPI, DDS, MCR, FCI computed from on-chain data
- **Specialization categories** — Residential, Commercial, Infrastructure, Industrial
- **Geographic tiers** — National → State/Province → Municipality
- **Annual league rankings** — promotion/relegation with Soulbound Token badges
- **Anti-nepotism mechanisms** — bid snapshot, deviation alerts, justification hash commitment
- **Cross-border contractor intelligence** — globally queryable Contractor Intelligence Passport
- **Seven attack vector mitigations** — AV-1 through AV-7 documented and addressed

---

## System Architecture

```
Layer 1: User Interface (Owner Portal · Contractor Portal · Public Leaderboard)
          ↓
Layer 2: ML Ranking Engine (SPI · DDS · MCR · FCI · TOPSIS · Random Forest)
          ↓
Layer 3: Smart Contracts
          ├── ContractorRegistry.sol   — identity & onboarding
          ├── ProjectMilestone.sol     — evidence collection
          └── ReputationLedger.sol     — score aggregation
          ↓
Layer 4: Blockchain Ledger (Hyperledger Besu / Ethereum)
```

---

## Smart Contracts

| Contract | Responsibility | Key Functions |
|---|---|---|
| `ContractorRegistry.sol` | Identity registry, Sybil prevention | `register()`, `deactivate()`, `reactivate()` |
| `ProjectMilestone.sol` | Inspector management, milestone attestation, bid snapshot | `certifyInspector()`, `registerProject()`, `completeMilestone()` |
| `ReputationLedger.sol` | Score aggregation, annual snapshots, deviation logging | `recordMilestone()`, `takeYearlySnapshot()`, `recordDeviationEvent()` |

---

## Quick Start

### Requirements

- Node.js 18+
- npm 9+

### Installation

```bash
git clone https://github.com/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System
cd BCRRS
npm install
```

### Compile

```bash
npx hardhat compile
```

### Run Tests + Gas Measurements

```bash
# All tests
npx hardhat test

# With gas report (generates Table III of the paper)
REPORT_GAS=true npx hardhat test

# Or using npm script
npm run gas
```

### Deploy Locally

```bash
npm run deploy:local
```

### Deploy to Sepolia Testnet

Create a `.env` file:

```env
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_PROJECT_ID
PRIVATE_KEY=your_private_key_here_without_0x
CMC_API_KEY=your_coinmarketcap_api_key      # optional, for USD gas costs
ETHERSCAN_API_KEY=your_etherscan_api_key    # optional, for verification
```

Then deploy:

```bash
npm run deploy:sepolia
```

---

## Gas Measurements (Table III of the paper)

Run `npm run gas` to reproduce the gas measurements. Output is saved to `gas-report.txt`.

| Contract | Function | Approximate Gas |
|---|---|---|
| ContractorRegistry | `register()` | ~182,000 |
| ContractorRegistry | `deactivate()` | ~42,000 |
| ProjectMilestone | `assignInspector()` | ~47,000 |
| ProjectMilestone | `completeMilestone()` | ~157,000 |
| ReputationLedger | `recordMilestone()` | ~99,000 |
| ReputationLedger | `getProfile()` (view) | 0 |

> At 1 gwei gas price on a permissioned Besu network and ETH at $3,000,
> `completeMilestone()` costs approximately **$0.47** per attestation.

---

## Reputation Metrics

All four BCRRS metrics are computed off-chain from on-chain data
returned by `ReputationLedger.getProfile()`:

| Metric | Formula | Range |
|---|---|---|
| **SPI** (Schedule Performance Index) | `onTimeMilestones / total × (1 − avgDelay / δmax)` | [0, 1] |
| **DDS** (Defect Density Score) | `qualityScoreSum / totalMilestones` | [0, 100] |
| **MCR** (Material Compliance Rate) | `materialCompliantCount / totalMilestones` | [0, 1] |
| **FCI** (Financial Conduct Index) | `1 − disputeCount / totalMilestones` | [0, 1] |

On-chain view functions (`computeSPI`, `computeDDS`, `computeMCR`, `computeFCI`)
are also provided in `ReputationLedger.sol` for convenience — these consume zero gas.

---

## Attack Vectors Mitigated

| AV | Name | Mitigation Contract |
|---|---|---|
| AV-1 | Fabricated References | `ReputationLedger` — only inspector-attested milestones count |
| AV-2 | Inspector Collusion | `ProjectMilestone` — inspectors certified independently by authority |
| AV-3 | Material Substitution Fraud | `ProjectMilestone` — material hash + inspector attestation |
| AV-4 | Sybil Registration | `ContractorRegistry` — `licenseHashToDID` prevents re-registration |
| AV-5 | Collusive Bidding | Public leaderboard makes collusion statistically detectable |
| AV-6 | Nepotistic Score Manipulation | `ReputationLedger.recordDeviationEvent()` — permanent audit trail |
| AV-7 | Bid Document Tampering | Future `BidRegistry.sol` (see Future Work in paper) |

---

## Repository Structure

```
BCRRS/
├── contracts/
│   ├── ContractorRegistry.sol   — contractor identity and onboarding
│   ├── ProjectMilestone.sol     — inspector management and milestone attestation
│   └── ReputationLedger.sol     — score aggregation and annual snapshots
├── scripts/
│   └── deploy.js                — one-command deployment script
├── test/
│   └── bcrrs.test.js            — full test suite with gas measurements
├── docs/
│   └── architecture.md          — system architecture documentation
├── hardhat.config.js
├── package.json
└── README.md
```

---

## Deployed Contracts (Testnet)

| Contract | Network | Address |
|---|---|---|
| ContractorRegistry | Sepolia | *[update after deployment]* |
| ReputationLedger | Sepolia | *[update after deployment]* |
| ProjectMilestone | Sepolia | *[update after deployment]* |

---

## Citation

If you use this code in your research, please cite:

```bibtex
@article{afridi2025bcrrs,
  title   = {A Blockchain-Based Dynamic Contractor Reputation and Ranking
             System with Machine Learning for Transparent Construction Procurement},
  author  = {Afridi, Mujahid Ullah Khan},
  journal = {[Journal name]},
  year    = {2025},
  note    = {Code: https://github.com/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System}
}
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.
