function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { const value = parseJson(bytes); return { format: 'FHIR R4', bundleType: value?.type || null, entriesOnPage: value?.entry?.length || 0 }; }
