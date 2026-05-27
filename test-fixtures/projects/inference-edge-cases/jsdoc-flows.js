/**
 * @typedef {{ id: number, name: string, tags?: string[] }} UserRecord
 */

/** @type {UserRecord} */
const primaryUser = { id: 1, name: "Ada", tags: ["admin", "research"] };

const userName = primaryUser.name;
const firstTag = primaryUser.tags?.[0] ?? "none";
const userEntries = Object.entries(primaryUser);
const userIdSet = new Set([primaryUser.id]);

/**
 * @param {UserRecord[]} users
 * @param {(user: UserRecord) => boolean} predicate
 * @returns {UserRecord | undefined}
 */
function findUser(users, predicate) {
  return users.find(predicate);
}

const selectedUser = findUser([primaryUser], user => user.id === 1);
const selectedName = selectedUser?.name ?? "missing";

/**
 * @template T
 * @param {T[]} values
 * @param {(value: T, index: number) => string} getKey
 * @returns {Map<string, T>}
 */
function indexBy(values, getKey) {
  return new Map(values.map((value, index) => [getKey(value, index), value]));
}

const userIndex = indexBy([primaryUser], user => user.name);
const indexedUser = userIndex.get("Ada");

const helpers = {
  /** @param {UserRecord} user */
  label(user) {
    return `${user.id}:${user.name}`;
  },
  /** @param {UserRecord[]} users */
  names(users) {
    return users.map(user => user.name);
  }
};

const helperLabel = helpers.label(primaryUser);
const helperNames = helpers.names([primaryUser]);

/** @returns {Generator<number, string, boolean>} */
function* controlledCounter() {
  const shouldContinue = yield 1;
  if (shouldContinue) {
    yield 2;
  }
  return "done";
}

const counterIterator = controlledCounter();
const firstCounterResult = counterIterator.next();

/** @returns {Promise<UserRecord>} */
async function loadUser() {
  return primaryUser;
}

const loadedUserPromise = loadUser();
const loadedUserNamePromise = loadUser().then(user => user.name);

void [
  userName,
  firstTag,
  userEntries,
  userIdSet,
  selectedName,
  indexedUser,
  helperLabel,
  helperNames,
  firstCounterResult,
  loadedUserPromise,
  loadedUserNamePromise
];
