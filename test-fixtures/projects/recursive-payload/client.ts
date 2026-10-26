// The shape of an ORM client's result types (Prisma 4): each model's payload
// lists its scalars, its relations and its embedded composites, generic over
// the client's extensions; relations point back at each other, and a query's
// result is a conditional mapped type over its arguments that recurses into
// every relation they select. Nothing here is Prisma's code, only its shape.
type Row = { [field in string]: unknown };

export type Payload = {
  scalars: Row;
  objects: Row;
  composites: Row;
};

export type Extensions = {
  result: { [model in string]: { [field in string]: unknown } };
};
export type NoExtensions = { result: {} & Record<string, {}> };

// A model's scalars with the fields an extension computes
type Computed<Base extends Record<any, any>, R, KR extends keyof R = string extends keyof R ? never : keyof R> = {
  [K in KR | keyof Base]: K extends KR
    ? R[K] extends () => { compute: (...args: any) => infer C }
      ? C
      : never
    : Base[K];
};

type Unwrap<P> = {
  [K in keyof P]: P[K] extends Payload[]
    ? Unwrap<P[K]>
    : P[K] extends Payload
      ? P[K]["scalars"] & Unwrap<P[K]["composites"]>
      : P[K] extends (infer O extends Payload) | null
        ? (O["scalars"] & Unwrap<O["composites"]>) | null
        : P[K];
} & unknown;

type Defaults<P> = P extends Payload ? P["scalars"] & Unwrap<P["composites"]> : P;

type Field<K extends PropertyKey, O> =
  | { objects: { [k in K]: O } }
  | { composites: { [k in K]: O } };

type Nullable<P extends Field<any, any>, K extends PropertyKey> = P extends {
  objects: Record<K, any>;
}
  ? P["objects"][K]
  : P extends { composites: Record<K, any> }
    ? P["composites"][K]
    : never;

type Count<O> = { [K in keyof O]: number } & {};

export type Found<P extends Payload, A> = {} extends A
  ? Defaults<P>
  : A extends
        | ({ select: infer S } & Record<string, unknown>)
        | ({ include: infer S } & Record<string, unknown>)
    ? S extends undefined
      ? Defaults<P>
      : {
          [K in keyof S as S[K] extends false | undefined | null ? never : K]: S[K] extends object
            ? P extends Field<K, (infer O)[]>
              ? O extends Payload
                ? Found<O, S[K]>[]
                : never
              : P extends Field<K, infer O | null>
                ? O extends Payload
                  ? Found<O, S[K]> | (Nullable<P, K> & null)
                  : never
                : K extends "_count"
                  ? Count<Found<P, S[K]>>
                  : never
            : P extends Field<K, (infer O)[]>
              ? O extends Payload
                ? Defaults<O>[]
                : never
              : P extends Field<K, infer O | null>
                ? O extends Payload
                  ? Defaults<O> | (Nullable<P, K> & null)
                  : never
                : P extends { scalars: { [k in K]: infer O } }
                  ? O
                  : K extends "_count"
                    ? Count<P["objects"]>
                    : never;
        } & (A extends { include: any } & Record<string, unknown> ? Defaults<P> : unknown)
    : Defaults<P>;

type Operation = "findUnique" | "findMany" | "create";

export type Result<P extends Payload, A, O extends Operation, Null = null> = {
  findUnique: Found<P, A> | Null;
  findMany: Found<P, A>[];
  create: Found<P, A>;
}[O];

type Subset<T, U> = { [key in keyof T]: key extends keyof U ? T[key] : never } & (T extends {
  select: any;
  include: any;
}
  ? "choose select or include"
  : {});

export type UserPayload<E extends Extensions = NoExtensions> = {
  objects: {
    articles: ArticlePayload<E>[];
    comments: CommentPayload<E>[];
    favorites: ArticlePayload<E>[];
    followers: UserPayload<E>[];
    following: UserPayload<E>[];
  };
  scalars: Computed<{ id: number; email: string; name: string }, E["result"]["user"]>;
  composites: {};
};

export type ArticlePayload<E extends Extensions = NoExtensions> = {
  objects: {
    tags: TagPayload<E>[];
    author: UserPayload<E>;
    favoritedBy: UserPayload<E>[];
    comments: CommentPayload<E>[];
  };
  scalars: Computed<
    { id: number; slug: string; title: string; body: string; authorId: number },
    E["result"]["article"]
  >;
  composites: {};
};

export type CommentPayload<E extends Extensions = NoExtensions> = {
  objects: { author: UserPayload<E>; article: ArticlePayload<E> };
  scalars: Computed<{ id: number; body: string }, E["result"]["comment"]>;
  composites: {};
};

export type TagPayload<E extends Extensions = NoExtensions> = {
  objects: { articles: ArticlePayload<E>[] };
  scalars: Computed<{ id: number; name: string }, E["result"]["tag"]>;
  composites: {};
};

type FindManyArgs = { where?: Row; select?: Row | null; include?: Row | null };

export declare class Client<E extends Extensions = NoExtensions> {
  article: {
    findMany<T extends FindManyArgs>(
      args?: Subset<T, FindManyArgs>
    ): Promise<Result<ArticlePayload<E>, T, "findMany">>;
  };
  user: {
    findUnique<T extends FindManyArgs>(
      args: Subset<T, FindManyArgs>
    ): Promise<Result<UserPayload<E>, T, "findUnique">>;
  };
}

export declare const db: Client;
