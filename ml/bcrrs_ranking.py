"""
BCRRS ML Ranking Engine
=======================
Implements the complete machine learning pipeline for the paper:
"A Blockchain-Based Dynamic Contractor Reputation and Ranking System
 with Machine Learning for Transparent Construction Procurement"

Mujahid Ullah Khan Afridi — NMSU Industrial Engineering
Repo: https://github.com/MujahidUllahKhan/BCRRS-Blockchain-Contractor-Reputation-System

Pipeline:
  1. Load contractor profiles from on-chain data (JSON or simulated)
  2. Compute complexity weight w_j per project
  3. Compute SPI, DDS, MCR, FCI as complexity-weighted averages
  4. Run TOPSIS multi-criteria ranking
  5. Run Random Forest underperformance risk prediction
  6. Run sensitivity analysis on alpha, beta, gamma weights
  7. Compute Kendall tau for ranking stability
  8. Output ranked list with risk flags

Usage:
    python bcrrs_ranking.py                  # run full pipeline on simulated data
    python bcrrs_ranking.py --sensitivity    # run + print sensitivity analysis table
    python bcrrs_ranking.py --cpec           # run CPEC case study simulation
"""

import argparse
import json
import math
import random
import warnings
from itertools import product

import numpy as np
import pandas as pd
from scipy.stats import kendalltau
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

# ─── Constants ────────────────────────────────────────────────────────────────

# Category enum mapping (mirrors ContractorRegistry.sol)
CATEGORY_TO_TECH_CLASS = {
    "RESIDENTIAL":    1,
    "COMMERCIAL":     2,
    "INFRASTRUCTURE": 3,
    "INDUSTRIAL":     4,
}

# Reference contract value for logarithmic scaling (USD)
V_REF = 1_000_000

# Baseline complexity calibration weights (expert-elicited)
ALPHA_DEFAULT = 0.50   # weight on log(contract value)
BETA_DEFAULT  = 0.30   # weight on technical class
GAMMA_DEFAULT = 0.20   # weight on duration (normalised months)

# TOPSIS criteria weights [SPI, DDS, MCR, FCI]
TOPSIS_WEIGHTS = [0.30, 0.25, 0.25, 0.20]

# Random Forest underperformance thresholds
RF_SPI_THRESHOLD = 0.70
RF_DDS_THRESHOLD = 65.0   # out of 100

# SPI delay normalisation constant: 90 days in seconds
DELTA_MAX_SECS = 90 * 24 * 3600


# ─── Data structures ─────────────────────────────────────────────────────────

def make_contractor(did, name, category, projects):
    """
    Contractor profile as read from on-chain + event data.

    Each project contains:
        contract_value   : float (USD)
        category         : str  (matches CATEGORY_TO_TECH_CLASS)
        milestones       : list of milestone dicts, each with:
            planned_date     : int (unix timestamp)
            actual_date      : int (unix timestamp)
            quality_score    : float [0-100]
            material_compliant: bool
            dispute_raised   : bool
            corrected        : bool (True if DRC correction applied)
            corrected_quality: float (only used if corrected=True)
            corrected_material: bool (only used if corrected=True)
    """
    return {
        "did":      did,
        "name":     name,
        "category": category,
        "projects": projects,
    }


# ─── Step 1: Metric computation from on-chain data ───────────────────────────

def effective_milestone_values(ms):
    """
    Apply DRC correction if present, otherwise use original values.
    This mirrors Algorithm 1 Step 4 in the paper.
    """
    if ms.get("corrected", False):
        return (
            ms["corrected_quality"],
            ms["corrected_material"],
            ms["dispute_raised"],   # dispute flag itself is not corrected
        )
    return ms["quality_score"], ms["material_compliant"], ms["dispute_raised"]


def compute_project_duration_months(milestones):
    """Duration = span from first to last milestone timestamp, in months."""
    if len(milestones) < 2:
        return 1.0
    timestamps = [m["actual_date"] for m in milestones]
    span_secs = max(timestamps) - min(timestamps)
    return max(span_secs / (30 * 24 * 3600), 1.0)


