// A decorated auto-accessor in TypeScript: the annotation types the backed
// field and the initialiser reads an imported helper.
import { v4 as uuidv4 } from "uuid";

function logged(target: any, key: string): any {
  return target[key];
}

export class Session {
  @logged accessor id: string = uuidv4();
  @logged static accessor limit: number = Number.MAX_SAFE_INTEGER;
  accessor tags: string[] = [];
}
