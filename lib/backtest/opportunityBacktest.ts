export interface OpportunitySignal {
  code: string;
  name: string;
  category: "A" | "B" | "C";
  signalDate: string;
  triggerType: string;
  score: number;
}

export interface BacktestBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  amount?: number;
}

export interface OpportunityBacktestResult {
  sampleSize: number;
  winRate: number;
  averageReturn1d: number;
  averageReturn3d: number;
  averageReturn5d: number;
  maxDrawdown: number;
  profitLossRatio: number;
  costAdjustedReturn: number;
}

export function runOpportunityBacktest(
  signals: OpportunitySignal[],
  historyByCode: Record<string, BacktestBar[]>,
  options = { tradingCostRate: 0.0015 }
): OpportunityBacktestResult {
  const trades = signals.flatMap((signal) => {
    const bars = historyByCode[signal.code] || [];
    const index = bars.findIndex((bar) => bar.date === signal.signalDate);
    if (index < 0 || index + 5 >= bars.length) return [];
    const entry = bars[index + 1].open || bars[index].close;
    const ret = (days: number) => bars[index + days].close / entry - 1 - options.tradingCostRate;
    return [{ r1: ret(1), r3: ret(3), r5: ret(5) }];
  });

  if (!trades.length) {
    return {
      sampleSize: 0,
      winRate: 0,
      averageReturn1d: 0,
      averageReturn3d: 0,
      averageReturn5d: 0,
      maxDrawdown: 0,
      profitLossRatio: 0,
      costAdjustedReturn: 0
    };
  }

  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const r5 = trades.map((trade) => trade.r5);
  const wins = r5.filter((value) => value > 0);
  const losses = r5.filter((value) => value < 0);
  const equity = r5.reduce<number[]>((series, value) => {
    series.push(series[series.length - 1] * (1 + value));
    return series;
  }, [1]);
  let peak = equity[0];
  let maxDrawdown = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
  }

  return {
    sampleSize: trades.length,
    winRate: wins.length / trades.length,
    averageReturn1d: avg(trades.map((trade) => trade.r1)),
    averageReturn3d: avg(trades.map((trade) => trade.r3)),
    averageReturn5d: avg(r5),
    maxDrawdown,
    profitLossRatio: losses.length ? avg(wins) / Math.abs(avg(losses)) : 0,
    costAdjustedReturn: equity[equity.length - 1] - 1
  };
}