def compute_complexity_weight(project, alpha=ALPHA_DEFAULT,
                              beta=BETA_DEFAULT, gamma=GAMMA_DEFAULT):
    """
    w_j = alpha * log(V_j / V_ref)
          + beta  * TechClass(p_j)
          + gamma * Duration(p_j) [normalised to 0-1 over 36 months]

    All three inputs come from on-chain data:
        V_j           <- contractValue stored in ProjectMilestone.sol
        TechClass     <- Category enum from ContractorRegistry.sol
        Duration      <- derived from milestone timestamps
    """
    v_j      = project.get("contract_value", V_REF)
    tech     = CATEGORY_TO_TECH_CLASS.get(project.get("category", "COMMERCIAL"), 2)
    duration = compute_project_duration_months(project.get("milestones", []))

    log_val  = math.log(max(v_j, 1) / V_REF) if v_j > 0 else 0.0
    # Normalise duration: cap at 36 months → maps to [0, 1]
    dur_norm = min(duration / 36.0, 1.0)

    w = alpha * log_val + beta * tech + gamma * dur_norm
    # Shift to be non-negative (log can go negative for small contracts)
    return max(w, 0.01)


def compute_contractor_metrics(contractor, alpha=ALPHA_DEFAULT,
                               beta=BETA_DEFAULT, gamma=GAMMA_DEFAULT):
    """
    Compute the four BCRRS metrics as complexity-weighted averages.

    Returns dict: {SPI, DDS, MCR, FCI, total_milestones, total_weight}
    """
    total_weight = 0.0
    spi_sum = dds_sum = mcr_sum = fci_sum = 0.0
    total_milestones = 0

    for project in contractor["projects"]:
        milestones = project.get("milestones", [])
        if not milestones:
            continue

        w_j = compute_complexity_weight(project, alpha, beta, gamma)

        on_time        = 0
        total_delay    = 0.0
        quality_sum    = 0.0
        compliant_count = 0
        dispute_count  = 0
        n = len(milestones)

        for ms in milestones:
            q, mat_ok, disp = effective_milestone_values(ms)
            quality_sum += q
            if mat_ok:
                compliant_count += 1
            if disp:
                dispute_count += 1

            delay_secs = max(ms["actual_date"] - ms["planned_date"], 0)
            if delay_secs == 0:
                on_time += 1
            else:
                total_delay += delay_secs

        avg_delay = total_delay / max(n - on_time, 1)
        delay_ratio = min(avg_delay / DELTA_MAX_SECS, 1.0)

        spi_proj = (on_time / n) * (1.0 - delay_ratio)
        dds_proj = quality_sum / n
        mcr_proj = compliant_count / n
        fci_proj = 1.0 - (dispute_count / n)

        spi_sum  += w_j * spi_proj
        dds_sum  += w_j * dds_proj
        mcr_sum  += w_j * mcr_proj
        fci_sum  += w_j * fci_proj
        total_weight += w_j
        total_milestones += n

    if total_weight == 0:
        return {"SPI": 0, "DDS": 0, "MCR": 0, "FCI": 0,
                "total_milestones": 0, "total_weight": 0}

    return {
        "SPI": spi_sum  / total_weight,
        "DDS": dds_sum  / total_weight,
        "MCR": mcr_sum  / total_weight,
        "FCI": fci_sum  / total_weight,
        "total_milestones": total_milestones,
        "total_weight": total_weight,
    }


# ─── Step 2: TOPSIS ───────────────────────────────────────────────────────────

