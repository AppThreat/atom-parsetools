// Legacy TypeScript decorators of the NestJS / TypeORM flavour: decorated
// properties, methods and constructor parameters, in a file the
// auto-accessor plugin must leave untouched.
import "reflect-metadata";

function Entity(target: any): any {
  return target;
}

function Column(target: any, key: string): any {
  return target[key];
}

@Entity
export class Cat {
  @Column name: string = "";
  @Column static table = "cats";

  @Column speak(word: string): string {
    return word;
  }
}
