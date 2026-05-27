import { ApiResponse, EntityId, User, UserRole, defaultUser } from "./models";

function sealed(value: Function) {
  Object.seal(value);
  Object.seal(value.prototype);
}

export abstract class Repository<T extends { id: EntityId }> {
  protected readonly items = new Map<EntityId, T>();

  add(item: T): this {
    this.items.set(item.id, item);
    return this;
  }

  get(id: EntityId): T | undefined {
    return this.items.get(id);
  }

  abstract list(): readonly T[];
}

@sealed
export class UserRepository extends Repository<User<{ department: string }>> {
  #lastRole: UserRole = UserRole.Reader;

  override add(user: User<{ department: string }>): this {
    this.#lastRole = user.role;
    return super.add(user);
  }

  override list(): readonly User<{ department: string }>[] {
    return [...this.items.values()];
  }

  get lastRole(): UserRole {
    return this.#lastRole;
  }
}

export async function loadUser(id: EntityId): Promise<ApiResponse<User<{ department: string }>>> {
  const repository = new UserRepository().add(defaultUser);
  const user = repository.get(id);
  return user ? { ok: true, data: user } : { ok: false, error: { code: "404", message: "missing" } };
}

export function mapResponse<T, U>(response: ApiResponse<T>, mapper: (value: T) => U): ApiResponse<U> {
  return response.ok ? { ok: true, data: mapper(response.data) } : response;
}

const __serviceFixtureUse = new UserRepository().lastRole;
void [__serviceFixtureUse, loadUser, mapResponse];
