import { User, UserRole } from "./models";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      article: { [key: string]: unknown };
      h2: { [key: string]: unknown };
      span: { [key: string]: unknown };
    }
  }
}

type __IntrinsicFixtureUse = JSX.IntrinsicElements;
const __jsxFixtureUse: keyof __IntrinsicFixtureUse | undefined = undefined;

type UserCardProps<TMeta extends Record<string, unknown>> = {
  user: User<TMeta>;
  onSelect?: (user: User<TMeta>) => void;
};

export function UserCard<TMeta extends Record<string, unknown>>({ user, onSelect }: UserCardProps<TMeta>) {
  const roleLabel: `${UserRole}` = user.role;
  return (
    <article data-role={roleLabel} onClick={() => onSelect?.(user)}>
      <h2>{user.name}</h2>
      <span>{String(user.metadata.department ?? "unknown")}</span>
    </article>
  );
}

export const userCardFactory = <TMeta extends Record<string, unknown>>(user: User<TMeta>) => (
  <UserCard user={user} />
);

void [UserCard, userCardFactory, __jsxFixtureUse];
