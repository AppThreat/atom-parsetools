type User = {
  id: number;
  name: string;
};

export const typedUser: User = { id: 1, name: "Ada" };
export const readonlyIds = [1, 2, 3] as const;
export const firstReadonlyId = readonlyIds[0];

export function pickName(user: User) {
  return user.name;
}

export const pickedName = pickName(typedUser);
