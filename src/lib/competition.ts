export type Scorecard = { judgeId: string; scores: Record<string, number> };

export function musicalityTotal(cards: Scorecard[], expectedJudgeIds: string[]) {
  const submitted = new Set(cards.map((card) => card.judgeId));
  const complete = expectedJudgeIds.every((id) => submitted.has(id));
  return { complete, total: complete ? cards.reduce((sum, card) => sum + Object.values(card.scores).reduce((a, b) => a + b, 0), 0) : null };
}

export function flagResult(votes: Array<"blue" | "green">, required = 3) {
  if (votes.length < required) return { complete: false as const, winner: null, score: null };
  const blue = votes.filter((vote) => vote === "blue").length;
  const green = votes.length - blue;
  return { complete: true as const, winner: blue > green ? "blue" as const : "green" as const, score: `${Math.max(blue, green)} a ${Math.min(blue, green)}` };
}

export function shouldHideRanking(totalParticipants: number, remaining: number, mysteryMode = true) {
  return mysteryMode && (totalParticipants <= 3 || remaining <= 3);
}
