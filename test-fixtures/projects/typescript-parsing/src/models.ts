export enum UserRole {
  Admin = "admin",
  Reader = "reader"
}

export type EntityId = string & { readonly brand: unique symbol };

export interface AuditFields {
  createdAt: Date;
  updatedAt?: Date;
}

export interface User<TMeta extends Record<string, unknown> = Record<string, never>> extends AuditFields {
  id: EntityId;
  name: string;
  role: UserRole;
  metadata: TMeta;
}

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type UserSummary = Pick<User<{ department: string }>, "id" | "name" | "metadata">;

export const defaultRole = UserRole.Reader;

export const defaultUser = {
  id: "user-1" as EntityId,
  name: "Ada",
  role: UserRole.Admin,
  metadata: { department: "research" },
  createdAt: new Date()
} satisfies User<{ department: string }>;

const __modelFixtureUse: ApiResponse<UserSummary> | undefined = undefined;
void [defaultRole, defaultUser, __modelFixtureUse];
