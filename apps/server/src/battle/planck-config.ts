import { Settings } from "planck";

export const PLANCK_SI_TUNING = Object.freeze({
  linearSlop: 0.00005,
  aabbExtension: 0.001,
  maxLinearCorrection: 0.01,
});

let configured = false;

/** Centralises and verifies the process-wide Planck tuning needed for 40-60 mm SI bodies. */
export function ensurePlanckSiTuning(): void {
  if (!configured) {
    Settings.linearSlop = PLANCK_SI_TUNING.linearSlop;
    Settings.aabbExtension = PLANCK_SI_TUNING.aabbExtension;
    Settings.maxLinearCorrection = PLANCK_SI_TUNING.maxLinearCorrection;
    configured = true;
  }
  if (
    Settings.linearSlop !== PLANCK_SI_TUNING.linearSlop ||
    Settings.aabbExtension !== PLANCK_SI_TUNING.aabbExtension ||
    Settings.maxLinearCorrection !== PLANCK_SI_TUNING.maxLinearCorrection
  ) {
    throw new Error("Planck global SI tuning was mutated after engine configuration");
  }
}