def topsis(decision_matrix, weights=None, criteria_direction=None):
    """
    TOPSIS multi-criteria ranking.

    Parameters
    ----------
    decision_matrix : np.ndarray, shape (n_contractors, n_criteria)
    weights         : list of floats, sum to 1  (default: TOPSIS_WEIGHTS)
    criteria_direction : list of +1 (benefit) or -1 (cost)
                         All BCRRS metrics are benefit criteria.

    Returns
    -------
    scores : np.ndarray of relative closeness [0, 1] — higher is better
    """
    if weights is None:
        weights = TOPSIS_WEIGHTS
    if criteria_direction is None:
        criteria_direction = [1, 1, 1, 1]  # all benefit

    dm = decision_matrix.copy().astype(float)
    n, m = dm.shape

    # Step 1: Normalise
    col_norms = np.sqrt((dm ** 2).sum(axis=0))
    col_norms[col_norms == 0] = 1e-10
    norm = dm / col_norms

    # Step 2: Apply weights
    weighted = norm * np.array(weights)

    # Step 3: Ideal best and worst
    ideal_best  = np.array([
        weighted[:, j].max() if criteria_direction[j] == 1
        else weighted[:, j].min()
        for j in range(m)
    ])
    ideal_worst = np.array([
        weighted[:, j].min() if criteria_direction[j] == 1
        else weighted[:, j].max()
        for j in range(m)
    ])

    # Step 4: Euclidean distances
    d_best  = np.sqrt(((weighted - ideal_best)  ** 2).sum(axis=1))
    d_worst = np.sqrt(((weighted - ideal_worst) ** 2).sum(axis=1))

    # Step 5: Relative closeness
    scores = d_worst / (d_best + d_worst + 1e-10)
    return scores


# ─── Step 3: Random Forest risk prediction ───────────────────────────────────

def train_risk_model(contractors_metrics, seed=42):
    """
    Train a Random Forest to predict underperformance risk.

    Label = 1 if SPI < 0.70 AND DDS < 65, else 0.
    Features: [SPI, DDS, MCR, FCI, total_milestones]

    In production this would be trained on historical deployment data.
    For the paper simulation we use synthetic training data calibrated
    from the CPEC audit distributions.
    """
    random.seed(seed)
    np.random.seed(seed)

    # Synthetic training data (1000 samples, calibrated from CPEC audit)
    n_train = 1000
    X_train = np.column_stack([
        np.random.beta(4, 2, n_train),          # SPI
        np.random.normal(72, 18, n_train),       # DDS
        np.random.beta(5, 1.5, n_train),         # MCR
        np.random.beta(6, 1.5, n_train),         # FCI
        np.random.randint(3, 30, n_train),       # milestones
    ])
    X_train[:, 1] = np.clip(X_train[:, 1], 0, 100)

    y_train = (
        (X_train[:, 0] < RF_SPI_THRESHOLD) &
        (X_train[:, 1] < RF_DDS_THRESHOLD)
    ).astype(int)

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_train)

    rf = RandomForestClassifier(
        n_estimators=200,
        max_depth=6,
        min_samples_leaf=10,
        random_state=seed,
    )
    rf.fit(X_scaled, y_train)

    cv_scores = cross_val_score(rf, X_scaled, y_train, cv=5, scoring="roc_auc")

    return rf, scaler, cv_scores.mean()


def predict_risk(rf_model, scaler, metrics_dict):
    """Return underperformance risk probability for one contractor."""
    X = np.array([[
        metrics_dict["SPI"],
        metrics_dict["DDS"],
        metrics_dict["MCR"],
        metrics_dict["FCI"],
        metrics_dict["total_milestones"],
    ]])
    X_scaled = scaler.transform(X)
    return rf_model.predict_proba(X_scaled)[0][1]


# ─── Step 4: Sensitivity analysis ────────────────────────────────────────────

