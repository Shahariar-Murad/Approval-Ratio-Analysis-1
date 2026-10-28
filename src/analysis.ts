import moment from "moment-timezone";

export type CsvRow = Record<string, string>;
export type DeclineClass = "Hard" | "Soft" | "Unclassified" | "Not declined";
export type RatioMode = "all" | "hard" | "soft";

interface TransactionAttempt {
  merchantOrderId: string;
  status: "approved" | "declined";
  timestamp: number;
  psp: string;
  countryCode: string;
  countryName: string;
  countryLabel: string;
  mid: string;
  declineReason: string;
  declineCode: string;
  amount: number;
  email: string;
}

export interface CheckoutSession {
  merchantOrderId: string;
  status: "approved" | "declined";
  timestamp: number;
  terminalTimestamp: number;
  psp: string;
  countryCode: string;
  countryName: string;
  countryLabel: string;
  mid: string;
  declineClass: DeclineClass;
  declineReason: string;
  declineCode: string;
  amount: number;
  email: string;
  attemptsInSession: number;
  pspsTried: number;
}

export interface ParseStats {
  sourceRows: number;
  usableAttempts: number;
  checkoutSessions: number;
  excludedRows: number;
  missingMerchantOrderId: number;
}

export interface ParseResult {
  sessions: CheckoutSession[];
  stats: ParseStats;
}

export interface Metrics {
  checkoutSessions: number;
  approved: number;
  declined: number;
  hardDeclines: number;
  softDeclines: number;
  unclassifiedDeclines: number;
  denominator: number;
  approvalRatio: number | null;
}

export interface ReasonSummary {
  reason: string;
  code: string;
  count: number;
}

export interface DimensionSummary extends Metrics {
  dimension: string;
  topDeclineReason: ReasonSummary | null;
}

export interface CountrySummary extends Metrics {
  countryCode: string;
  countryName: string;
  countryLabel: string;
  highestPerformingPsp: string | null;
  highestPspApprovalRatio: number | null;
  pspsCompared: number;
  topDeclineReason: ReasonSummary | null;
}

export interface SessionFilters {
  startDate: string;
  endDate: string;
  timeZone: string;
  psps: string[];
  countries: string[];
  mids: string[];
}

const countryDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });

const hardPatterns = [
  /\b(?:suspected\s+)?fraud\b/i,
  /\b(?:risk(?:\s+management|\s+rule)?|policy)\b/i,
  /\b(?:insufficient|not\s+sufficient)\s+funds\b/i,
  /\b(?:daily|withdrawal|transaction|spending)\s+limit\b/i,
  /\b(?:over\s+credit\s+limit|limit\s+exceeded)\b/i,
  /\b(?:banned|blacklist(?:ed)?|blocked)\b.*\bcard\b/i,
  /\b(?:lost|stolen|expired|restricted)\s+card\b/i,
  /\b(?:invalid\s+(?:card|account)|no\s+such\s+(?:account|issuer))\b/i,
  /\b(?:security\s+violation|transaction\s+not\s+permitted|pick\s*up\s+card)\b/i,
  /\b(?:account\s+(?:related\s+)?issue|account\s+not\s+registered|registration\s+is\s+not\s+confirmed)\b/i,
  /(?:^|\D)(?:04|07|14|15|41|43|54|57|58|59|62|63|78|83|93|60110)(?:$|\D)/,
];

const softPatterns = [
  /\b(?:do\s+not\s+honou?r|issuer\s+(?:declined|unavailable)|bank\s+declined)\b/i,
  /\b(?:3d\s*secure|3ds|authentication|verification|avs)\b/i,
  /\b(?:temporary|temporarily|timeout|timed\s*out|system\s+malfunction|technical)\b/i,
  /\b(?:generic\s+decline|re-?enter\s+transaction|try\s+again|processing\s+error)\b/i,
  /\b(?:cancel(?:led|ed)\s+by\s+(?:the\s+)?user|customer\s+cancellation)\b/i,
];

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function getField(row: CsvRow, candidates: string[]): string {
  const headers = Object.keys(row);
  for (const candidate of candidates) {
    const exact = headers.find((header) => header.toLowerCase() === candidate.toLowerCase());
    if (exact !== undefined) return (row[exact] ?? "").trim();
  }
  for (const candidate of candidates) {
    const normalized = normalizeHeader(candidate).replace(/_/g, "");
    const matched = headers.find(
      (header) => normalizeHeader(header).replace(/_/g, "") === normalized,
    );
    if (matched !== undefined) return (row[matched] ?? "").trim();
  }
  return "";
}

function parseTimestamp(row: CsvRow): number | null {
  const iso = getField(row, ["processing_date", "processing_time", "processingTime", "processed_at"]);
  if (iso) {
    const parsed = moment.parseZone(iso);
    if (parsed.isValid()) return parsed.utc().valueOf();
  }
  const epoch = getField(row, ["processingDate", "processing_date_epoch"]);
  if (!epoch) return null;
  const numeric = Number(epoch);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
  return moment.utc(milliseconds).isValid() ? milliseconds : null;
}

