const MINOR_UNIT_BY_EXACT_CODE = Object.freeze({
  GBp: Object.freeze({ currency: "GBP", scale: 100 }),
  ZAc: Object.freeze({ currency: "ZAR", scale: 100 }),
  ILa: Object.freeze({ currency: "ILS", scale: 100 }),
});

const MINOR_UNIT_BY_UPPERCASE_CODE = Object.freeze({
  GBX: Object.freeze({ currency: "GBP", scale: 100 }),
  ZAC: Object.freeze({ currency: "ZAR", scale: 100 }),
  ILA: Object.freeze({ currency: "ILS", scale: 100 }),
});

const MAJOR_UNIT = Object.freeze({ scale: 1 });

export function resolveCurrencyUnit(value) {
  const code = `${value ?? ""}`.trim();
  if (!code) return null;
  const exact = MINOR_UNIT_BY_EXACT_CODE[code];
  if (exact) return exact;
  const uppercase = code.toUpperCase();
  return MINOR_UNIT_BY_UPPERCASE_CODE[uppercase]
    || Object.freeze({ ...MAJOR_UNIT, currency: uppercase });
}

export function majorCurrencyCode(value) {
  return resolveCurrencyUnit(value)?.currency || null;
}

export function isMinorCurrencyUnit(value) {
  return (resolveCurrencyUnit(value)?.scale ?? 1) !== 1;
}
