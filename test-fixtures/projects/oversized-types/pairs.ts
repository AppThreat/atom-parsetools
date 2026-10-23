declare function pair<T>(value: T): { left: T; right: T };

const level0 = "leaf";
const level1 = pair(level0);
const level2 = pair(level1);
const level3 = pair(level2);
const level4 = pair(level3);
const level5 = pair(level4);
const level6 = pair(level5);
const level7 = pair(level6);
const level8 = pair(level7);
const level9 = pair(level8);
const level10 = pair(level9);
const level11 = pair(level10);
const level12 = pair(level11);

export type Deep = { inner: typeof level12 };
export declare const deep: Deep;
export const shallow = level1;
