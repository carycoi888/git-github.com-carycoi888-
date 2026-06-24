export type MarketRegime = "attack" | "neutral" | "defensive" | "highRisk";
export type CandidateCategory = "A" | "B" | "C";

export interface SectorScoreInput {
  todayPct: number;
  threeDayPct: number;
  amountExpansion: number;
  fundInflow: number;
  limitOrSurgeCount: number;
}

export interface StockScoreInput {
  sectorRankScore: number;
  mainFundScore: number;
  turnoverExpansionScore: number;
  technicalScore: number;
  volumeQualityScore: number;
  riskDistanceScore: number;
}

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

export function calculateSectorScore(input: SectorScoreInput): number {
  const today = clamp(input.todayPct * 4 + 8, 0, 20);
  const threeDay = clamp(input.threeDayPct * 3 + 8, 0, 20);
  const amount = clamp(input.amountExpansion, 0, 100) * 0.2;
  const fund = clamp(input.fundInflow, 0, 100) * 0.2;
  const limit = clamp(input.limitOrSurgeCount * 4, 0, 20);
  return Math.round(today + threeDay + amount + fund + limit);
}

export function calculateStockScore(input: StockScoreInput): number {
  return Math.round(
    clamp(input.sectorRankScore) * 0.25 +
    clamp(input.mainFundScore * 0.65 + input.turnoverExpansionScore * 0.35) * 0.2 +
    clamp(input.technicalScore) * 0.25 +
    clamp(input.volumeQualityScore) * 0.15 +
    clamp(input.riskDistanceScore) * 0.15
  );
}

export function classifyCandidate(score: number, hasHighRiskFlag: boolean): CandidateCategory {
  if (score >= 80 && !hasHighRiskFlag) return "A";
  if (score >= 65) return "B";
  return "C";
}

export function recommendedPositionRange(regime: MarketRegime): string {
  return {
    highRisk: "0 - 2 成",
    defensive: "0 - 3 成",
    neutral: "2 - 5 成",
    attack: "4 - 7 成"
  }[regime];
}
