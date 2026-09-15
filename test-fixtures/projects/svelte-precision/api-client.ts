import type { Profile, Row } from "./types.ts";

/** Typed async helper imported by async-await.svelte. */
export async function fetchProfile(userId: string): Promise<Profile> {
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}`);
  if (!response.ok) {
    throw new Error(`profile request failed: ${response.status}`);
  }
  return (await response.json()) as Profile;
}

/** Synchronous typed helper used as a `use:` action elsewhere. */
export const tooltip = (node: HTMLElement, options: { text: string }) => {
  node.title = options.text;
  return {
    destroy(): void {
      node.title = "";
    }
  };
};

/** Generic helper so inferred function types are exercised. */
export function pickBest<T extends { score: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (best, row) => (best === undefined || row.score > best.score ? row : best),
    undefined
  );
}

export function formatRows(rows: Row[]): string {
  return rows.map((row) => `${row.name}=${row.score}`).join(", ");
}
