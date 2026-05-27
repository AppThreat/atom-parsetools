import { defaultUser, type User } from "@models/models";
import settings from "@fixtures/settings.json" with { type: "json" };
import { flags } from "virtual:feature-flags";

const aliasUser: User<{ department: string }> = defaultUser;
const aliasDepartment = aliasUser.metadata.department;
const serviceName = settings.serviceName;
const retryLimit = settings.retryLimit;
const betaEnabled = flags.beta;
const parsedFromString = parseFixture("request-1");
const parsedFromUrl = parseFixture(new URL("https://example.com/request-2"));

async function loadServices() {
  const services = await import("./services");
  return services.UserRepository;
}

const repositoryCtorPromise = loadServices();

void [
  aliasDepartment,
  serviceName,
  retryLimit,
  betaEnabled,
  parsedFromString,
  parsedFromUrl,
  repositoryCtorPromise
];
