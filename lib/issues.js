// The single source of truth for issue mapping. The Methodology page renders this table.
//
// Federal bills: matched by the one CRS "policy area" Congress.gov assigns to every bill.
//   The 32 terms below were checked against https://www.congress.gov/help/field-values/policy-area
//   on 2026-10-13.
// New York bills: matched by the primary consolidated law a bill amends ("lawSection" in
//   the NY Senate Open Legislation API), plus Open States subject tags when present.

export const POLICY_AREAS_VERIFIED = Object.freeze([
  'Agriculture and Food', 'Animals', 'Armed Forces and National Security', 'Arts, Culture, Religion',
  'Civil Rights and Liberties, Minority Issues', 'Commerce', 'Congress', 'Crime and Law Enforcement',
  'Economics and Public Finance', 'Education', 'Emergency Management', 'Energy', 'Environmental Protection',
  'Families', 'Finance and Financial Sector', 'Foreign Trade and International Finance',
  'Government Operations and Politics', 'Health', 'Housing and Community Development', 'Immigration',
  'International Affairs', 'Labor and Employment', 'Law', 'Native Americans', 'Public Lands and Natural Resources',
  'Science, Technology, Communications', 'Social Sciences and History', 'Social Welfare', 'Sports and Recreation',
  'Taxation', 'Transportation and Public Works', 'Water Resources Development',
]);

/** Procedural or legacy policy areas that are never offered as issues. */
export const HIDDEN_POLICY_AREAS = Object.freeze(['Congress', 'Private Legislation', 'Geographic Areas, Entities, and Committees']);

export const MAX_ISSUES = 5;

