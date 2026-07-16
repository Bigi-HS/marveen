"""Shared SEC-AC1 range-validation bounds for the hibiki health scripts.

Single source of truth for the plausible-human bounds used by
hibiki-health-write.py (write-time validation) and hibiki-stats.py
(read-time sanity). The two scripts previously each carried their own copy of
this table, kept aligned only by a byte-for-byte sync test. Centralising the
data here removes that drift class entirely.
"""

from __future__ import annotations

# Plausible-human bounds enforced before any health write (SEC-AC1).
RANGE_CHECKS: dict[str, tuple[float, float]] = {
    "total_calories": (100, 5000),
    "protein_g": (0, 350),
    "carbs_g": (0, 600),
    "fat_g": (0, 300),
    "fiber_g": (0, 150),
    "body_fat_pct": (5, 60),
    "weight_kg": (30, 250),
    "fat_mass_kg": (2, 150),
    "lean_mass_kg": (20, 120),
    "vat_area_cm2": (0, 400),
    # bone_density is stored as a DEXA T-score (see hibiki-dexa.py: the
    # bone_density_tscore input maps to the stored `bone_density` key).
    # Plausible human T-scores span roughly -4 (severe osteoporosis) to +3.
    "bone_density": (-4.0, 3.0),
}
