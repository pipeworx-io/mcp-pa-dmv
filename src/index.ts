interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Pennsylvania DMV MCP — registered vehicles and electric-vehicle adoption by county and
 * by ZIP code, from PennDOT Driver & Vehicle Services. Keyless.
 *
 * One pack per state agency: Pennsylvania's grain (a county or ZIP row per registration
 * year, with each quarter of that year as its own set of columns) has nothing in common
 * with California's annual ZIP snapshot or Maryland's county-by-month series, so
 * Pennsylvania gets its own tools with its own real arguments — `year` and `quarter`.
 *
 * Sources (verified live 2026-07-29, latest quarter 2026 Q2):
 *   gis.penndot.pa.gov ArcGIS
 *     opendata/evregistrationscounty  67 counties × registration years 2023–2026
 *     opendata/evregistrationszip     ~1,830 ZIP codes × registration years 2023–2026
 *
 * ── Quarters are COLUMNS, not rows ────────────────────────────────────────────────
 *
 * Each feature is one county (or ZIP) for one REGISTRATION_YEAR, carrying HEV_Q1..Q4,
 * PHEV_Q1..Q4, BEV_Q1..Q4, FUEL_CELL_Q1..Q4, TOTAL_EV_Q1..Q4, TOTAL_REG_Q1..Q4 and
 * PCT_EV_Q1..Q4 side by side. Quarters PennDOT has yet to publish are present as null
 * columns, so "the latest data" means walking Q4 → Q1 looking for a quarter that actually
 * carries values — there is no row to filter on and no date field to sort by.
 *
 * `pickQuarter` does that walk once for the whole result set rather than per row, so a
 * ranking never silently compares one county's Q2 against another's Q1. A quarter is
 * accepted only if at least half as many rows carry it as carry the best-covered quarter,
 * which keeps a single early-reporting straggler from dragging the whole answer forward.
 *
 * ── Hybrids sit outside TOTAL_EV, and the ZIP layer's 2026 Q1 columns disagree ─────
 *
 * PennDOT's TOTAL_EV = BEV + PHEV + FUEL_CELL. Conventional hybrids (HEV) are reported
 * separately and are deliberately excluded from it — a Prius is in `hybrid_gasoline`,
 * never in `plug_in_vehicles`. That holds across all 67 counties and both quarters of
 * 2026 (verified: zero mismatches).
 *
 * The ZIP layer's 2026 Q1 columns are the exception: there TOTAL_EV_Q1 folds HEV in
 * (ZIP 19103 publishes TOTAL_EV_Q1 1291 against BEV 314 + PHEV 136 + HEV 841) and
 * PCT_EV_Q1 is written as a fraction of that inflated number rather than a percent
 * (0.14 where the plug-in share is 4.85%). Every other year and quarter is consistent.
 * So this pack computes plug_in_vehicles and ev_share_pct from the component columns
 * everywhere instead of trusting TOTAL_EV / PCT_EV — which reproduces PennDOT's own
 * published values exactly wherever those are sound.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be
 * answered comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-pa-dmv/1.0 (+https://pipeworx.io)';
const BASE = 'https://gis.penndot.pa.gov/gis/rest/services/opendata';
const COUNTY_LAYER = `${BASE}/evregistrationscounty/MapServer/0`;
const ZIP_LAYER = `${BASE}/evregistrationszip/MapServer/0`;

// State ArcGIS servers are slow under load; the county layer is 67 rows but the ZIP layer
// returns ~1,830 in one call, comfortably under its 2,000 maxRecordCount.
const TIMEOUT_MS = 20_000;

const YEARS = ['2026', '2025', '2024', '2023'];
const LATEST_YEAR = YEARS[0];
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;
type Quarter = (typeof QUARTERS)[number];

const COUNTY_FIELDS = [
  'COUNTY_NAME', 'COUNTY_NUMBER', 'FIPS_COUNTY_CODE', 'DISTRICT_NO', 'PLANNING_PARTNER',
  'REGISTRATION_YEAR',
  ...QUARTERS.flatMap((q) => [`HEV_${q}`, `PHEV_${q}`, `BEV_${q}`, `FUEL_CELL_${q}`, `TOTAL_REG_${q}`]),
].join(',');

const ZIP_FIELDS = [
  'ZIP', 'REGISTRATION_YEAR',
  ...QUARTERS.flatMap((q) => [`HEV_${q}`, `PHEV_${q}`, `BEV_${q}`, `FUEL_CELL_${q}`, `TOTAL_REG_${q}`]),
].join(',');

const COUNTY_SOURCE = 'gis.penndot.pa.gov — PennDOT Driver & Vehicle Services, EV Registrations by County (includes total registrations)';
const ZIP_SOURCE = 'gis.penndot.pa.gov — PennDOT Driver & Vehicle Services, EV Registrations by ZIP Code (includes total registrations)';

interface Snapshot {
  name: string;
  attrs: Record<string, unknown>;
  hybrid_gasoline: number | null;
  battery_electric: number | null;
  plug_in_hybrid: number | null;
  fuel_cell: number | null;
  plug_in_vehicles: number | null;
  total_registered_vehicles: number | null;
  ev_share_pct: number | null;
}

function normQuarter(raw: string | undefined): Quarter | null {
  if (!raw) return null;
  const m = raw.trim().toUpperCase().match(/([1-4])/);
  return m ? (`Q${m[1]}` as Quarter) : null;
}

/**
 * The one quarter to report for this whole result set. Walks Q4 → Q1 and takes the latest
 * quarter whose TOTAL_REG coverage is at least half the best-covered quarter's, so a lone
 * early row cannot pull a 67-county ranking into a quarter nobody else has filed.
 */
function pickQuarter(features: ArcgisFeature[]): Quarter | null {
  const coverage = new Map<Quarter, number>();
  for (const q of QUARTERS) {
    coverage.set(q, features.filter((f) => govNumber(f.attributes[`TOTAL_REG_${q}`]) !== null).length);
  }
  const best = Math.max(...coverage.values());
  if (best === 0) return null;
  for (let i = QUARTERS.length - 1; i >= 0; i--) {
    const q = QUARTERS[i];
    if ((coverage.get(q) ?? 0) >= best / 2) return q;
  }
  return null;
}

/** Derive one place's figures for a quarter from the component columns. */
function snapshot(attrs: Record<string, unknown>, nameField: string, q: Quarter): Snapshot {
  const hev = govNumber(attrs[`HEV_${q}`]);
  const bev = govNumber(attrs[`BEV_${q}`]);
  const phev = govNumber(attrs[`PHEV_${q}`]);
  const fcev = govNumber(attrs[`FUEL_CELL_${q}`]);
  const total = govNumber(attrs[`TOTAL_REG_${q}`]);
  // Computed rather than read from TOTAL_EV / PCT_EV — see the header note on the ZIP
  // layer's 2026 Q1 columns.
  const plugIn = bev === null && phev === null && fcev === null ? null : (bev ?? 0) + (phev ?? 0) + (fcev ?? 0);
  return {
    name: String(attrs[nameField] ?? ''),
    attrs,
    hybrid_gasoline: hev,
    battery_electric: bev,
    plug_in_hybrid: phev,
    fuel_cell: fcev,
    plug_in_vehicles: plugIn,
    total_registered_vehicles: total,
    ev_share_pct: plugIn !== null && total ? Math.round((plugIn / total) * 10000) / 100 : null,
  };
}

function sumOf(rows: Snapshot[], key: 'plug_in_vehicles' | 'total_registered_vehicles' | 'hybrid_gasoline'): number {
  return rows.reduce((a, r) => a + (r[key] ?? 0), 0);
}

function badYear(year: string): Record<string, unknown> {
  return govNotFound(
    'year_unavailable',
    `PennDOT publishes registration years ${YEARS.slice().sort().join(', ')}. Retry with year="${LATEST_YEAR}".`,
    { requested_year: year, available_years: YEARS.slice().sort() },
  );
}

/** Every county row for one registration year — 67 features, so filtering happens in code. */
async function fetchCounties(year: string): Promise<ArcgisFeature[]> {
  return arcgisQuery(COUNTY_LAYER, {
    where: `REGISTRATION_YEAR='${year.replace(/'/g, "''")}'`,
    outFields: COUNTY_FIELDS,
    limit: 200,
    userAgent: UA,
    timeoutMs: TIMEOUT_MS,
  });
}

const tools: McpToolExport['tools'] = [
  {
    name: 'pa_dmv_ev_adoption',
    description:
      'Measure electric-vehicle adoption in Pennsylvania from PennDOT Driver & Vehicle Services registration data: how many battery-electric, plug-in hybrid, hydrogen fuel-cell and conventional hybrid vehicles are registered in each Pennsylvania county in a given quarter, and what share of that county\'s registered fleet is plug-in. Returns a genuine statewide Pennsylvania total alongside every county, so it answers "how many EVs are registered in Pennsylvania", "EV share in Allegheny County", "which Pennsylvania county has the most electric vehicles", "how many Teslas-era battery-electric cars are registered in Philadelphia", and quarter-over-quarter growth via the `year` and `quarter` arguments (2023 onward). For ZIP-code detail use pa_dmv_ev_adoption_by_zip; for the whole registered fleet across every fuel type use pa_dmv_vehicle_registrations.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'Pennsylvania county name, matched as a substring, e.g. "Allegheny", "Montgomery", "Philadelphia".' },
        year: { type: 'string', description: `Registration year, one of ${YEARS.slice().sort().join(', ')}. Defaults to ${LATEST_YEAR}.` },
        quarter: { type: 'string', description: 'Quarter of that registration year: "Q1", "Q2", "Q3" or "Q4". Defaults to the latest quarter PennDOT has actually filed for that year.' },
        limit: { type: ['number', 'string'], description: 'Max counties to return (default 30, max 70). Pennsylvania has 67 counties.' },
      },
    },
  },
  {
    name: 'pa_dmv_vehicle_registrations',
    description:
      'Count all vehicles registered in Pennsylvania by county for a given quarter, from PennDOT Driver & Vehicle Services. Covers the entire registered fleet of every fuel type, returns a genuine statewide Pennsylvania total plus each county\'s share of it, and carries the plug-in count alongside for context. Answers "how many vehicles are registered in Pennsylvania", "how many cars are registered in Allegheny County", "which Pennsylvania county has the most registered vehicles", and quarterly trend questions via the `year` and `quarter` arguments (2023 onward). For the electric and hybrid breakdown by drivetrain use pa_dmv_ev_adoption.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'Pennsylvania county name, matched as a substring, e.g. "Allegheny", "Montgomery", "Philadelphia".' },
        year: { type: 'string', description: `Registration year, one of ${YEARS.slice().sort().join(', ')}. Defaults to ${LATEST_YEAR}.` },
        quarter: { type: 'string', description: 'Quarter of that registration year: "Q1", "Q2", "Q3" or "Q4". Defaults to the latest quarter PennDOT has actually filed for that year.' },
        limit: { type: ['number', 'string'], description: 'Max counties to return (default 30, max 70). Pennsylvania has 67 counties.' },
      },
    },
  },
  {
    name: 'pa_dmv_ev_adoption_by_zip',
    description:
      'Break Pennsylvania electric-vehicle registrations down to the ZIP code, from PennDOT Driver & Vehicle Services: battery-electric, plug-in hybrid, fuel-cell and conventional hybrid counts for each of roughly 1,830 Pennsylvania ZIP codes, with that ZIP code\'s total registered vehicles and plug-in share. Answers "how many EVs are registered in ZIP 19103", "which Pennsylvania ZIP code has the most electric vehicles", "EV share in ZIP 15213", and neighbourhood-level adoption questions that a county figure averages away. Supply `zip` for one ZIP code, or omit it to rank them. For county figures and the statewide Pennsylvania total use pa_dmv_ev_adoption.',
    inputSchema: {
      type: 'object',
      properties: {
        zip: { type: 'string', description: 'Five-digit Pennsylvania ZIP code, e.g. "19103", "15213".' },
        year: { type: 'string', description: `Registration year, one of ${YEARS.slice().sort().join(', ')}. Defaults to ${LATEST_YEAR}.` },
        quarter: { type: 'string', description: 'Quarter of that registration year: "Q1", "Q2", "Q3" or "Q4". Defaults to the latest quarter PennDOT has actually filed for that year.' },
        limit: { type: ['number', 'string'], description: 'Max ZIP codes to return (default 30, max 500).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Shared body of the two county tools: fetch the year, resolve one quarter for the whole
 * set, compute the statewide totals from every county, then narrow to the caller's county.
 * The statewide figures survive filtering and `limit` because they are taken before both.
 */
async function countyQuery(args: Record<string, unknown>, kind: 'ev' | 'registrations'): Promise<unknown> {
  const year = govString(args, 'year') ?? LATEST_YEAR;
  if (!YEARS.includes(year)) return badYear(year);

  const feats = await fetchCounties(year);
  if (!feats.length) {
    return govNotFound('upstream_empty', `PennDOT returned no county rows for ${year}. Retry once, or use year="${LATEST_YEAR}".`, { year });
  }

  const requestedQuarter = govString(args, 'quarter');
  const wanted = normQuarter(requestedQuarter);
  if (requestedQuarter && !wanted) {
    return govNotFound('unsupported_quarter', 'Pennsylvania quarters are "Q1", "Q2", "Q3" or "Q4". Omit the argument for the latest quarter with data.', {
      requested_quarter: requestedQuarter, supported_quarters: [...QUARTERS],
    });
  }
  const quarter = wanted ?? pickQuarter(feats);
  if (!quarter) {
    return govNotFound('no_quarter_with_data', `PennDOT has published no quarter of ${year} yet. Retry with year="${YEARS[1]}".`, { year });
  }

  const all = feats.map((f) => snapshot(f.attributes, 'COUNTY_NAME', quarter));
  const filed = all.filter((r) => r.total_registered_vehicles !== null || r.plug_in_vehicles !== null);
  if (!filed.length) {
    const alt = pickQuarter(feats);
    return govNotFound(
      'quarter_not_filed',
      `PennDOT has not filed ${year} ${quarter} for any county. Retry with quarter="${alt ?? 'Q1'}", which is the latest quarter carrying data for ${year}.`,
      { year, requested_quarter: quarter, latest_quarter_with_data: alt },
    );
  }

  // Every Pennsylvania county comes back in a single call, so these are real state totals.
  const statewideTotal = sumOf(filed, 'total_registered_vehicles');
  const statewidePlugIn = sumOf(filed, 'plug_in_vehicles');
  const statewideHybrid = sumOf(filed, 'hybrid_gasoline');

  const county = govString(args, 'county');
  let rows = filed;
  if (county) {
    const q = county.toUpperCase();
    rows = filed.filter((r) => r.name.toUpperCase().includes(q));
    if (!rows.length) {
      return govNotFound(
        'no_matching_county',
        `No Pennsylvania county matched "${county}" for ${year} ${quarter}. Use a bare county name such as county="Allegheny" or county="Montgomery", or omit the county argument to rank all 67.`,
        { year, quarter, requested_county: county, available_counties: filed.map((r) => r.name).sort() },
      );
    }
  }

  const byEv = kind === 'ev';
  rows = rows.slice().sort((a, b) =>
    byEv
      ? (b.plug_in_vehicles ?? 0) - (a.plug_in_vehicles ?? 0)
      : (b.total_registered_vehicles ?? 0) - (a.total_registered_vehicles ?? 0));
  const limit = govLimit(args.limit, 30, 70);
  const shown = rows.slice(0, limit);

  return {
    state: 'PA',
    grain: byEv
      ? `electric, plug-in hybrid and conventional hybrid registrations by county for ${year} ${quarter}`
      : `all registered vehicles by county for ${year} ${quarter}`,
    as_of: `${year} ${quarter}`,
    source: COUNTY_SOURCE,
    registration_year: year,
    quarter,
    statewide_total_vehicles: statewideTotal,
    statewide_plug_in_vehicles: statewidePlugIn,
    statewide_hybrid_gasoline_vehicles: statewideHybrid,
    statewide_ev_share_pct: statewideTotal ? Math.round((statewidePlugIn / statewideTotal) * 10000) / 100 : null,
    county_count: rows.length,
    sum_of_returned_rows: byEv ? sumOf(shown, 'plug_in_vehicles') : sumOf(shown, 'total_registered_vehicles'),
    truncated: rows.length > limit,
    rows: shown.map((r) => ({
      county: r.name,
      penndot_district: r.attrs.DISTRICT_NO ?? null,
      planning_partner: r.attrs.PLANNING_PARTNER ?? null,
      fips_county_code: r.attrs.FIPS_COUNTY_CODE ?? null,
      battery_electric: r.battery_electric,
      plug_in_hybrid: r.plug_in_hybrid,
      fuel_cell: r.fuel_cell,
      plug_in_vehicles: r.plug_in_vehicles,
      hybrid_gasoline: r.hybrid_gasoline,
      total_registered_vehicles: r.total_registered_vehicles,
      ev_share_pct: r.ev_share_pct,
      share_of_state_pct:
        statewideTotal && r.total_registered_vehicles !== null
          ? Math.round((r.total_registered_vehicles / statewideTotal) * 1000) / 10
          : null,
    })),
    note:
      'plug_in_vehicles = battery_electric + plug_in_hybrid + fuel_cell, matching PennDOT\'s own TOTAL_EV column. Conventional hybrids are counted separately in hybrid_gasoline and sit outside that figure, so a Prius appears there alone. '
      + 'PennDOT stores each quarter as its own set of columns rather than as rows, so `quarter` selects a column group; the default is the latest quarter carrying data across the state. '
      + 'statewide_total_vehicles covers all 67 counties and is a real Pennsylvania total; sum_of_returned_rows only covers the rows above.',
  };
}

async function evAdoption(args: Record<string, unknown>): Promise<unknown> {
  return countyQuery(args, 'ev');
}

async function vehicleRegistrations(args: Record<string, unknown>): Promise<unknown> {
  return countyQuery(args, 'registrations');
}

async function evAdoptionByZip(args: Record<string, unknown>): Promise<unknown> {
  const year = govString(args, 'year') ?? LATEST_YEAR;
  if (!YEARS.includes(year)) return badYear(year);

  const zip = govString(args, 'zip');
  const yearClause = `REGISTRATION_YEAR='${year.replace(/'/g, "''")}'`;
  // A single ZIP is a two-condition server-side query; ranking pulls the whole year
  // (~1,830 rows, inside the layer's 2,000 maxRecordCount) so the ordering is complete.
  const feats = await arcgisQuery(ZIP_LAYER, {
    where: zip ? `${yearClause} AND ZIP='${zip.replace(/'/g, "''")}'` : yearClause,
    outFields: ZIP_FIELDS,
    limit: 2000,
    userAgent: UA,
    timeoutMs: TIMEOUT_MS,
  });
  if (!feats.length) {
    return govNotFound(
      'no_matching_zip',
      zip
        ? `PennDOT has no ${year} row for ZIP ${zip}. Pennsylvania ZIP codes start 15 through 19 — try zip="19103" — or omit the zip argument to rank every Pennsylvania ZIP code.`
        : `PennDOT returned no ZIP rows for ${year}. Retry once, or use year="${LATEST_YEAR}".`,
      { year, requested_zip: zip },
    );
  }

  const requestedQuarter = govString(args, 'quarter');
  const wanted = normQuarter(requestedQuarter);
  if (requestedQuarter && !wanted) {
    return govNotFound('unsupported_quarter', 'Pennsylvania quarters are "Q1", "Q2", "Q3" or "Q4". Omit the argument for the latest quarter with data.', {
      requested_quarter: requestedQuarter, supported_quarters: [...QUARTERS],
    });
  }
  const quarter = wanted ?? pickQuarter(feats);
  if (!quarter) {
    return govNotFound(
      'no_quarter_with_data',
      zip
        ? `PennDOT has published no quarter of ${year} for ZIP ${zip}. Retry with year="${YEARS[1]}".`
        : `PennDOT has published no quarter of ${year} at ZIP level. Retry with year="${YEARS[1]}".`,
      { year, requested_zip: zip },
    );
  }

  const all = feats.map((f) => snapshot(f.attributes, 'ZIP', quarter));
  const filed = all.filter((r) => r.total_registered_vehicles !== null || r.plug_in_vehicles !== null);
  if (!filed.length) {
    return govNotFound(
      'quarter_not_filed',
      `PennDOT has not filed ${year} ${quarter} for ${zip ? `ZIP ${zip}` : 'any Pennsylvania ZIP code'}. Retry with quarter="Q1", or with year="${YEARS[1]}".`,
      { year, requested_quarter: quarter, requested_zip: zip },
    );
  }

  const rows = filed.slice().sort((a, b) => (b.plug_in_vehicles ?? 0) - (a.plug_in_vehicles ?? 0));
  const limit = govLimit(args.limit, 30, 500);
  const shown = rows.slice(0, limit);
  const rankedWholeState = !zip;
  const zipTotal = sumOf(filed, 'total_registered_vehicles');
  const zipPlugIn = sumOf(filed, 'plug_in_vehicles');

  return {
    state: 'PA',
    grain: `electric, plug-in hybrid and conventional hybrid registrations by ZIP code for ${year} ${quarter}`,
    as_of: `${year} ${quarter}`,
    source: ZIP_SOURCE,
    registration_year: year,
    quarter,
    zip_count: rows.length,
    // Only meaningful when the whole year was pulled; a single-ZIP call has no denominator.
    ...(rankedWholeState
      ? {
          zip_file_total_vehicles: zipTotal,
          zip_file_plug_in_vehicles: zipPlugIn,
          zip_file_ev_share_pct: zipTotal ? Math.round((zipPlugIn / zipTotal) * 10000) / 100 : null,
        }
      : {}),
    sum_of_returned_rows: sumOf(shown, 'plug_in_vehicles'),
    truncated: rows.length > limit,
    rows: shown.map((r) => ({
      zip: r.name,
      battery_electric: r.battery_electric,
      plug_in_hybrid: r.plug_in_hybrid,
      fuel_cell: r.fuel_cell,
      plug_in_vehicles: r.plug_in_vehicles,
      hybrid_gasoline: r.hybrid_gasoline,
      total_registered_vehicles: r.total_registered_vehicles,
      ev_share_pct: r.ev_share_pct,
    })),
    note:
      'plug_in_vehicles = battery_electric + plug_in_hybrid + fuel_cell; conventional hybrids are counted separately in hybrid_gasoline and sit outside that figure. '
      + 'plug_in_vehicles and ev_share_pct are computed from the component columns because this layer\'s published TOTAL_EV and PCT_EV columns fold conventional hybrids in for 2026 Q1 and express the share as a fraction there. '
      + 'PennDOT stores each quarter as its own set of columns rather than as rows, so `quarter` selects a column group. '
      + (rankedWholeState
        ? 'zip_file_total_vehicles sums every ZIP code PennDOT mapped, which runs about half a percent under the statewide county figure from pa_dmv_ev_adoption because a few registrations carry no usable ZIP code.'
        : 'For the authoritative statewide Pennsylvania total use pa_dmv_ev_adoption, which reads the county layer.'),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'pa_dmv_ev_adoption': return await evAdoption(args);
      case 'pa_dmv_vehicle_registrations': return await vehicleRegistrations(args);
      case 'pa_dmv_ev_adoption_by_zip': return await evAdoptionByZip(args);
      default:
        return govNotFound('unknown_tool', `pa-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `pa-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'gis.penndot.pa.gov timed out. Retry once, and lower `limit` or pass a `county` or `zip` so PennDOT returns fewer features.'
        : 'gis.penndot.pa.gov refused the request or changed shape. Retry once; if it persists PennDOT may have republished the layer, in which case the quarter columns are the first thing to check.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
