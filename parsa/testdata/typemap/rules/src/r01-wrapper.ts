interface Box { v: number | string }
declare const box: Box | null;
const a = box as Box;
const b = <Box>box;
const c = { v: 1 } satisfies Box;
const d = box!;
export { a, b, c, d };
