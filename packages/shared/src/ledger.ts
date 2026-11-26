import type { AccountSubtype, AccountType } from './accounts';
import type { LocalizedName } from './localized';
import type { Period } from './periods';

export interface LedgerCompany {
  id: string;
  name: LocalizedName;
  currency: string;
}

export interface LedgerAccount {
  id: string;
  code: string;
  name: LocalizedName;
  type: AccountType;
  subtype: AccountSubtype;
  isPostable: boolean;
  isActive: boolean;
}

export interface LedgerSetup {
  accounts: LedgerAccount[];
  periods: Period[];
}