export const ISSUES = Object.freeze([
  {
    id: 'housing', label: 'Housing',
    policyAreas: ['Housing and Community Development'],
    nyLaws: ['Real Property Law', 'Multiple Dwelling Law', 'Multiple Residence Law', 'Private Housing Finance Law', 'Real Property Tax Law', 'Real Property Actions and Proceedings Law', 'Public Housing Law', 'Cooperative Corporations Law'],
    subjects: ['Housing', 'Landlord', 'Tenant', 'Rent', 'Real Estate', 'Homeless'],
  },
  {
    id: 'health', label: 'Health care',
    policyAreas: ['Health'],
    nyLaws: ['Public Health Law', 'Mental Hygiene Law'],
    subjects: ['Health', 'Medicaid', 'Hospital', 'Mental Health', 'Public Health'],
  },
  {
    id: 'climate', label: 'Climate, energy and environment',
    policyAreas: ['Environmental Protection', 'Energy', 'Water Resources Development', 'Public Lands and Natural Resources'],
    nyLaws: ['Environmental Conservation Law', 'Public Service Law', 'Energy Law', 'Navigation Law', 'Parks, Recreation and Historic Preservation Law', 'Public Lands Law', 'Canal Law'],
    subjects: ['Environment', 'Energy', 'Climate', 'Utilities', 'Water', 'Natural Resources', 'Parks'],
  },
  {
    id: 'criminal-justice', label: 'Criminal justice and policing',
    policyAreas: ['Crime and Law Enforcement'],
    nyLaws: ['Penal Law', 'Criminal Procedure Law', 'Correction Law'],
    subjects: ['Crime', 'Criminal Justice', 'Law Enforcement', 'Police', 'Corrections', 'Prison', 'Firearms'],
  },
  {
    id: 'courts', label: 'Courts and civil law',
    policyAreas: ['Law'],
    nyLaws: ['Judiciary Law', 'Civil Practice Law and Rules', 'Court of Claims Act', 'New York City Civil Court Act', 'Uniform City Court Act', 'Uniform District Court Act', 'Uniform Justice Court Act', "Surrogate's Court Procedure Act", 'General Obligations Law', 'Estates, Powers and Trusts Law', 'Lien Law'],
    subjects: ['Courts', 'Judiciary', 'Civil Procedure'],
  },
  {
    id: 'labor', label: 'Jobs, wages and workers',
    policyAreas: ['Labor and Employment'],
    nyLaws: ['Labor Law', "Workers' Compensation Law", 'Civil Service Law', 'Retirement and Social Security Law', "Volunteer Firefighters' Benefit Law", "Volunteer Ambulance Workers' Benefit Law"],
    subjects: ['Labor', 'Employment', 'Wages', 'Workers', 'Unemployment', 'Pensions', 'Public Employees'],
  },
  {
    id: 'education', label: 'Schools and education',
    policyAreas: ['Education'],
    nyLaws: ['Education Law'],
    subjects: ['Education', 'Schools', 'Higher Education', 'Colleges'],
  },
  {
    id: 'transportation', label: 'Transportation and infrastructure',
    policyAreas: ['Transportation and Public Works'],
    nyLaws: ['Vehicle and Traffic Law', 'Transportation Law', 'Highway Law', 'Railroad Law', 'Transportation Corporations Law', 'Public Authorities Law'],
    subjects: ['Transportation', 'Motor Vehicles', 'Transit', 'Highways', 'Infrastructure'],
    note: 'Public Authorities Law covers the MTA and also non-transit authorities, so some matches may be about other authorities.',
  },
  {
    id: 'taxes', label: 'Taxes',
    policyAreas: ['Taxation'],
    nyLaws: ['Tax Law', 'Real Property Tax Law'],
    subjects: ['Taxation', 'Taxes', 'Revenue'],
  },
  {
    id: 'government', label: 'Elections and government',
    policyAreas: ['Government Operations and Politics'],
    nyLaws: ['Election Law', 'Public Officers Law', 'Legislative Law', 'State Administrative Procedure Act', 'Municipal Home Rule Law', 'General Municipal Law', 'County Law', 'Town Law', 'Village Law', 'General City Law', 'Second Class Cities Law', 'General Construction Law'],
    subjects: ['Elections', 'Government', 'Ethics', 'Campaign Finance', 'Voting', 'Local Government'],
  },
  {
    id: 'budget', label: 'Budget and the economy',
    policyAreas: ['Economics and Public Finance'],
    nyLaws: ['State Finance Law', 'Economic Development Law', 'Local Finance Law'],
    subjects: ['Budget', 'Appropriations', 'Economic Development'],
  },
  {
    id: 'business', label: 'Banking, business and consumers',
    policyAreas: ['Finance and Financial Sector', 'Commerce'],
    nyLaws: ['Banking Law', 'Insurance Law', 'Financial Services Law', 'General Business Law', 'Business Corporation Law', 'Limited Liability Company Law', 'Partnership Law', 'Not-for-Profit Corporation Law', 'Uniform Commercial Code', 'Alcoholic Beverage Control Law', 'Cannabis Law', 'Racing, Pari-Mutuel Wagering and Breeding Law', 'Personal Property Law'],
    subjects: ['Business', 'Banking', 'Consumer Protection', 'Insurance', 'Commerce', 'Alcohol', 'Cannabis', 'Gaming'],
  },
  {
    id: 'immigration', label: 'Immigration',
    policyAreas: ['Immigration'],
    nyLaws: [],
    subjects: ['Immigration', 'Immigrants'],
    note: 'No New York consolidated law maps cleanly to immigration; New York bills match only through Open States subject tags when present.',
  },
  {
    id: 'social-services', label: 'Social services and families',
    policyAreas: ['Social Welfare', 'Families'],
    nyLaws: ['Social Services Law', 'Family Court Act', 'Domestic Relations Law', 'Elder Law'],
    subjects: ['Social Services', 'Welfare', 'Children', 'Families', 'Aging', 'Child Care', 'Public Assistance'],
  },
  {
    id: 'civil-rights', label: 'Civil rights and liberties',
    policyAreas: ['Civil Rights and Liberties, Minority Issues'],
    nyLaws: ['Civil Rights Law'],
    subjects: ['Civil Rights', 'Discrimination', 'Human Rights', 'Privacy'],
    note: "New York's Human Rights Law is part of the Executive Law, which is too broad to map, so those bills are not matched here.",
  },
  {
    id: 'defense-veterans', label: 'Defense, veterans and national security',
    policyAreas: ['Armed Forces and National Security'],
    nyLaws: ['Military Law', "Veterans' Services Law"],
    subjects: ['Military', 'Veterans', 'National Guard', 'Homeland Security'],
  },
  {
    id: 'foreign-trade', label: 'Foreign affairs and trade',
    policyAreas: ['International Affairs', 'Foreign Trade and International Finance'],
    nyLaws: [],
    subjects: ['International', 'Trade'],
  },
  {
    // Matched by a published list of roll calls (data/issues/israel-palestine.json), not by subject:
    // aid votes sit in appropriations and defense bills whose policy areas cover far more.
    id: 'israel-palestine', label: 'Israel and Palestine',
    policyAreas: [],
    nyLaws: [],
    subjects: [],
    curated: 'israel-palestine',
    federalOnly: true,
    note: 'Matched by a published list of U.S. House roll calls on military aid and arms for Israel since January 2023; the rule and the full list are below. Military aid and arms sales are decided by Congress, so state legislators have no votes on it.',
  },
  {
    id: 'agriculture', label: 'Agriculture, food and animals',
    policyAreas: ['Agriculture and Food', 'Animals'],
    nyLaws: ['Agriculture and Markets Law'],
    subjects: ['Agriculture', 'Food', 'Animals', 'Farming'],
  },
  {
    id: 'technology', label: 'Science, technology and communications',
    policyAreas: ['Science, Technology, Communications'],
    nyLaws: ['State Technology Law'],
    subjects: ['Technology', 'Internet', 'Telecommunications', 'Broadband', 'Science'],
  },
  {
    id: 'emergency', label: 'Disasters and emergency management',
    policyAreas: ['Emergency Management'],
    nyLaws: [],
    subjects: ['Emergency Management', 'Disaster'],
  },
  {
    id: 'culture', label: 'Arts, culture, sports and history',
    policyAreas: ['Arts, Culture, Religion', 'Sports and Recreation', 'Social Sciences and History'],
    nyLaws: ['Arts and Cultural Affairs Law'],
    subjects: ['Arts', 'Culture', 'Sports', 'History', 'Recreation'],
  },
  {
    id: 'native-american', label: 'Native American affairs',
    policyAreas: ['Native Americans'],
    nyLaws: ['Indian Law'],
    subjects: ['Native American', 'Tribal'],
  },
]);

