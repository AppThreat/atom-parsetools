import { defaultUser, type UserSummary } from "./models";
import { UserRepository, loadUser, mapResponse } from "./services";
import { userCardFactory } from "./view";

const repository = new UserRepository().add(defaultUser);
const summaries: UserSummary[] = repository.list().map(({ id, name, metadata }) => ({ id, name, metadata }));
const firstSummary = summaries[0];
const rendered = userCardFactory(defaultUser);

const loaded = await loadUser(defaultUser.id);
const displayName = mapResponse(loaded, user => user.name.toUpperCase());

void [firstSummary, rendered, displayName];

export { displayName, firstSummary, rendered, repository };
