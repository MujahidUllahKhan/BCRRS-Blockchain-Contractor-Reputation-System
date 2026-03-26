#!/bin/bash
# ================================================================
# BCRRS Gas Measurement Script — 50 runs, compute median
# Run from project root: bash scripts/run_gas_50.sh
# ================================================================

echo "BCRRS Gas Measurement — 50 runs"
echo "================================"

RUNS=50
OUTPUT_DIR="gas_runs"
mkdir -p $OUTPUT_DIR

# Run tests 50 times, save each gas output
for i in $(seq 1 $RUNS); do
  echo -ne "Run $i/$RUNS...\r"
  npx hardhat test 2>&1 | grep "gas used:" > "$OUTPUT_DIR/run_$i.txt"
done

echo ""
echo "All $RUNS runs complete. Computing medians..."
echo ""

# Extract and compute median for each function
python3 - << 'PYEOF'
import os, statistics, re

run_dir = "gas_runs"
functions = {
    "register()":              [],
    "deactivate()":            [],
    "assignInspector()":       [],
    "completeMilestone()":     [],
    "recordMilestone()":       [],
    "fileDispute()":           [],
    "castVote()":              [],
    "issueCorrectionValues()": [],
    "escalateToCourt()":       [],
}

patterns = {
    "register()":              r"register\(\) gas used: (\d+)",
    "deactivate()":            r"deactivate\(\) gas used: (\d+)",
    "assignInspector()":       r"assignInspector\(\) gas used: (\d+)",
    "completeMilestone()":     r"completeMilestone\(\) gas used: (\d+)",
    "recordMilestone()":       r"recordMilestone\(\) gas used.*?: (\d+)",
    "fileDispute()":           r"fileDispute\(\) gas used: (\d+)",
    "castVote()":              r"castVote\(\) gas used: (\d+)",
    "issueCorrectionValues()": r"issueCorrectionValues\(\) gas used: (\d+)",
    "escalateToCourt()":       r"escalateToCourt\(\) gas used: (\d+)",
}

for fname in sorted(os.listdir(run_dir)):
    if not fname.startswith("run_"):
        continue
    with open(os.path.join(run_dir, fname)) as f:
        content = f.read()
    for func, pat in patterns.items():
        m = re.search(pat, content)
        if m:
            functions[func].append(int(m.group(1)))

print(f"{'Function':<35} {'Min':>8} {'Max':>8} {'Median':>8} {'Samples':>8}")
print("-" * 70)

ETH_PRICE = 3000
GWEI      = 1e-9

for func, values in functions.items():
    if not values:
        print(f"{func:<35} {'NO DATA':>8}")
        continue
    mn  = min(values)
    mx  = max(values)
    med = int(statistics.median(values))
    usd = med * GWEI * ETH_PRICE
    print(f"{func:<35} {mn:>8,} {mx:>8,} {med:>8,}   "
          f"n={len(values):>2}  ~${usd:.2f}")

print("")
print("View functions: getProfile(), getMilestoneCorrection() = 0 gas")
print("")
print("Copy the Median column into Table V of the paper.")
PYEOF