def run_sensitivity_analysis(contractors, perturbation=0.20,
                             n_random_samples=500, seed=42):
    """
    Validate that TOPSIS rankings are robust to variation in alpha, beta, gamma.

    Two approaches:
    (a) Grid perturbation: vary each weight ±20% one at a time
    (b) Monte Carlo: sample 500 random (alpha, beta, gamma) triples

    Returns a DataFrame with Kendall tau for every perturbation.
    """
    np.random.seed(seed)

    # Baseline ranking
    baseline_metrics = {
        c["did"]: compute_contractor_metrics(c) for c in contractors
    }
    dm_baseline = np.array([
        [baseline_metrics[c["did"]]["SPI"],
         baseline_metrics[c["did"]]["DDS"],
         baseline_metrics[c["did"]]["MCR"],
         baseline_metrics[c["did"]]["FCI"]]
        for c in contractors
    ])
    baseline_scores  = topsis(dm_baseline)
    baseline_ranking = np.argsort(-baseline_scores)

    results = []

    # ── (a) Grid perturbation ─────────────────────────────────────
    for param, base_val in [("alpha", ALPHA_DEFAULT),
                             ("beta",  BETA_DEFAULT),
                             ("gamma", GAMMA_DEFAULT)]:
        for direction, sign in [("up", 1+perturbation),
                                 ("down", 1-perturbation)]:
            a = ALPHA_DEFAULT * (sign if param == "alpha" else 1)
            b = BETA_DEFAULT  * (sign if param == "beta"  else 1)
            g = GAMMA_DEFAULT * (sign if param == "gamma" else 1)

            pert_metrics = {
                c["did"]: compute_contractor_metrics(c, a, b, g)
                for c in contractors
            }
            dm_pert = np.array([
                [pert_metrics[c["did"]]["SPI"],
                 pert_metrics[c["did"]]["DDS"],
                 pert_metrics[c["did"]]["MCR"],
                 pert_metrics[c["did"]]["FCI"]]
                for c in contractors
            ])
            pert_scores  = topsis(dm_pert)
            pert_ranking = np.argsort(-pert_scores)

            tau, pval = kendalltau(baseline_ranking, pert_ranking)
            results.append({
                "type":      "grid",
                "param":     param,
                "direction": direction,
                "alpha":     round(a, 3),
                "beta":      round(b, 3),
                "gamma":     round(g, 3),
                "kendall_tau": round(tau, 4),
                "p_value":   round(pval, 4),
            })

    # ── (b) Monte Carlo ───────────────────────────────────────────
    taus_mc = []
    for _ in range(n_random_samples):
        a = np.random.uniform(0.2, 0.8)
        b = np.random.uniform(0.1, 0.5)
        g = np.random.uniform(0.1, 0.4)

        mc_metrics = {
            c["did"]: compute_contractor_metrics(c, a, b, g)
            for c in contractors
        }
        dm_mc = np.array([
            [mc_metrics[c["did"]]["SPI"],
             mc_metrics[c["did"]]["DDS"],
             mc_metrics[c["did"]]["MCR"],
             mc_metrics[c["did"]]["FCI"]]
            for c in contractors
        ])
        mc_scores  = topsis(dm_mc)
        mc_ranking = np.argsort(-mc_scores)
        tau, _ = kendalltau(baseline_ranking, mc_ranking)
        taus_mc.append(tau)

    results.append({
        "type":        "monte_carlo",
        "param":       "all",
        "direction":   "random",
        "alpha":       None,
        "beta":        None,
        "gamma":       None,
        "kendall_tau": round(float(np.mean(taus_mc)), 4),
        "p_value":     None,
    })

    df = pd.DataFrame(results)
    return df, np.array(taus_mc)


# ─── Step 5: Full ranking pipeline ───────────────────────────────────────────

