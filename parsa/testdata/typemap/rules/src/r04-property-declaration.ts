export class Props {
  typed: Map<string, number[]> = new Map();
  inferred = [1, 2, 3];
  untyped;
  static count = 0;
  readonly tag = "fixed";
}
