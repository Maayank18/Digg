import Highcharts from "highcharts";
import HighchartsReact from "highcharts-react-official";
import { Component, type ReactNode, useMemo } from "react";
import { useAppearance } from "../components/Shell";
import type { LensBar } from "./lens-insights";

const COLORS = ["#5b7cfa", "#f0a202", "#2fbf71", "#ef6f6c", "#8b6cf6", "#3db8c9", "#e85d9a", "#7d8da1"];
const REST = /^(other|no )|not stated|unknown|not contacted/i;

export type PlotKind = "pie" | "column" | "bar";

/** Pie when the parts are a whole. Columns for a short comparison. Bars when the names are long. */
export function plotKind(chart: "pie" | undefined, bars: LensBar[]): PlotKind | null {
  const alive = bars.some((bar) => bar.count > 0);
  if (!alive) return null;
  if (chart === "pie") return "pie";
  const long = bars.some((bar) => bar.label.length > 16);
  return long || bars.length > 6 ? "bar" : "column";
}

export function LensPlot({ bars, kind, title }: { bars: LensBar[]; kind: PlotKind; title: string }) {
  return (
    <ChartBoundary bars={bars}>
      <Plot bars={bars} kind={kind} title={title} />
    </ChartBoundary>
  );
}

function Plot({ bars, kind, title }: { bars: LensBar[]; kind: PlotKind; title: string }) {
  const [theme] = useAppearance();
  const rows = useMemo(() => (kind === "pie" ? bars.filter((bar) => bar.count > 0) : bars), [bars, kind]);
  const options = useMemo(() => (rows.length ? chartOptions(rows, kind, title, theme) : null), [rows, kind, title, theme]);
  if (!options) return <FallbackBars bars={bars} />;
  const height = kind === "bar" ? Math.min(340, Math.max(168, rows.length * 36 + 36)) : kind === "pie" ? 280 : 230;
  return (
    <div className="lens2-plot" style={{ height }}>
      <HighchartsReact
        highcharts={Highcharts}
        options={options}
        containerProps={{ style: { width: "100%", height: "100%" } }}
      />
    </div>
  );
}

function chartOptions(rows: LensBar[], kind: PlotKind, title: string, theme: "light" | "dark"): Highcharts.Options {
  const ink = theme === "dark" ? "#f5f5f7" : "#1d1d1f";
  const muted = theme === "dark" ? "#aeaeb2" : "#6e6e73";
  const grid = theme === "dark" ? "#3a3a3c" : "#ececf1";
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const points = rows.map((row, index) => ({
    name: row.label,
    y: row.count,
    color: REST.test(row.label) ? "#9aa3b2" : COLORS[index % COLORS.length],
  }));
  return {
    chart: {
      type: kind,
      backgroundColor: "transparent",
      animation: { duration: 350 },
      height: null,
      spacing: [8, 8, 4, 8],
      style: { fontFamily: "inherit" },
    },
    title: kind === "pie"
      ? { text: String(total), align: "center", verticalAlign: "middle", y: -18, style: { color: ink, fontSize: "22px", fontWeight: "700" } }
      : { text: undefined },
    subtitle: kind === "pie"
      ? { text: "total", align: "center", verticalAlign: "middle", y: 2, style: { color: muted, fontSize: "11px", fontWeight: "500" } }
      : { text: undefined },
    credits: { enabled: false },
    accessibility: { enabled: false },
    legend: {
      enabled: kind === "pie",
      align: "center",
      verticalAlign: "bottom",
      layout: "horizontal",
      itemStyle: { color: ink, fontWeight: "500", fontSize: "12px" },
      itemHoverStyle: { color: ink },
      itemDistance: 12,
    },
    xAxis: {
      categories: rows.map((row) => row.label),
      lineColor: grid,
      labels: { style: { color: ink, fontSize: "11px" } },
    },
    yAxis: {
      title: { text: undefined },
      allowDecimals: false,
      gridLineColor: grid,
      labels: { style: { color: muted, fontSize: "11px" } },
    },
    tooltip: {
      backgroundColor: theme === "dark" ? "#2c2c2e" : "#ffffff",
      borderColor: theme === "dark" ? "#48484a" : "#e4e4e8",
      style: { color: ink, fontSize: "12px" },
      headerFormat: "",
      pointFormatter() {
        const count = Number(this.y ?? 0);
        const share = total > 0 ? Math.round((count / total) * 100) : 0;
        return `<b>${this.name || this.category}</b><br>${count} · ${share}% of ${total}`;
      },
    },
    plotOptions: {
      series: { animation: { duration: 350 } },
      column: {
        borderWidth: 0,
        borderRadius: 5,
        colorByPoint: true,
        pointPadding: 0.08,
        groupPadding: 0.12,
        dataLabels: { enabled: true, style: { color: ink, fontSize: "11px", fontWeight: "600", textOutline: "none" } },
      },
      bar: {
        borderWidth: 0,
        borderRadius: 5,
        colorByPoint: true,
        pointPadding: 0.08,
        groupPadding: 0.08,
        dataLabels: { enabled: true, style: { color: ink, fontSize: "11px", fontWeight: "600", textOutline: "none" } },
      },
      pie: {
        innerSize: "58%",
        size: "78%",
        center: ["50%", "46%"],
        borderWidth: 2,
        borderColor: theme === "dark" ? "#2c2c2e" : "#ffffff",
        showInLegend: true,
        dataLabels: { enabled: false },
      },
    },
    series: [{ type: kind, name: title, data: points }],
  };
}

function FallbackBars({ bars }: { bars: LensBar[] }) {
  const shown = bars.filter((bar) => bar.count > 0);
  const max = Math.max(1, ...shown.map((bar) => bar.count));
  if (!shown.length) return null;
  return (
    <ul className="lens2-bars">
      {shown.map((bar) => (
        <li key={bar.label}>
          <span className="lens2-bar-label" title={bar.label}>{bar.label}</span>
          <span className="lens2-bar-track"><span className="lens2-bar-fill" style={{ width: `${(bar.count / max) * 100}%` }} /></span>
          <span className="lens2-bar-count">{bar.count}</span>
        </li>
      ))}
    </ul>
  );
}

class ChartBoundary extends Component<{ bars: LensBar[]; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <FallbackBars bars={this.props.bars} />;
    return this.props.children;
  }
}