function parseAmount(value: string): number {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function countryNameFromCode(rawCode: string): { code: string; name: string; label: string } {
  const code = rawCode.trim().toUpperCase() || "Unknown";
  const normalized = code === "UK" ? "GB" : code;
  if (normalized === "Unknown") {
    return { code, name: "Country not provided", label: "Country not provided" };
  }
  try {
    const name = countryDisplayNames.of(normalized) ?? `Unknown country (${normalized})`;
    return { code: normalized, name, label: `${name} (${normalized})` };
  } catch {
    return { code: normalized, name: `Unknown country (${normalized})`, label: `Unknown country (${normalized})` };
  }
}

export function classifyDecline(reason: string, code: string): DeclineClass {
  const source = `${reason} ${code}`.trim();
  if (hardPatterns.some((pattern) => pattern.test(source))) return "Hard";
  if (softPatterns.some((pattern) => pattern.test(source))) return "Soft";
  return "Unclassified";
}

export function parseTransactionRows(rows: CsvRow[]): ParseResult {
  const grouped = new Map<string, TransactionAttempt[]>();
  let usableAttempts = 0;
  let missingMerchantOrderId = 0;

  for (const row of rows) {
    const status = getField(row, ["status"]).toLowerCase();
    if (status !== "approved" && status !== "declined") continue;
    const merchantOrderId = getField(row, ["merchantOrderId", "merchant_order_id"]);
    if (!merchantOrderId) {
      missingMerchantOrderId += 1;
      continue;
    }
    const timestamp = parseTimestamp(row);
    if (timestamp === null) continue;

    const country = countryNameFromCode(getField(row, ["country", "countryCode"]));
    const attempt: TransactionAttempt = {
      merchantOrderId,
      status,
      timestamp,
      psp: getField(row, ["pspName", "psp", "provider"]) || "PSP not provided",
      countryCode: country.code,
      countryName: country.name,
      countryLabel: country.label,
      mid: getField(row, ["midAlias", "mid", "merchant_id"]) || "MID not provided",
      declineReason:
        getField(row, ["declineReason", "statusReason", "decline_reason", "status_reason"]) ||
        "Reason not provided",
      declineCode: getField(row, ["declineCode", "decline_code"]) || "Code not provided",
      amount: parseAmount(getField(row, ["amount"])),
      email: getField(row, ["email"]).toLowerCase(),
    };
    const current = grouped.get(merchantOrderId) ?? [];
    current.push(attempt);
    grouped.set(merchantOrderId, current);
    usableAttempts += 1;
  }

  const sessions = Array.from(grouped.entries(), ([merchantOrderId, attempts]) => {
    const ordered = [...attempts].sort((left, right) => left.timestamp - right.timestamp);
    const firstAttempt = ordered[0];
    const approvals = ordered.filter((attempt) => attempt.status === "approved");
    const selectedAttempt = approvals.length ? approvals[approvals.length - 1] : ordered[ordered.length - 1];
    const status: CheckoutSession["status"] = approvals.length ? "approved" : "declined";
    const declineClass = status === "declined"
      ? classifyDecline(selectedAttempt.declineReason, selectedAttempt.declineCode)
      : "Not declined";

    return {
      merchantOrderId,
      status,
      // Attribute reporting to the first routed PSP/country/MID while retaining
      // the terminal failure reason or final success outcome.
      timestamp: firstAttempt.timestamp,
      terminalTimestamp: selectedAttempt.timestamp,
      psp: firstAttempt.psp,
      countryCode: firstAttempt.countryCode,
      countryName: firstAttempt.countryName,
      countryLabel: firstAttempt.countryLabel,
      mid: firstAttempt.mid,
      declineClass,
      declineReason: status === "declined" ? selectedAttempt.declineReason : "",
      declineCode: status === "declined" ? selectedAttempt.declineCode : "",
      amount: status === "approved" ? selectedAttempt.amount : 0,
      email: selectedAttempt.email || firstAttempt.email,
      attemptsInSession: ordered.length,
      pspsTried: new Set(ordered.map((attempt) => attempt.psp)).size,
    };
  });

  return {
    sessions,
    stats: {
      sourceRows: rows.length,
      usableAttempts,
      checkoutSessions: sessions.length,
      excludedRows: rows.length - usableAttempts,
      missingMerchantOrderId,
    },
  };
}

export function dateKey(timestamp: number, timeZone: string): string {
  return moment.utc(timestamp).tz(timeZone).format("YYYY-MM-DD");
}

export function filterSessions(sessions: CheckoutSession[], filters: SessionFilters): CheckoutSession[] {
  return sessions.filter((session) => {
    const localDate = dateKey(session.timestamp, filters.timeZone);
    if (localDate < filters.startDate || localDate > filters.endDate) return false;
    if (filters.psps.length && !filters.psps.includes(session.psp)) return false;
    if (filters.countries.length && !filters.countries.includes(session.countryCode)) return false;
    if (filters.mids.length && !filters.mids.includes(session.mid)) return false;
    return true;
  });
}

export function calculateMetrics(sessions: CheckoutSession[], mode: RatioMode = "all"): Metrics {
  const approved = sessions.filter((session) => session.status === "approved").length;
  const declined = sessions.length - approved;
  const hardDeclines = sessions.filter((session) => session.declineClass === "Hard").length;
  const softDeclines = sessions.filter((session) => session.declineClass === "Soft").length;
  const unclassifiedDeclines = sessions.filter((session) => session.declineClass === "Unclassified").length;
  const selectedDeclines = mode === "hard" ? hardDeclines : mode === "soft" ? softDeclines : declined;
  const denominator = approved + selectedDeclines;
  return {
    checkoutSessions: sessions.length,
    approved,
    declined,
    hardDeclines,
    softDeclines,
    unclassifiedDeclines,
    denominator,
    approvalRatio: denominator ? approved / denominator : null,
  };
}

function declineSessionsForReason(sessions: CheckoutSession[], cohort: RatioMode | "unclassified"): CheckoutSession[] {
  return sessions.filter((session) => {
    if (session.status !== "declined") return false;
    if (cohort === "all") return true;
    if (cohort === "hard") return session.declineClass === "Hard";
    if (cohort === "soft") return session.declineClass === "Soft";
    return session.declineClass === "Unclassified";
  });
}

export function topDeclineReason(
  sessions: CheckoutSession[],
  cohort: RatioMode | "unclassified" = "all",
): ReasonSummary | null {
  const counts = new Map<string, ReasonSummary>();
  for (const session of declineSessionsForReason(sessions, cohort)) {
    const key = `${session.declineReason}\u0000${session.declineCode}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { reason: session.declineReason, code: session.declineCode, count: 1 });
    }
  }
  return Array.from(counts.values()).sort(
    (left, right) => right.count - left.count || left.reason.localeCompare(right.reason),
  )[0] ?? null;
}

function groupedSessions(sessions: CheckoutSession[], key: (session: CheckoutSession) => string): Map<string, CheckoutSession[]> {
  const result = new Map<string, CheckoutSession[]>();
  for (const session of sessions) {
    const bucket = result.get(key(session)) ?? [];
    bucket.push(session);
    result.set(key(session), bucket);
  }
  return result;
}

export function summarizeByDimension(
  sessions: CheckoutSession[],
  getDimension: (session: CheckoutSession) => string,
  mode: RatioMode,
): DimensionSummary[] {
  return Array.from(groupedSessions(sessions, getDimension), ([dimension, rows]) => ({
    dimension,
    ...calculateMetrics(rows, mode),
    topDeclineReason: topDeclineReason(rows, mode),
  })).sort(
    (left, right) => (right.approvalRatio ?? -1) - (left.approvalRatio ?? -1) || right.checkoutSessions - left.checkoutSessions,
  );
}

export function summarizeCountries(
  sessions: CheckoutSession[],
  mode: RatioMode,
  minimumPspSessions: number,
): CountrySummary[] {
  const countries = groupedSessions(sessions, (session) => session.countryCode);
  return Array.from(countries.entries(), ([countryCode, rows]) => {
    const pspRows = Array.from(groupedSessions(rows, (session) => session.psp), ([psp, pspSessions]) => ({
      psp,
      metrics: calculateMetrics(pspSessions, "all"),
    })).filter((entry) => entry.metrics.checkoutSessions >= minimumPspSessions);
    const topPsp = pspRows.sort(
      (left, right) =>
        (right.metrics.approvalRatio ?? -1) - (left.metrics.approvalRatio ?? -1) ||
        right.metrics.checkoutSessions - left.metrics.checkoutSessions ||
        left.psp.localeCompare(right.psp),
    )[0];
    const reference = rows[0];
    return {
      countryCode,
      countryName: reference.countryName,
      countryLabel: reference.countryLabel,
      ...calculateMetrics(rows, mode),
      highestPerformingPsp: topPsp?.psp ?? null,
      highestPspApprovalRatio: topPsp?.metrics.approvalRatio ?? null,
      pspsCompared: pspRows.length,
      topDeclineReason: topDeclineReason(rows, "all"),
    };
  }).sort(
    (left, right) => right.checkoutSessions - left.checkoutSessions || left.countryName.localeCompare(right.countryName),
  );
}

export function dailyMetrics(sessions: CheckoutSession[], timeZone: string, mode: RatioMode): Array<Metrics & { date: string }> {
  return Array.from(groupedSessions(sessions, (session) => dateKey(session.timestamp, timeZone)), ([date, rows]) => ({
    date,
    ...calculateMetrics(rows, mode),
  })).sort((left, right) => left.date.localeCompare(right.date));
}

export function distinctSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function availableTimeZones(): string[] {
  return moment.tz.names();
}

export function approvedRevenue(sessions: CheckoutSession[]): number {
  return sessions.filter((session) => session.status === "approved").reduce((total, session) => total + session.amount, 0);
}

export function approvedCustomers(sessions: CheckoutSession[]): number {
  return new Set(
    sessions.filter((session) => session.status === "approved" && session.email).map((session) => session.email),
  ).size;
}
