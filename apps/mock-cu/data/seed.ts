/**
 * Seed data for the mock credit union. All data is conspicuously fake
 * (surnames like "Testmember") so that even a redaction bug elsewhere in
 * the system could never leak anything real.
 */

export interface Account {
  /** Share suffix, the legacy-core convention: S00 = base savings, S01 = checking, ... */
  suffix: string;
  type: 'REGULAR SAVINGS' | 'CHECKING' | 'MONEY MARKET' | 'HOLIDAY CLUB';
  nickname: string;
  balanceCents: number;
  openedOn: string;
}

export interface Member {
  id: string;
  name: string;
  dob: string;
  address: string;
  phone: string;
  standing: 'GOOD' | 'REVIEW';
  accounts: Account[];
}

function seedMembers(): Member[] {
  return [
    {
      id: '12345',
      name: 'Alexis Testmember',
      dob: '1987-03-14',
      address: '482 Sample Ave, Demoville, CA 90000',
      phone: '(555) 010-4821',
      standing: 'GOOD',
      accounts: [
        { suffix: 'S00', type: 'REGULAR SAVINGS', nickname: 'Primary Savings', balanceCents: 482197, openedOn: '2011-06-02' },
        { suffix: 'S01', type: 'CHECKING', nickname: 'Everyday Checking', balanceCents: 31240, openedOn: '2012-01-19' },
      ],
    },
    {
      id: '10001',
      name: 'Jordan Samplesworth',
      dob: '1975-11-02',
      address: '17 Placeholder Rd, Demoville, CA 90000',
      phone: '(555) 010-1700',
      standing: 'GOOD',
      accounts: [
        { suffix: 'S00', type: 'REGULAR SAVINGS', nickname: 'Primary Savings', balanceCents: 1250050, openedOn: '2003-09-30' },
      ],
    },
    {
      id: '10002',
      name: 'Riley Mockford',
      dob: '1992-07-23',
      address: '901 Fixture Blvd, Demoville, CA 90000',
      phone: '(555) 010-9010',
      standing: 'REVIEW',
      accounts: [
        { suffix: 'S00', type: 'REGULAR SAVINGS', nickname: 'Primary Savings', balanceCents: 5000, openedOn: '2021-02-11' },
        { suffix: 'S01', type: 'CHECKING', nickname: 'Everyday Checking', balanceCents: 184409, openedOn: '2021-02-11' },
        { suffix: 'S02', type: 'HOLIDAY CLUB', nickname: 'Holiday Club', balanceCents: 62500, openedOn: '2023-10-01' },
      ],
    },
    {
      id: '10003',
      name: 'Casey Testmember',
      dob: '1969-01-08',
      address: '3 Example Court, Demoville, CA 90000',
      phone: '(555) 010-0300',
      standing: 'GOOD',
      accounts: [
        { suffix: 'S00', type: 'REGULAR SAVINGS', nickname: 'Primary Savings', balanceCents: 90211, openedOn: '1998-04-17' },
        { suffix: 'S01', type: 'MONEY MARKET', nickname: 'Money Market', balanceCents: 4500000, openedOn: '2015-08-25' },
      ],
    },
  ];
}

let members: Member[] = seedMembers();
let confirmationCounter = 340;

export function resetData(): void {
  members = seedMembers();
  confirmationCounter = 340;
}

export function findMemberById(id: string): Member | undefined {
  return members.find((m) => m.id === id);
}

/** Legacy-core search semantics: exact member number, or case-insensitive substring of name. */
export function searchMembers(query: string): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return members.filter((m) => m.id === q || m.name.toLowerCase().includes(q));
}

export interface NewSubAccountRequest {
  memberId: string;
  type: Account['type'];
  nickname: string;
  initialDepositCents: number;
}

export function createSubAccount(req: NewSubAccountRequest): { account: Account; confirmationNo: string } {
  const member = findMemberById(req.memberId);
  if (!member) throw new Error(`no such member: ${req.memberId}`);
  const nextSuffixNum = Math.max(...member.accounts.map((a) => Number(a.suffix.slice(1)))) + 1;
  const account: Account = {
    suffix: `S${String(nextSuffixNum).padStart(2, '0')}`,
    type: req.type,
    nickname: req.nickname,
    balanceCents: req.initialDepositCents,
    openedOn: new Date().toISOString().slice(0, 10),
  };
  member.accounts.push(account);
  confirmationCounter += 1;
  return { account, confirmationNo: `CNF-${String(confirmationCounter).padStart(6, '0')}` };
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const ACCOUNT_TYPES: Account['type'][] = ['REGULAR SAVINGS', 'CHECKING', 'MONEY MARKET', 'HOLIDAY CLUB'];
