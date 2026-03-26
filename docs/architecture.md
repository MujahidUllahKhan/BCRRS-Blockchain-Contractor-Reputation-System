BCRRS System Architecture
Contract Interaction Flow
```
Project Owner                Inspector              Authority
     │                           │                      │
     │ registerProject()         │                      │ certifyInspector()
     │──────────────────────────────────────────────────►│
     │                           │                      │
     │ assignInspector()         │                      │
     │──────────────────────────►│                      │
     │                           │                      │
     │ createMilestone()         │                      │
     │──────────────────────────►│                      │
     │                           │                      │
     │                    completeMilestone()            │
     │                    (inspector attests)            │
     │                           │                      │
     │                    ProjectMilestone.sol           │
     │                           │ recordMilestone()     │
     │                           │──────────────────►    │
     │                           │             ReputationLedger.sol
     │                           │             (immutable update)
```
Key Design Decisions
Why separate ContractorRegistry from ReputationLedger?
Separation of concerns:
`ContractorRegistry` is identity — who the contractor is
`ReputationLedger` is evidence — what they have done
This allows the identity layer to be upgraded (e.g., adding biometric hashes)
without touching the immutable score history.
Why can only the inspector call completeMilestone()?
The inspector is the only party with no financial stake in the milestone outcome:
The contractor wants a high score
The owner wants the work done quickly
The inspector is certified independently by the authority, creating a trusted
third-party attestation layer analogous to a notary in legal systems.
Why record bid snapshots on-chain?
Anti-nepotism: once a project is registered, the top-3 bidder DIDs and their
BCRRS scores at bid time are permanently recorded. If the eventual awardee
scored significantly lower than the top bidder, this discrepancy is publicly
visible and cannot be erased — deterring nepotistic award decisions.
Why use keccak256 hashes for documents?
BCRRS does not store documents on-chain (gas cost prohibitive). Instead,
it stores cryptographic commitments. If a document is later disputed,
any party can hash it and compare to the on-chain commitment. A mismatch
is cryptographically provable fraud.
Metric Computation
The ML ranking engine (off-chain) reads `ReputationLedger.getProfile(did)`
and computes the four BCRRS metrics:
```
SPI = (onTimeMilestones / totalMilestones) × (1 − avgDelaySecs / deltaMax)
DDS = qualityScoreSum / totalMilestones                    [0 to 100]
MCR = materialCompliantCount / totalMilestones             [0 to 1]
FCI = 1 − (disputeCount / totalMilestones)                 [0 to 1]
```
These four values feed into TOPSIS multi-criteria ranking, and separately
into a Random Forest classifier for underperformance risk prediction.
Geographic Tier Codes
BCRRS uses ISO 3166-2 codes for geographic tiers:
Level	Example	Description
National	`US`, `PK`, `SA`	Country-level
State/Province	`US-NM`, `PK-KP`, `SA-RI`	State or province
Municipal	`US-NM-LC`	City or municipality
A contractor may be ranked at multiple tiers simultaneously if they
have completed ≥3 verified projects at each tier.
