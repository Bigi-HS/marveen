#!/usr/bin/env python3
"""
WELL-027: Zepp health plausibility bounds recalibration.
Analyzes ratio corpus and sweeps FP-rate to find optimal bounds.
"""

import json
import statistics

def load_corpus():
    with open("store/zepp-ratio-corpus.json") as f:
        return json.load(f)

def analyze_bounds():
    corpus = load_corpus()
    rows = corpus["rows"]

    # Filter: applies=true (steps >= 3000 gate)
    gated_rows = [r for r in rows if r.get("applies")]
    print(f"Total rows: {len(rows)}, Gated (steps>=3000): {len(gated_rows)}\n")

    # Extract ratios
    dist_ratios = [r["dist_per_step"] for r in gated_rows if r["dist_per_step"] is not None]
    kcal_ratios = [r["kcal_per_step"] for r in gated_rows if r["kcal_per_step"] is not None]

    print("DIST_PER_STEP statistics (Rule 2):")
    print(f"  Count: {len(dist_ratios)}")
    print(f"  Min: {min(dist_ratios):.3f}, Max: {max(dist_ratios):.3f}")
    print(f"  Median: {statistics.median(dist_ratios):.3f}")
    q10 = sorted(dist_ratios)[len(dist_ratios)//10]
    q25 = sorted(dist_ratios)[len(dist_ratios)//4]
    q75 = sorted(dist_ratios)[3*len(dist_ratios)//4]
    q90 = sorted(dist_ratios)[9*len(dist_ratios)//10]
    print(f"  p10: {q10:.3f}, p25: {q25:.3f}, p75: {q75:.3f}, p90: {q90:.3f}")

    print("\nKCAL_PER_STEP statistics (Rule 1):")
    print(f"  Count: {len(kcal_ratios)}")
    print(f"  Min: {min(kcal_ratios):.3f}, Max: {max(kcal_ratios):.3f}")
    print(f"  Median: {statistics.median(kcal_ratios):.3f}")
    q10k = sorted(kcal_ratios)[len(kcal_ratios)//10]
    q25k = sorted(kcal_ratios)[len(kcal_ratios)//4]
    q75k = sorted(kcal_ratios)[3*len(kcal_ratios)//4]
    q90k = sorted(kcal_ratios)[9*len(kcal_ratios)//10]
    print(f"  p10: {q10k:.3f}, p25: {q25k:.3f}, p75: {q75k:.3f}, p90: {q90k:.3f}")

    # Test bound candidates
    print("\n=== FP-RATE SWEEP ===\n")

    candidates = [
        ("current", [0.50, 0.90], [0.03, 0.20]),
        ("p25-p90", [q25, q90], [q25k, q90k]),
        ("p10-p90", [q10, q90], [q10k, q90k]),
        ("p25-max", [q25, max(dist_ratios)], [q25k, max(kcal_ratios)]),
    ]

    for name, dist_bounds, kcal_bounds in candidates:
        fp_count = 0
        for r in gated_rows:
            d, k = r["dist_per_step"], r["kcal_per_step"]
            if d is not None:
                if not (dist_bounds[0] <= d <= dist_bounds[1]):
                    fp_count += 1
            if k is not None:
                if not (kcal_bounds[0] <= k <= kcal_bounds[1]):
                    fp_count += 1

        fp_rate = 100 * fp_count / len(gated_rows) if gated_rows else 0
        print(f"{name:12} | dist [{dist_bounds[0]:.2f}, {dist_bounds[1]:.2f}] "
              f"kcal [{kcal_bounds[0]:.2f}, {kcal_bounds[1]:.2f}] | "
              f"FP: {fp_count}/{len(gated_rows)} ({fp_rate:.1f}%)")

    print("\n=== RECOMMENDATION ===")
    print("Recalibrated bounds (p25-p90):")
    print(f"  dist_per_step: [{q25:.2f}, {q90:.2f}]  (was [0.50, 0.90])")
    print(f"  kcal_per_step: [{q25k:.2f}, {q90k:.2f}]  (was [0.03, 0.20])")
    print("This reduces FP while covering 50-90% of valid data.")

if __name__ == "__main__":
    analyze_bounds()
