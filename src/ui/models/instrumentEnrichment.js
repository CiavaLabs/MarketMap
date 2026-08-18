export function detailsField(details, field) {
  for (const section of details?.sections || []) {
    const value = section.fields?.[field];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function enrichmentFromDetails(details) {
  if (details?.instrument?.sector) return details.instrument;
  const sector = detailsField(details, "sector");
  const category = detailsField(details, "industry");
  return sector || category ? { sector, category } : null;
}
