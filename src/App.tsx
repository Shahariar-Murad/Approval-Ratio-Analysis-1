import { ChangeEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Download,
  Globe2,
  ShieldAlert,
  Upload,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CheckoutSession,
  CountrySummary,
  CsvRow,
  DimensionSummary,
  Metrics,
  RatioMode,
  SessionFilters,
  availableTimeZones,
  approvedCustomers,
  approvedRevenue,
  calculateMetrics,
  dailyMetrics,
  dateKey,
  distinctSorted,
  filterSessions,
  parseTransactionRows,
  summarizeByDimension,
  summarizeCountries,
  topDeclineReason,
} from "./analysis";

type Tab = "overview" | "psp" | "country" | "mid" | "declines";
type ReasonClass = "all" | "Hard" | "Soft" | "Unclassified";

interface Option {
  value: string;
  label: string;
}

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "psp", label: "PSP performance" },
  { id: "country", label: "Country performance" },
  { id: "mid", label: "MID performance" },
  { id: "declines", label: "Decline reasons" },
];

const preferredTimeZones = [
  "UTC",
  "Asia/Dhaka",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Singapore",
];

function formatRatio(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function getDateBounds(sessions: CheckoutSession[], timeZone: string): { min: string; max: string } | null {
  if (!sessions.length) return null;
  const dates = sessions.map((session) => dateKey(session.timestamp, timeZone)).sort();
  return { min: dates[0], max: dates[dates.length - 1] };
}

function ratioModeLabel(mode: RatioMode): string {
  if (mode === "hard") return "Hard-decline cohort";
  if (mode === "soft") return "Soft-decline cohort";
  return "All terminal declines";
}

function metricDescription(mode: RatioMode): string {
  if (mode === "hard") return "Approved ÷ (approved + hard-declined checkout sessions)";
  if (mode === "soft") return "Approved ÷ (approved + soft-declined checkout sessions)";
  return "Approved checkout sessions ÷ all checkout sessions";
}

function reasonText(reason: { reason: string; code: string; count: number } | null): string {
  if (!reason) return "No terminal declines";
  return `${reason.reason} (${formatCount(reason.count)})`;
}

function reasonClassMatches(session: CheckoutSession, selected: ReasonClass): boolean {
  if (session.status !== "declined") return false;
  return selected === "all" || session.declineClass === selected;
}

function tableCsv(rows: Array<Record<string, string | number | null>>, filename: string): void {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const escape = (value: string | number | null): string => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function MetricCard({ title, subtitle, value, icon, tone }: { title: string; subtitle: string; value: string; icon: ReactNode; tone: string }): JSX.Element {
  return (
    <section className={`metric-card ${tone}`}>
      <div className="metric-card__top">
        <div>
          <p>{title}</p>
          <span>{subtitle}</span>
        </div>
        <div className="metric-card__icon">{icon}</div>
      </div>
      <strong>{value}</strong>
    </section>
  );
}

function MultiSelect({ label, options, value, onChange }: { label: string; options: Option[]; value: string[]; onChange: (value: string[]) => void }): JSX.Element {
  const update = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value));
  };
  return (
    <label className="filter-control filter-control--multi">
      <span>{label}</span>
      <select multiple value={value} onChange={update} size={Math.min(Math.max(options.length, 3), 5)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button type="button" className="clear-filter" onClick={() => onChange([])} disabled={!value.length}>Select all</button>
    </label>
  );
}

function Table({ children }: { children: ReactNode }): JSX.Element {
  return <div className="table-wrap"><table>{children}</table></div>;
}

