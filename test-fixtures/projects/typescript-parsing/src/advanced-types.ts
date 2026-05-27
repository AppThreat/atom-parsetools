export namespace RuntimeShapes {
  export interface Coordinates {
    x: number;
    y: number;
    label?: string;
  }
}

export const enum StatusCode {
  Ok = 200,
  NotFound = 404
}

export type PointTuple = readonly [number, number];

// noinspection JSUnusedGlobalSymbols
export function formatInput(input: string): string;
// noinspection JSUnusedGlobalSymbols
export function formatInput(input: RuntimeShapes.Coordinates): string;
export function formatInput(input: string | RuntimeShapes.Coordinates) {
  return typeof input === "string" ? input.toUpperCase() : `${input.x},${input.y}`;
}

export function projectPoint({ x, y, label = "origin" }: RuntimeShapes.Coordinates) {
  return { x, y, label };
}

const tuple: PointTuple = [1, 2];
const [pointX, pointY] = tuple;
const formattedFromCoords = formatInput({ x: pointX, y: pointY });
const projected = projectPoint({ x: pointX, y: pointY });
const status = StatusCode.Ok;
const fallbackStatus = StatusCode.NotFound;

void [formattedFromCoords, projected, status, fallbackStatus];