export const ISSUE_BY_ID = new Map(ISSUES.map((i) => [i.id, i]));

/** Normalize a law name so "Workers’ Compensation Law" and "workers compensation" compare equal. */
export function normalizeLawName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9, -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^the /, '')
    .replace(/ law$/, '')
    .trim();
}

const LAW_INDEX = (() => {
  const m = new Map();
  for (const issue of ISSUES) {
    for (const law of issue.nyLaws) {
      const k = normalizeLawName(law);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(issue.id);
    }
  }
  return m;
})();

const PA_INDEX = (() => {
  const m = new Map();
  for (const issue of ISSUES) for (const pa of issue.policyAreas) {
    if (!m.has(pa)) m.set(pa, new Set());
    m.get(pa).add(issue.id);
  }
  return m;
})();

/** Validate and de-duplicate requested issue ids (max 5, unknown ids dropped). */
export function resolveIssueIds(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const out = [];
  for (const raw of list) {
    const id = String(raw).trim().toLowerCase();
    if (ISSUE_BY_ID.has(id) && !out.includes(id)) out.push(id);
    if (out.length === MAX_ISSUES) break;
  }
  return out;
}

export function issuesForPolicyArea(policyArea) {
  if (!policyArea || HIDDEN_POLICY_AREAS.includes(policyArea)) return [];
  return [...(PA_INDEX.get(policyArea) ?? [])];
}

export function issuesForNyLaw(lawSection) {
  if (!lawSection) return [];
  // lawSection can occasionally list more than one law, separated by commas or semicolons.
  const whole = LAW_INDEX.get(normalizeLawName(lawSection));
  if (whole) return [...whole];
  const out = new Set();
  for (const part of String(lawSection).split(/[;,]/)) {
    for (const id of LAW_INDEX.get(normalizeLawName(part)) ?? []) out.add(id);
  }
  return [...out];
}

export function issuesForSubjects(subjects) {
  const list = (Array.isArray(subjects) ? subjects : []).map((s) => String(s).toLowerCase());
  if (!list.length) return [];
  const out = [];
  for (const issue of ISSUES) {
    if (issue.subjects.some((sub) => list.some((s) => s.includes(sub.toLowerCase())))) out.push(issue.id);
  }
  return out;
}

/** True when a federal bill's policy area belongs to any selected issue. */
export function policyAreaMatches(policyArea, issueIds) {
  const hits = issuesForPolicyArea(policyArea);
  return issueIds.filter((id) => hits.includes(id));
}

export function nyLawMatches(lawSection, issueIds, subjects = []) {
  const hits = new Set([...issuesForNyLaw(lawSection), ...issuesForSubjects(subjects)]);
  return issueIds.filter((id) => hits.has(id));
}

export function issueLabel(id) {
  return ISSUE_BY_ID.get(id)?.label ?? id;
}

/** Public shape for /api/meta and the Methodology page. */
export function issueTable() {
  return {
    verifiedPolicyAreas: POLICY_AREAS_VERIFIED,
    hiddenPolicyAreas: HIDDEN_POLICY_AREAS,
    maxIssues: MAX_ISSUES,
    issues: ISSUES.map(({ id, label, policyAreas, nyLaws, subjects, note, curated, federalOnly }) => ({ id, label, policyAreas, nyLaws, subjects, note: note ?? null, curated: curated ?? null, federalOnly: Boolean(federalOnly) })),
  };
}

/** Issues among these ids that are defined by a published roll-call list. */
export function curatedIssueIds(issueIds) {
  return (issueIds ?? []).filter((id) => ISSUE_BY_ID.get(id)?.curated);
}
