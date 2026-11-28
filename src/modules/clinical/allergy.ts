/* ─────────────────────────────────────────────────────────────────────────────
   Drug-allergy check. A safety net, not a full drug database: it matches the
   patient's recorded allergies against medicine names, directly and through
   common drug groups (e.g. a penicillin allergy flags amoxicillin / Augmentin).
   The prescribing doctor stays responsible and can override with a reason.
   ───────────────────────────────────────────────────────────────────────────── */

const GROUPS: Record<string, string[]> = {
  penicillin: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin', 'dicloxacillin', 'flucloxacillin', 'piperacillin', 'augmentin', 'amoxiclav', 'clavam', 'moxclav', 'mox-cv', 'novamox'],
  cephalosporin: ['cephalexin', 'cefalexin', 'cefixime', 'ceftriaxone', 'cefuroxime', 'cefpodoxime', 'cefadroxil', 'cefdinir', 'cefoperazone', 'cefotaxime', 'taxim', 'monocef', 'zifi'],
  sulfa: ['sulfa', 'sulpha', 'sulfamethoxazole', 'cotrimoxazole', 'co-trimoxazole', 'septran', 'bactrim', 'sulfasalazine', 'sulfadiazine'],
  nsaid: ['aspirin', 'ibuprofen', 'diclofenac', 'naproxen', 'ketorolac', 'aceclofenac', 'mefenamic', 'piroxicam', 'etoricoxib', 'nimesulide', 'indomethacin', 'ecosprin', 'brufen', 'combiflam', 'voveran', 'meftal', 'zerodol', 'disprin', 'nise'],
  paracetamol: ['paracetamol', 'acetaminophen', 'crocin', 'dolo', 'calpol', 'pacimol', 'combiflam', 'sumo'],
  quinolone: ['ciprofloxacin', 'levofloxacin', 'ofloxacin', 'norfloxacin', 'moxifloxacin', 'ciplox', 'levoflox', 'oflox'],
  macrolide: ['azithromycin', 'erythromycin', 'clarithromycin', 'roxithromycin', 'azithral', 'azee'],
  tetracycline: ['tetracycline', 'doxycycline', 'minocycline'],
  opioid: ['codeine', 'tramadol', 'morphine', 'tapentadol', 'fentanyl'],
  iodine: ['iodine', 'povidone', 'betadine'],
};

const ALIASES: Record<string, string> = {
  penicillins: 'penicillin', pcn: 'penicillin', amoxicillin: 'penicillin', ampicillin: 'penicillin', augmentin: 'penicillin',
  sulpha: 'sulfa', 'sulfa drugs': 'sulfa', 'sulpha drugs': 'sulfa', sulfonamide: 'sulfa', sulfonamides: 'sulfa', septran: 'sulfa',
  nsaids: 'nsaid', 'nsaid': 'nsaid', painkiller: 'nsaid', painkillers: 'nsaid', aspirin: 'nsaid', ibuprofen: 'nsaid', diclofenac: 'nsaid',
  cephalosporins: 'cephalosporin', quinolones: 'quinolone', fluoroquinolone: 'quinolone', fluoroquinolones: 'quinolone',
  macrolides: 'macrolide', acetaminophen: 'paracetamol', crocin: 'paracetamol', dolo: 'paracetamol',
  opioids: 'opioid', codeine: 'opioid', tetracyclines: 'tetracycline', 'povidone iodine': 'iodine',
};

const NONE = new Set(['', 'none', 'nil', 'no', 'na', 'n/a', 'no known allergies', 'nkda', 'nka']);

export function normaliseAllergies(v: any): string[] {
  let arr: any[] = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') { try { const j = JSON.parse(v); arr = Array.isArray(j) ? j : v.split(','); } catch { arr = v.split(','); } }
  return [...new Set(arr.map(x => String(x || '').trim().toLowerCase()).filter(x => !NONE.has(x)))];
}

export interface AllergyWarning { medicine: string; allergy: string; reason: string }

export function checkAllergies(allergiesIn: any, medicines: string[]): AllergyWarning[] {
  const allergies = normaliseAllergies(allergiesIn);
  const out: AllergyWarning[] = [];
  for (const medRaw of medicines) {
    const med = String(medRaw || '').toLowerCase();
    if (!med.trim()) continue;
    for (const a of allergies) {
      const group = ALIASES[a] || (GROUPS[a] ? a : Object.keys(GROUPS).find(g => GROUPS[g].includes(a)));
      if (a.length >= 4 && med.includes(a)) {
        out.push({ medicine: medRaw, allergy: a, reason: `The patient has a recorded allergy to ${a}.` });
      } else if (group && GROUPS[group].some(t => med.includes(t))) {
        out.push({ medicine: medRaw, allergy: a, reason: `${medRaw} belongs to the ${group} group; the patient has a recorded allergy to ${a}.` });
      }
    }
  }
  return out;
}
