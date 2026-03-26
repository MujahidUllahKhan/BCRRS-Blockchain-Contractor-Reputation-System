BCRRS ML Ranking Engine
Python implementation of the complete machine learning pipeline for:
> **"A Blockchain-Based Dynamic Contractor Reputation and Ranking System with Machine Learning for Transparent Construction Procurement"**
> Mujahid Ullah Khan Afridi — Department of Industrial Engineering, New Mexico State University
---
What This Does
This script reads contractor performance data derived from BCRRS smart contracts and produces:
Complexity-weighted metrics (SPI, DDS, MCR, FCI) per contractor
TOPSIS multi-criteria ranking — ranked contractor list with scores
Random Forest risk flags — underperformance probability per contractor
Sensitivity analysis — Kendall τ stability across weight perturbations
Monte Carlo validation — 500-trial robustness test
---
Data Flow
All inputs come from on-chain data. Nothing is self-reported.
```
ContractorRegistry.sol          ProjectMilestone.sol        ReputationLedger.sol
       │                                │                           │
  Category enum               contractValue                  getProfile(did)
  (RESIDENTIAL=1              plannedDate                    → SPI accumulators
   COMMERCIAL=2               actualDate                     → DDS accumulators
   INFRASTRUCTURE=3           milestoneId                    → MCR accumulators
   INDUSTRIAL=4)                                             → FCI accumulators
       │                                │                           │
       └───────────────────────────────►│◄──────────────────────────┘
                                        │
                              bcrrs_ranking.py
                                        │
                            ┌───────────▼───────────┐
                            │  w_j complexity weight │
                            │  α·log(V/Vref)         │
                            │  + β·TechClass         │
                            │  + γ·Duration          │
                            └───────────┬───────────┘
                                        │
                            ┌───────────▼───────────┐
                            │  TOPSIS ranking        │
                            │  [SPI, DDS, MCR, FCI]  │
                            │  weights [.30,.25,.25,.20]│
                            └───────────┬───────────┘
                                        │
                            ┌───────────▼───────────┐
                            │  Random Forest risk    │
                            │  SPI<0.70 & DDS<65     │
                            └───────────┬───────────┘
                                        │
                                  Ranked list
```
---
Installation
Requirements: Python 3.9+
```bash
pip install -r requirements.txt
```
---
Usage
Basic demo (8 contractors)
```bash
python bcrrs_ranking.py
```
Full CPEC case study (50 contractors)
```bash
python bcrrs_ranking.py --cpec
```
With sensitivity analysis (produces Table V of the paper)
```bash
python bcrrs_ranking.py --cpec --sensitivity
```
Export results to CSV
```bash
python bcrrs_ranking.py --cpec --export results.csv
```
---
Sample Output
```
BCRRS ML Ranking Engine
======================================================================
  BCRRS TOPSIS Ranking  (α=0.5, β=0.3, γ=0.2)
======================================================================
Rank  Name                    TOPSIS    SPI    DDS    MCR    FCI  Risk
----------------------------------------------------------------------
1     Contractor-G2           0.9518  0.918   88.1  0.920  0.956
2     Contractor-A2           0.9192  0.837   86.6  1.000  0.958
3     Contractor-U2           0.9180  0.833   87.9  1.000  0.956
...
41    Contractor-Q1           0.2434  0.000   48.7  0.783  0.654 [!]
42    Contractor-H2           0.2328  0.000   50.4  0.703  0.716 [!]
...

Risk flags: 10 / 50 contractors flagged

======================================================================
  Sensitivity Analysis
======================================================================

Grid perturbation (±20% per parameter):
Param    Dir        α     β     γ  Kendall τ  p-value
-------------------------------------------------------
alpha    up      0.60  0.30  0.20     0.9935   0.0000
alpha    down    0.40  0.30  0.20     0.9184   0.0000
beta     up      0.50  0.36  0.20     0.9886   0.0000
beta     down    0.50  0.24  0.20     0.9135   0.0000
gamma    up      0.50  0.30  0.24     0.9951   0.0000
gamma    down    0.50  0.30  0.16     1.0000   0.0000

Monte Carlo (500 random weight triples):
  Mean Kendall τ : 0.8800
  Std Kendall τ  : 0.0924
  Min Kendall τ  : 0.5853

  Ranking stability verdict: STABLE (τ=0.8800)
```
---
Metrics Explained
Metric	Full Name	Formula	Source
SPI	Schedule Performance Index	`(onTime/total) × (1 − avgDelay/δmax)`	`ReputationLedger`
DDS	Defect Density Score	`qualityScoreSum / totalMilestones`	`ReputationLedger`
MCR	Material Compliance Rate	`compliantCount / totalMilestones`	`ReputationLedger`
FCI	Financial Conduct Index	`1 − disputeCount / totalMilestones`	`ReputationLedger`
---
Complexity Weight Parameters
Parameter	Default	Controls
`α` (alpha)	0.50	Weight on log(contract value)
`β` (beta)	0.30	Weight on technical class (1–4)
`γ` (gamma)	0.20	Weight on project duration
`V_ref`	$1,000,000	Reference contract value
These are expert-elicited baseline values validated by sensitivity analysis.
See Section XI of the paper for full validation results.
---
TOPSIS Criteria Weights
Metric	Weight	Rationale
SPI	0.30	Schedule failure is the most publicly visible problem
DDS	0.25	Quality is equally important to material compliance
MCR	0.25	Material fraud is a primary CPEC fraud vector
FCI	0.20	Financial conduct is a secondary signal
---
Risk Flag Threshold
A contractor is flagged for underperformance risk when:
```
SPI < 0.70  AND  DDS < 65
```
Both conditions must be true simultaneously. This is the Random Forest
classifier's decision boundary, trained on 1,000 synthetic samples
calibrated from CPEC audit distributions (cross-validated AUC: 1.000
on simulation data).
---
DRC Corrections
If `DisputeRegistry.sol` has issued a correction for a milestone,
the function `effective_milestone_values()` substitutes the corrected
quality score and material compliance flag before computing metrics.
The original on-chain values are never modified — this mirrors the
immutability-preserving design of `DisputeRegistry.sol`.
---
File Structure
```
ml/
├── bcrrs_ranking.py      — complete ML pipeline
├── requirements.txt      — Python dependencies
└── README.md             — this file
```
---
Citation
```bibtex
@article{afridi2025bcrrs,
  title   = {A Blockchain-Based Dynamic Contractor Reputation and Ranking
             System with Machine Learning for Transparent Construction Procurement},
  author  = {Afridi, Mujahid Ullah Khan and Kwakye, Janet and Sohn, Hansuk},
  journal = {[Journal name — update after acceptance]},
  year    = {2025},
  note    = {Code: https://github.com/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System}
}
```
---
License
MIT — see root LICENSE for details.
