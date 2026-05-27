declare namespace FixtureRuntime {
  interface Context {
    requestId: string;
    startedAt: Date;
  }
}

declare module "virtual:feature-flags" {
  export interface FeatureFlags {
    readonly beta: boolean;
    readonly rollout: number;
  }

  export const flags: FeatureFlags;
}

// noinspection JSUnusedGlobalSymbols
declare function parseFixture(input: string): FixtureRuntime.Context;
// noinspection JSUnusedGlobalSymbols
declare function parseFixture(input: URL): FixtureRuntime.Context;
