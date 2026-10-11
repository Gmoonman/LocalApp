import { AccountStore, type AccountPersistence } from "./accounts.cjs";
import { ApiKeyStore } from "./api-keys.cjs";
import { GroupStore } from "./groups.cjs";
import { initializeAccountSchema } from "./account-schema.cjs";

export interface AccountServices {
  accounts: AccountStore;
  apiKeys: ApiKeyStore;
  groups: GroupStore;
  initialize(): void;
}

/** Account, session, key and group operations use the same database. */
export function createAccountServices(persistence: AccountPersistence): AccountServices {
  return {
    accounts: new AccountStore(persistence),
    apiKeys: new ApiKeyStore(persistence),
    groups: new GroupStore(persistence),
    initialize: () => initializeAccountSchema(persistence.database()),
  };
}