def rank_contractors(contractors,
                     alpha=ALPHA_DEFAULT,
                     beta=BETA_DEFAULT,
                     gamma=GAMMA_DEFAULT,
                     rf_model=None,
                     scaler=None,
                     verbose=True):
    """
    Full BCRRS ranking pipeline.
    Returns a list of dicts sorted by TOPSIS score descending.
    """
    all_metrics = {}
    for c in contractors:
        all_metrics[c["did"]] = compute_contractor_metrics(c, alpha, beta, gamma)

    dm = np.array([
        [all_metrics[c["did"]]["SPI"],
         all_metrics[c["did"]]["DDS"],
         all_metrics[c["did"]]["MCR"],
         all_metrics[c["did"]]["FCI"]]
        for c in contractors
    ])

    scores = topsis(dm)

    results = []
    for i, c in enumerate(contractors):
        m = all_metrics[c["did"]]
        risk_prob = (
            predict_risk(rf_model, scaler, m)
            if rf_model is not None else None
        )
        risk_flag = (
            risk_prob > 0.5 if risk_prob is not None
            else (m["SPI"] < RF_SPI_THRESHOLD and m["DDS"] < RF_DDS_THRESHOLD)
        )
        results.append({
            "did":              c["did"],
            "name":             c["name"],
            "category":         c["category"],
            "topsis_score":     round(float(scores[i]), 4),
            "SPI":              round(m["SPI"], 4),
            "DDS":              round(m["DDS"], 2),
            "MCR":              round(m["MCR"], 4),
            "FCI":              round(m["FCI"], 4),
            "total_milestones": m["total_milestones"],
            "risk_flag":        risk_flag,
            "risk_prob":        round(risk_prob, 3) if risk_prob else None,
        })

    results.sort(key=lambda x: x["topsis_score"], reverse=True)
    for i, r in enumerate(results):
        r["rank"] = i + 1

    if verbose:
        print("\n" + "="*70)
        print(f"  BCRRS TOPSIS Ranking  (α={alpha}, β={beta}, γ={gamma})")
        print("="*70)
        print(f"{'Rank':<5} {'Name':<22} {'TOPSIS':>7} {'SPI':>6} "
              f"{'DDS':>6} {'MCR':>6} {'FCI':>6} {'Risk':>5}")
        print("-"*70)
        for r in results:
            flag = " [!]" if r["risk_flag"] else "    "
            print(f"{r['rank']:<5} {r['name']:<22} "
                  f"{r['topsis_score']:>7.4f} {r['SPI']:>6.3f} "
                  f"{r['DDS']:>6.1f} {r['MCR']:>6.3f} "
                  f"{r['FCI']:>6.3f}{flag}")

    return results


# ─── CPEC Case Study Simulation ──────────────────────────────────────────────

