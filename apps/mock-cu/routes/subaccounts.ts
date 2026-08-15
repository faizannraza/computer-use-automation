/**
 * Open-a-sub-account flow: form → review → confirm → confirmation screen.
 * This is the "risky/irreversible" flow the automation system treats
 * conservatively. The permission_denied fault turns the confirm step into a
 * supervisor-authorization screen — resolvable only by a human who knows the
 * supervisor PIN, which is exactly the shape of intervention the
 * human-in-the-loop handoff demo needs.
 */
import { Router } from 'express';
import type { Response } from 'express';
import { ACCOUNT_TYPES, createSubAccount, findMemberById, formatMoney } from '../data/seed.js';
import type { Account, Member } from '../data/seed.js';
import { consumeNativeDialog, peekFault, triggerFault } from '../faults.js';
import { currentUser } from '../session.js';

const SUPERVISOR_PIN = process.env.MOCK_CU_SUPERVISOR_PIN ?? '7391';
const MIN_DEPOSIT_CENTS = 2500;

export const subaccountsRouter = Router();

interface FormValues {
  cmbType: string;
  txtNickname: string;
  txtDeposit: string;
}

function readForm(body: unknown): FormValues {
  const b = body as Partial<FormValues>;
  return {
    cmbType: String(b.cmbType ?? ''),
    txtNickname: String(b.txtNickname ?? '').trim(),
    txtDeposit: String(b.txtDeposit ?? '').trim(),
  };
}

function validate(values: FormValues): string[] {
  const errors: string[] = [];
  if (!(ACCOUNT_TYPES as string[]).includes(values.cmbType)) {
    errors.push('Select a valid account type.');
  }
  if (values.txtNickname.length < 1 || values.txtNickname.length > 20) {
    errors.push('Nickname is required (1–20 characters).');
  }
  const deposit = Number(values.txtDeposit.replace(/[$,]/g, ''));
  if (!Number.isFinite(deposit) || deposit * 100 < MIN_DEPOSIT_CENTS) {
    errors.push('Initial deposit must be at least $25.00.');
  }
  return errors;
}

function depositCents(values: FormValues): number {
  return Math.round(Number(values.txtDeposit.replace(/[$,]/g, '')) * 100);
}

function withMember(id: string, res: Response, fn: (m: Member) => void): void {
  const member = findMemberById(id);
  if (!member) {
    res.status(404).render('error', {
      title: 'MockCore Teller — Member Not Found',
      code: 'MBR-4041',
      message: `Member number ${id} was not found on this system.`,
      user: undefined,
    });
    return;
  }
  fn(member);
}

subaccountsRouter.get('/:id/subaccounts/new', (req, res) => {
  withMember(req.params.id!, res, (member) => {
    res.render('subacct_form', {
      title: 'MockCore Teller — Open Sub-Account',
      user: currentUser(req),
      member,
      accountTypes: ACCOUNT_TYPES,
      values: { cmbType: '', txtNickname: '', txtDeposit: '' },
      errors: [],
      nativeDialogText: consumeNativeDialog(),
    });
  });
});

subaccountsRouter.post('/:id/subaccounts/review', (req, res) => {
  withMember(req.params.id!, res, (member) => {
    const values = readForm(req.body);
    const errors = validate(values);
    if (errors.length > 0) {
      res.status(422).render('subacct_form', {
        title: 'MockCore Teller — Open Sub-Account',
        user: currentUser(req),
        member,
        accountTypes: ACCOUNT_TYPES,
        values,
        errors,
        nativeDialogText: null,
      });
      return;
    }
    res.render('subacct_review', {
      title: 'MockCore Teller — Review Sub-Account',
      user: currentUser(req),
      member,
      values,
      depositDisplay: formatMoney(depositCents(values)),
      nativeDialogText: consumeNativeDialog(),
    });
  });
});

subaccountsRouter.post('/:id/subaccounts/confirm', (req, res) => {
  withMember(req.params.id!, res, (member) => {
    const values = readForm(req.body);
    const errors = validate(values);
    if (errors.length > 0) {
      res.status(422).render('subacct_form', {
        title: 'MockCore Teller — Open Sub-Account',
        user: currentUser(req),
        member,
        accountTypes: ACCOUNT_TYPES,
        values,
        errors,
        nativeDialogText: null,
      });
      return;
    }
    // Permission fault: peek (don't consume) so the denial persists until a
    // supervisor actually authorizes — retrying the confirm won't slip past.
    if (peekFault('permission_denied')) {
      res.status(403).render('override', {
        title: 'MockCore Teller — Supervisor Authorization Required',
        user: currentUser(req),
        member,
        values,
        depositDisplay: formatMoney(depositCents(values)),
        error: null,
      });
      return;
    }
    finalizeOpen(res, member, values);
  });
});

subaccountsRouter.post('/:id/subaccounts/override', (req, res) => {
  withMember(req.params.id!, res, (member) => {
    const values = readForm(req.body);
    const pin = String((req.body as { txtPin?: string }).txtPin ?? '');
    if (pin !== SUPERVISOR_PIN) {
      res.status(403).render('override', {
        title: 'MockCore Teller — Supervisor Authorization Required',
        user: currentUser(req),
        member,
        values,
        depositDisplay: formatMoney(depositCents(values)),
        error: 'Invalid supervisor PIN.',
      });
      return;
    }
    triggerFault('permission_denied'); // authorization granted: consume the fault
    finalizeOpen(res, member, values);
  });
});

function finalizeOpen(res: Response, member: Member, values: FormValues): void {
  const { account, confirmationNo } = createSubAccount({
    memberId: member.id,
    type: values.cmbType as Account['type'],
    nickname: values.txtNickname,
    initialDepositCents: depositCents(values),
  });
  res.redirect(`/members/${member.id}/subaccounts/confirmation?sfx=${account.suffix}&cnf=${confirmationNo}`);
}

subaccountsRouter.get('/:id/subaccounts/confirmation', (req, res) => {
  withMember(req.params.id!, res, (member) => {
    const suffix = String(req.query.sfx ?? '');
    const account = member.accounts.find((a) => a.suffix === suffix);
    if (!account) {
      res.status(404).render('error', {
        title: 'MockCore Teller — Not Found',
        code: 'ACC-4042',
        message: `No account with suffix ${suffix} for member ${member.id}.`,
        user: currentUser(req),
      });
      return;
    }
    res.render('subacct_confirm', {
      title: 'MockCore Teller — Confirmation',
      user: currentUser(req),
      member,
      account,
      confirmationNo: String(req.query.cnf ?? ''),
      formatMoney,
      nativeDialogText: consumeNativeDialog(),
    });
  });
});
