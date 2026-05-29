interface Row {
  id: string;
  score: number;
  tags: Array<string>;
}

export function summarizeRows(rows: Array<Row>) {
  const scores = rows.map((row) => row.score);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const ids = new Set(rows.map((row) => row.id));
  return {
    total,
    average: rows.length ? total / rows.length : 0,
    ids
  };
}