function App(): JSX.Element {
  const [sessions, setSessions] = useState<CheckoutSession[]>([]);
  const [sourceStats, setSourceStats] = useState<{ sourceRows: number; usableAttempts: number; excludedRows: number; missingMerchantOrderId: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [timeZone, setTimeZone] = useState("UTC");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedPsps, setSelectedPsps] = useState<string[]>([]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedMids, setSelectedMids] = useState<string[]>([]);
  const [ratioMode, setRatioMode] = useState<RatioMode>("all");
  const [minimumPspSessions, setMinimumPspSessions] = useState(20);
  const [reasonClass, setReasonClass] = useState<ReasonClass>("all");

  const dateBounds = useMemo(() => getDateBounds(sessions, timeZone), [sessions, timeZone]);

  useEffect(() => {
    if (!dateBounds) return;
    setStartDate((current) => current >= dateBounds.min && current <= dateBounds.max ? current : dateBounds.min);
    setEndDate((current) => current >= dateBounds.min && current <= dateBounds.max ? current : dateBounds.max);
  }, [dateBounds?.min, dateBounds?.max]);

  const filters: SessionFilters | null = dateBounds && startDate && endDate ? {
    startDate,
    endDate,
    timeZone,
    psps: selectedPsps,
    countries: selectedCountries,
    mids: selectedMids,
  } : null;
  const filteredSessions = useMemo(
    () => filters ? filterSessions(sessions, filters) : [],
    [sessions, filters],
  );
  const allMetrics = useMemo(() => calculateMetrics(filteredSessions, "all"), [filteredSessions]);
  const hardMetrics = useMemo(() => calculateMetrics(filteredSessions, "hard"), [filteredSessions]);
  const softMetrics = useMemo(() => calculateMetrics(filteredSessions, "soft"), [filteredSessions]);
  const selectedMetrics = useMemo(() => calculateMetrics(filteredSessions, ratioMode), [filteredSessions, ratioMode]);
  const topReason = useMemo(() => topDeclineReason(filteredSessions, "all"), [filteredSessions]);
  const timeline = useMemo(() => dailyMetrics(filteredSessions, timeZone, ratioMode).map((row) => ({ ...row, rate: (row.approvalRatio ?? 0) * 100 })), [filteredSessions, ratioMode, timeZone]);
  const pspRows = useMemo(() => summarizeByDimension(filteredSessions, (session) => session.psp, ratioMode), [filteredSessions, ratioMode]);
  const countryRows = useMemo(() => summarizeCountries(filteredSessions, ratioMode, minimumPspSessions), [filteredSessions, ratioMode, minimumPspSessions]);
  const midRows = useMemo(() => summarizeByDimension(filteredSessions, (session) => session.mid, ratioMode), [filteredSessions, ratioMode]);

  const pspOptions = useMemo<Option[]>(() => distinctSorted(sessions.map((session) => session.psp)).map((value) => ({ value, label: value })), [sessions]);
  const countryOptions = useMemo<Option[]>(() => {
    const lookup = new Map<string, string>();
    sessions.forEach((session) => lookup.set(session.countryCode, session.countryLabel));
    return Array.from(lookup.entries()).map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
  }, [sessions]);
  const midOptions = useMemo<Option[]>(() => distinctSorted(sessions.map((session) => session.mid)).map((value) => ({ value, label: value })), [sessions]);
  const countryChart = useMemo(
    () => countryRows.slice(0, 12).map((row) => ({ country: row.countryName, rate: (row.approvalRatio ?? 0) * 100 })),
    [countryRows],
  );
  const pspChart = useMemo(
    () => pspRows.map((row) => ({ psp: row.dimension, rate: (row.approvalRatio ?? 0) * 100 })),
    [pspRows],
  );
  const declineRows = useMemo(() => {
    const buckets = new Map<string, { reason: string; code: string; classification: string; count: number; psps: Set<string>; countries: Set<string> }>();
    filteredSessions.filter((session) => reasonClassMatches(session, reasonClass)).forEach((session) => {
      const key = `${session.declineReason}\u0000${session.declineCode}\u0000${session.declineClass}`;
      const current = buckets.get(key) ?? {
        reason: session.declineReason,
        code: session.declineCode,
        classification: session.declineClass,
        count: 0,
        psps: new Set<string>(),
        countries: new Set<string>(),
      };
      current.count += 1;
      current.psps.add(session.psp);
      current.countries.add(session.countryCode);
      buckets.set(key, current);
    });
    return Array.from(buckets.values()).sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  }, [filteredSessions, reasonClass]);

  const handleUpload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setError(null);
    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (result) => {
        if (result.errors.length) {
          setError(`The CSV could not be parsed: ${result.errors[0].message}`);
          return;
        }
        const parsed = parseTransactionRows(result.data);
        if (!parsed.sessions.length) {
          setError(parsed.stats.missingMerchantOrderId
            ? "merchantOrderId is required to calculate the cascaded approval ratio."
            : "No approved or declined rows with a valid processing timestamp were found.");
          return;
        }
        setSessions(parsed.sessions);
        setSourceStats(parsed.stats);
        setFileName(file.name);
        setSelectedPsps([]);
        setSelectedCountries([]);
        setSelectedMids([]);
        setActiveTab("overview");
      },
      error: (uploadError) => setError(`The CSV could not be read: ${uploadError.message}`),
    });
    event.currentTarget.value = "";
  };

  const exportDeclineRows = (): void => {
    tableCsv(
      declineRows.map((row) => ({
        "Decline reason": row.reason,
        "Decline code": row.code,
        Classification: row.classification,
        "Terminal declined sessions": row.count,
        "PSPs affected": row.psps.size,
        "Countries affected": row.countries.size,
      })),
      "decline-reason-analysis.csv",
    );
  };

  const approvedSessionRevenue = useMemo(() => approvedRevenue(filteredSessions), [filteredSessions]);
  const averageRevenuePerDay = useMemo(() => {
    const days = new Set(filteredSessions.map((session) => dateKey(session.timestamp, timeZone))).size;
    return days ? approvedSessionRevenue / days : 0;
  }, [filteredSessions, approvedSessionRevenue, timeZone]);
  const approvedCountryCount = useMemo(
    () => new Set(filteredSessions.filter((session) => session.status === "approved").map((session) => session.countryCode)).size,
    [filteredSessions],
  );

  const timeZones = useMemo(() => distinctSorted([...preferredTimeZones, ...availableTimeZones()]), []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <span className="eyebrow">PAYMENTS INTELLIGENCE</span>
          <h1>Approval Ratio Analysis</h1>
          <p>Retry-safe merchant-order analytics for PSP, country, MID, and decline optimization.</p>
        </div>
        <label className="upload-button">
          <Upload size={18} />
          {fileName ? "Replace transaction CSV" : "Upload transaction CSV"}
          <input type="file" accept=".csv,text/csv" onChange={handleUpload} />
        </label>
      </header>

      {error && <div className="error-banner"><AlertTriangle size={18} /> {error}</div>}

      {!sessions.length ? (
        <main className="empty-state">
          <div className="empty-state__icon"><Activity size={36} /></div>
          <h2>Upload a transaction report to begin</h2>
          <p>The CSV stays in your browser. Required fields: <code>merchantOrderId</code>, <code>status</code>, and <code>processing_date</code> or <code>processingDate</code>.</p>
          <p>Each merchant order is counted once. Any successful PSP attempt turns the checkout session into one approval.</p>
        </main>
      ) : (
        <main className="dashboard-layout">
          <aside className="filter-panel">
            <div className="filter-panel__title">
              <div><span className="eyebrow">FILTERS</span><h2>Analysis controls</h2></div>
              <button type="button" className="reset-button" onClick={() => { setSelectedPsps([]); setSelectedCountries([]); setSelectedMids([]); setRatioMode("all"); }}>Reset</button>
            </div>
            <label className="filter-control">
              <span>Reporting timezone</span>
              <select value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
                {timeZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>
            {dateBounds && <div className="date-grid">
              <label className="filter-control"><span>Start date</span><input type="date" min={dateBounds.min} max={endDate || dateBounds.max} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
              <label className="filter-control"><span>End date</span><input type="date" min={startDate || dateBounds.min} max={dateBounds.max} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
            </div>}
            <label className="filter-control">
              <span>Approval-ratio denominator</span>
              <select value={ratioMode} onChange={(event) => setRatioMode(event.target.value as RatioMode)}>
                <option value="all">All terminal declines</option>
                <option value="hard">Hard declines only</option>
                <option value="soft">Soft declines only</option>
              </select>
              <small>{metricDescription(ratioMode)}</small>
            </label>
            <label className="filter-control">
              <span>Minimum PSP sessions per country</span>
              <input type="number" min="1" value={minimumPspSessions} onChange={(event) => setMinimumPspSessions(Math.max(1, Number(event.target.value) || 1))} />
            </label>
            <MultiSelect label="PSP" options={pspOptions} value={selectedPsps} onChange={setSelectedPsps} />
            <MultiSelect label="Country" options={countryOptions} value={selectedCountries} onChange={setSelectedCountries} />
            <MultiSelect label="MID" options={midOptions} value={selectedMids} onChange={setSelectedMids} />
          </aside>

          <section className="dashboard-content">
            <div className="reporting-line">
              <span>{fileName}</span>
              <span>{startDate} to {endDate} · {timeZone}</span>
            </div>
            <div className="metric-grid">
              <MetricCard title="CHECKOUT SESSIONS" subtitle="Unique merchant orders" value={formatCount(allMetrics.checkoutSessions)} icon={<Activity />} tone="metric-card--blue" />
              <MetricCard title="APPROVAL RATIO" subtitle="All terminal declines" value={formatRatio(allMetrics.approvalRatio)} icon={<CheckCircle2 />} tone="metric-card--green" />
              <MetricCard title="APPROVAL RATIO" subtitle="Hard-decline cohort" value={formatRatio(hardMetrics.approvalRatio)} icon={<ShieldAlert />} tone="metric-card--purple" />
              <MetricCard title="APPROVAL RATIO" subtitle="Soft-decline cohort" value={formatRatio(softMetrics.approvalRatio)} icon={<Activity />} tone="metric-card--cyan" />
              <MetricCard title="TOTAL REVENUE" subtitle="Approved sessions only" value={formatCurrency(approvedSessionRevenue)} icon={<CircleDollarSign />} tone="metric-card--teal" />
              <MetricCard title="AVERAGE REVENUE" subtitle="Per active day" value={formatCurrency(averageRevenuePerDay)} icon={<Activity />} tone="metric-card--violet" />
              <MetricCard title="ACTIVE CUSTOMERS" subtitle="Unique approved emails" value={formatCount(approvedCustomers(filteredSessions))} icon={<Users />} tone="metric-card--orange" />
              <MetricCard title="GLOBAL REACH" subtitle="Countries with approval" value={formatCount(approvedCountryCount)} icon={<Globe2 />} tone="metric-card--indigo" />
              <MetricCard title="TOP DECLINE REASON" subtitle="Terminal checkout sessions" value={reasonText(topReason)} icon={<AlertTriangle />} tone="metric-card--rose" />
            </div>

            <div className="data-quality">
              <span><b>{formatCount(sourceStats?.sourceRows ?? 0)}</b> source rows</span>
              <span><b>{formatCount(sourceStats?.usableAttempts ?? 0)}</b> usable attempts</span>
              <span><b>{formatCount(allMetrics.checkoutSessions)}</b> deduplicated checkout sessions</span>
              <span><b>{formatCount(allMetrics.unclassifiedDeclines)}</b> unclassified terminal declines</span>
            </div>

            <nav className="tabs" aria-label="Analysis sections">
              {tabs.map((tab) => <button type="button" key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
            </nav>

            {activeTab === "overview" && <OverviewTab timeline={timeline} allMetrics={allMetrics} selectedMetrics={selectedMetrics} ratioMode={ratioMode} />}
            {activeTab === "psp" && <PspTab rows={pspRows} chart={pspChart} ratioMode={ratioMode} />}
            {activeTab === "country" && <CountryTab rows={countryRows} chart={countryChart} ratioMode={ratioMode} minimumPspSessions={minimumPspSessions} />}
            {activeTab === "mid" && <MidTab rows={midRows} ratioMode={ratioMode} />}
            {activeTab === "declines" && <DeclinesTab reasonClass={reasonClass} setReasonClass={setReasonClass} rows={declineRows} onExport={exportDeclineRows} />}
            <p className="definition-note">Current analysis view: <b>{ratioModeLabel(ratioMode)}</b>. A checkout is approved when any retry succeeds; otherwise its final decline is counted once.</p>
          </section>
        </main>
      )}
    </div>
  );
}

function OverviewTab({ timeline, allMetrics, selectedMetrics, ratioMode }: { timeline: Array<Metrics & { date: string; rate: number }>; allMetrics: Metrics; selectedMetrics: Metrics; ratioMode: RatioMode }): JSX.Element {
  return <section className="tab-panel">
    <div className="panel-heading"><div><span className="eyebrow">CASCADED PERFORMANCE</span><h2>Approval ratio over time</h2></div><p>{metricDescription(ratioMode)}</p></div>
    <div className="chart-card">
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={timeline} margin={{ top: 8, right: 22, bottom: 8, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e9f2" />
          <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: "#64748b", fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} />
          <Line type="monotone" dataKey="rate" name="Approval ratio" stroke="#14b87a" strokeWidth={3} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <div className="overview-breakdown">
      <div><span>All terminal declines</span><b>{formatRatio(allMetrics.approvalRatio)}</b><small>{formatCount(allMetrics.approved)} approved / {formatCount(allMetrics.checkoutSessions)} sessions</small></div>
      <div><span>{ratioModeLabel(ratioMode)}</span><b>{formatRatio(selectedMetrics.approvalRatio)}</b><small>{formatCount(selectedMetrics.approved)} approved / {formatCount(selectedMetrics.denominator)} denominator</small></div>
      <div><span>Terminal decline mix</span><b>{formatCount(allMetrics.declined)}</b><small>{formatCount(allMetrics.hardDeclines)} hard · {formatCount(allMetrics.softDeclines)} soft</small></div>
    </div>
  </section>;
}

function PspTab({ rows, chart, ratioMode }: { rows: DimensionSummary[]; chart: Array<{ psp: string; rate: number }>; ratioMode: RatioMode }): JSX.Element {
  return <section className="tab-panel">
    <div className="panel-heading"><div><span className="eyebrow">PSP PERFORMANCE</span><h2>Approval ratio and top decline reason</h2></div><p>{ratioModeLabel(ratioMode)}</p></div>
    <div className="chart-card">
      <ResponsiveContainer width="100%" height={320}><BarChart data={chart} margin={{ top: 8, right: 22, bottom: 8, left: -8 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e9f2" /><XAxis dataKey="psp" tick={{ fill: "#64748b", fontSize: 12 }} tickLine={false} axisLine={false} /><YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: "#64748b", fontSize: 12 }} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} /><Bar dataKey="rate" name="Approval ratio" fill="#3b82f6" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
    </div>
    <DimensionTable label="PSP" rows={rows} />
  </section>;
}

function CountryTab({ rows, chart, ratioMode, minimumPspSessions }: { rows: CountrySummary[]; chart: Array<{ country: string; rate: number }>; ratioMode: RatioMode; minimumPspSessions: number }): JSX.Element {
  return <section className="tab-panel">
    <div className="panel-heading"><div><span className="eyebrow">COUNTRY PERFORMANCE</span><h2>Highest-performing PSP by country</h2></div><p>PSPs need at least {formatCount(minimumPspSessions)} sessions. Highest PSP uses final approval on first-routed orders.</p></div>
    <div className="chart-card">
      <ResponsiveContainer width="100%" height={340}><BarChart data={chart} layout="vertical" margin={{ top: 8, right: 22, bottom: 8, left: 90 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e4e9f2" /><XAxis type="number" domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: "#64748b", fontSize: 12 }} tickLine={false} axisLine={false} /><YAxis type="category" dataKey="country" width={90} tick={{ fill: "#64748b", fontSize: 12 }} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} /><Bar dataKey="rate" name="Approval ratio" fill="#0ea5e9" radius={[0, 6, 6, 0]} /></BarChart></ResponsiveContainer>
    </div>
    <Table><thead><tr><th>Country</th><th>Checkout sessions</th><th>Approval ratio</th><th>Highest-performing PSP</th><th>Highest PSP rate</th><th>Top decline reason</th></tr></thead><tbody>{rows.map((row) => <tr key={row.countryCode}><td><b>{row.countryLabel}</b></td><td>{formatCount(row.checkoutSessions)}</td><td>{formatRatio(row.approvalRatio)}</td><td>{row.highestPerformingPsp ?? "No PSP met volume threshold"}</td><td>{formatRatio(row.highestPspApprovalRatio)}</td><td>{reasonText(row.topDeclineReason)}</td></tr>)}</tbody></Table>
    <p className="definition-note">Country approval ratio currently reflects {ratioModeLabel(ratioMode).toLowerCase()}. The highest PSP rate always uses the standard all-terminal-decline ratio.</p>
  </section>;
}

function MidTab({ rows, ratioMode }: { rows: DimensionSummary[]; ratioMode: RatioMode }): JSX.Element {
  return <section className="tab-panel"><div className="panel-heading"><div><span className="eyebrow">MID PERFORMANCE</span><h2>MID approval ratio and decline concentration</h2></div><p>{ratioModeLabel(ratioMode)}</p></div><DimensionTable label="MID" rows={rows} /></section>;
}

function DimensionTable({ label, rows }: { label: string; rows: DimensionSummary[] }): JSX.Element {
  return <Table><thead><tr><th>{label}</th><th>Checkout sessions</th><th>Approved</th><th>Hard</th><th>Soft</th><th>Approval ratio</th><th>Top decline reason</th></tr></thead><tbody>{rows.map((row) => <tr key={row.dimension}><td><b>{row.dimension}</b></td><td>{formatCount(row.checkoutSessions)}</td><td>{formatCount(row.approved)}</td><td>{formatCount(row.hardDeclines)}</td><td>{formatCount(row.softDeclines)}</td><td>{formatRatio(row.approvalRatio)}</td><td>{reasonText(row.topDeclineReason)}</td></tr>)}</tbody></Table>;
}

function DeclinesTab({ reasonClass, setReasonClass, rows, onExport }: { reasonClass: ReasonClass; setReasonClass: (value: ReasonClass) => void; rows: Array<{ reason: string; code: string; classification: string; count: number; psps: Set<string>; countries: Set<string> }>; onExport: () => void }): JSX.Element {
  return <section className="tab-panel"><div className="panel-heading"><div><span className="eyebrow">DECLINE ANALYSIS</span><h2>Top terminal decline reasons</h2></div><button type="button" className="export-button" onClick={onExport}><Download size={16} /> Download CSV</button></div><div className="segmented-control">{(["all", "Hard", "Soft", "Unclassified"] as ReasonClass[]).map((value) => <button type="button" key={value} className={reasonClass === value ? "active" : ""} onClick={() => setReasonClass(value)}>{value === "all" ? "All declines" : `${value} declines`}</button>)}</div><Table><thead><tr><th>Rank</th><th>Decline reason</th><th>Code</th><th>Class</th><th>Terminal declined sessions</th><th>PSPs</th><th>Countries</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.reason}-${row.code}-${row.classification}`}><td>{index + 1}</td><td><b>{row.reason}</b></td><td>{row.code}</td><td><span className={`class-badge class-badge--${row.classification.toLowerCase()}`}>{row.classification}</span></td><td>{formatCount(row.count)}</td><td>{formatCount(row.psps.size)}</td><td>{formatCount(row.countries.size)}</td></tr>)}</tbody></Table></section>;
}

export default App;
