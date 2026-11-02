declare const mystery: any;
declare function unknownish(): unknown;
export const fromAny = mystery.value;
export const fromUnknown = unknownish();
export const arrAny = [mystery];
export const missing = (undefined as any as Promise<any>);
export const okay = [1].map((n) => n * 2);