def simulate_cpec_contractors(n=50, seed=42):
    """
    Simulate 50 CPEC contractors calibrated from the 2022 Auditor General
    of Pakistan report distributions.

    Categories: Infrastructure 30, Industrial 12, Commercial 8
    Geographic tier: PK (national) for all 50
    """
    random.seed(seed)
    np.random.seed(seed)

    categories = (
        ["INFRASTRUCTURE"] * 30 +
        ["INDUSTRIAL"]     * 12 +
        ["COMMERCIAL"]     * 8
    )
    random.shuffle(categories)

    # Two performance clusters: top-tier (40%) and problematic (bottom 10%)
    performance_profile = (
        ["high"]    * 20 +
        ["medium"]  * 20 +
        ["low"]     * 10
    )
    random.shuffle(performance_profile)

    contractors = []
    for i in range(n):
        did  = f"PK-CPEC-{i+1:03d}"
        name = f"Contractor-{chr(65 + i % 26)}{i // 26 + 1}"
        cat  = categories[i]
        prof = performance_profile[i]

        # Number of projects (2-5)
        n_projects = random.randint(2, 5)
        projects = []

        for j in range(n_projects):
            # Contract value varies by category and profile
            if cat == "INFRASTRUCTURE":
                v = random.uniform(5e6, 120e6)
            elif cat == "INDUSTRIAL":
                v = random.uniform(2e6, 50e6)
            else:
                v = random.uniform(500e3, 10e6)

            # Number of milestones per project (3-8)
            n_ms = random.randint(3, 8)
            base_ts = 1_600_000_000  # approx Oct 2020
            milestones = []

            for k in range(n_ms):
                planned = base_ts + k * 60 * 24 * 3600  # 60 days apart

                if prof == "high":
                    delay = random.choice([0, 0, 0, random.randint(1, 5)*86400])
                    quality = random.uniform(80, 98)
                    compliant = random.random() > 0.05
                    dispute = random.random() > 0.95
                elif prof == "medium":
                    delay = random.choice([0, 0, random.randint(5, 30)*86400])
                    quality = random.uniform(60, 85)
                    compliant = random.random() > 0.15
                    dispute = random.random() > 0.85
                else:  # low — calibrated from audit findings
                    delay = random.randint(20, 120) * 86400
                    quality = random.uniform(35, 65)
                    compliant = random.random() > 0.45
                    dispute = random.random() > 0.60

                milestones.append({
                    "planned_date":      planned,
                    "actual_date":       planned + delay,
                    "quality_score":     round(quality, 1),
                    "material_compliant": compliant,
                    "dispute_raised":    dispute,
                    "corrected":         False,
                })

            projects.append({
                "contract_value": v,
                "category":       cat,
                "milestones":     milestones,
            })

        contractors.append(make_contractor(did, name, cat, projects))

    return contractors


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="BCRRS ML Ranking Engine")
    parser.add_argument("--sensitivity", action="store_true",
                        help="Run and print sensitivity analysis")
    parser.add_argument("--cpec",        action="store_true",
                        help="Run CPEC case study simulation")
    parser.add_argument("--export",      type=str, default=None,
                        help="Export results to CSV file path")
    args = parser.parse_args()

    print("\nBCRRS ML Ranking Engine")
    print("="*70)

    if args.cpec:
        print("Running CPEC case study (50 contractors)...")
        contractors = simulate_cpec_contractors(n=50)
    else:
        print("Running small demo (8 contractors)...")
        contractors = simulate_cpec_contractors(n=8)

    # Train Random Forest
    print("\nTraining Random Forest risk model...")
    rf_model, scaler, cv_auc = train_risk_model(contractors)
    print(f"  Cross-validated AUC: {cv_auc:.3f}")

    # Full ranking
    results = rank_contractors(
        contractors,
        alpha=ALPHA_DEFAULT,
        beta=BETA_DEFAULT,
        gamma=GAMMA_DEFAULT,
        rf_model=rf_model,
        scaler=scaler,
        verbose=True,
    )

    # Risk summary
    flagged = [r for r in results if r["risk_flag"]]
    print(f"\nRisk flags: {len(flagged)} / {len(results)} contractors flagged")
    for r in flagged:
        print(f"  [!] {r['name']}  SPI={r['SPI']:.3f}  DDS={r['DDS']:.1f}")

    # Sensitivity analysis
    if args.sensitivity or True:  # always run
        print("\n" + "="*70)
        print("  Sensitivity Analysis")
        print("="*70)
        sens_df, mc_taus = run_sensitivity_analysis(contractors)

        grid_rows = sens_df[sens_df["type"] == "grid"]
        mc_row    = sens_df[sens_df["type"] == "monte_carlo"].iloc[0]

        print("\nGrid perturbation (±20% per parameter):")
        print(f"{'Param':<8} {'Dir':<6} {'α':>5} {'β':>5} {'γ':>5} "
              f"{'Kendall τ':>10} {'p-value':>8}")
        print("-"*55)
        for _, row in grid_rows.iterrows():
            print(f"{row['param']:<8} {row['direction']:<6} "
                  f"{row['alpha']:>5.2f} {row['beta']:>5.2f} "
                  f"{row['gamma']:>5.2f} "
                  f"{row['kendall_tau']:>10.4f} {row['p_value']:>8.4f}")

        print(f"\nMonte Carlo (500 random weight triples):")
        print(f"  Mean Kendall τ : {mc_row['kendall_tau']:.4f}")
        print(f"  Std Kendall τ  : {np.std(mc_taus):.4f}")
        print(f"  Min Kendall τ  : {np.min(mc_taus):.4f}")
        print(f"  Pct below 0.80 : "
              f"{100*np.mean(np.array(mc_taus) < 0.80):.1f}%")

        # Stability verdict
        mean_tau = float(mc_row["kendall_tau"])
        verdict = "STABLE" if mean_tau >= 0.80 else "UNSTABLE"
        print(f"\n  Ranking stability verdict: {verdict} (τ={mean_tau:.4f})")

        # Save sensitivity table for paper
        sens_df.to_csv("sensitivity_results.csv", index=False)
        print("  Saved to sensitivity_results.csv")

    if args.export:
        df_out = pd.DataFrame(results)
        df_out.to_csv(args.export, index=False)
        print(f"\nResults exported to {args.export}")

    return results


if __name__ == "__main__":
    main()
