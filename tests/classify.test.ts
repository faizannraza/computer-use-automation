/**
 * Field classification as a CROSS-CHECK, not just a sweep.
 *
 * Two defects live here. A param's sensitivity is a hand-typed annotation that
 * nothing verifies, so an artifact can declare a member's e-mail `none` while
 * the same app profile calls the "E-mail:" field PII — and run_start writes
 * params before any observation exists, so the sweep cannot save it. And a
 * static label list cannot name a label that varies per record: a transfer
 * receipt labels each new balance with the share it belongs to.
 */
import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/core/types.js';
import { classifiedElementRefs, classifyObservation, effectiveParamSensitivity } from '../src/policy/classify.js';
import { Redactor } from '../src/policy/redact.js';
import { AppProfileSchema, loadProfile } from '../src/profile/appProfile.js';

const meridian = loadProfile('profiles/meridian-core.profile.json');
const classification = meridian.dataClassification;

describe('a profile raises a param whose name is a classified field', () => {
  it("raises the very params member.updateInfo ships as 'none'", () => {
    // The artifact's own `example` values are already masked ("***om"), which
    // is the compile-time proof that the profile knew these were PII while the
    // declaration said otherwise.
    expect(effectiveParamSensitivity('email', 'none', classification)).toBe('pii');
    expect(effectiveParamSensitivity('phone', 'none', classification)).toBe('pii');
    // "Mailing Address:" is addressed by its head noun, the way a param is named.
    expect(effectiveParamSensitivity('address', 'none', classification)).toBe('pii');
    // A classified COLUMN counts too — it is the same claim about the same data.
    expect(effectiveParamSensitivity('name', 'none', classification)).toBe('pii');
  });

  it('raises only — it can never talk a flow out of protecting something', () => {
    expect(effectiveParamSensitivity('email', 'secret', classification)).toBe('secret');
    expect(effectiveParamSensitivity('memberId', 'internal', classification)).toBe('internal');
    expect(effectiveParamSensitivity('amount', 'none', classification)).toBe('none');
    expect(effectiveParamSensitivity('email', 'none', undefined)).toBe('none');
  });
});

describe('per-record labels (labelPatterns)', () => {
  /** The MERIDIAN transfer receipt: each new balance is labelled by its share id. */
  const receipt = (): Observation => ({
    seq: 1,
    location: 'https://web-sample.interface-hiring.com/transfer/receipt',
    title: 'TRANSFER POSTED',
    elements: [
      {
        ref: 0,
        role: 'rowheader',
        name: '101555-S0001:',
        framePath: [],
        interactive: false,
        nearText: '101555-S0001: | $17,978.00 (new balance)',
      },
      {
        ref: 1,
        role: 'cell',
        name: '$17,978.00 (new balance)',
        framePath: [],
        interactive: false,
        label: '101555-S0001:',
        nearText: '101555-S0001: | $17,978.00 (new balance)',
      },
      // A shares LIST elsewhere in the app: the same share id without a colon,
      // sitting next to its account type. Nothing here is regulated by the
      // pattern, and an unanchored one would classify "Regular Shares".
      {
        ref: 2,
        role: 'cell',
        name: '101555-S0001',
        framePath: [],
        interactive: false,
        nearText: '101555-S0001 | Regular Shares | OPEN',
      },
      {
        ref: 3,
        role: 'cell',
        name: 'Regular Shares',
        framePath: [],
        interactive: false,
        nearText: '101555-S0001 | Regular Shares | OPEN',
      },
    ],
    visibleText: 'TRANSFER POSTED 101555-S0001: $17,978.00 (new balance) 101555-S0001 Regular Shares OPEN',
    at: new Date().toISOString(),
  });

  it('registers a balance whose label is a share id — no static list could name it', () => {
    const redactor = new Redactor();
    const obs = receipt();
    expect(classifyObservation(obs, classification, redactor)).toBeGreaterThan(0);
    const written = redactor.apply(JSON.stringify(obs));
    expect(written).not.toContain('$17,978.00');
    // Over-redaction is its own failure: the pattern is anchored and requires
    // the trailing colon, so the shares list is untouched.
    expect(written).toContain('Regular Shares');
    expect(written).toContain('TRANSFER POSTED');
    // …and it is the patterns doing the work: the column-only classification
    // this profile shipped with finds nothing at all on a receipt screen.
    expect(classifyObservation(receipt(), { financial: { columns: ['Balance'] } }, new Redactor())).toBe(0);
  });

  it('marks that balance for screenshot masking too', () => {
    const refs = classifiedElementRefs(receipt(), classification);
    expect(refs).toContain(1); // the balance, found via its per-record label
    expect(refs).not.toContain(3); // the account type in the shares list
  });

  it('pairs label to value by whole CELLS, so a pipe inside a value cannot shift them', () => {
    // Splitting the row's rendered text on '|' puts "Ada" and "Lovelace" in
    // different cells and shifts everything after them: the phone number would
    // be paired with the wrong label, and the name left in the clear.
    const redactor = new Redactor();
    const row = {
      ref: 0,
      role: 'cell' as const,
      name: 'Ada | Lovelace',
      framePath: [],
      interactive: false,
      rowId: 't0r1',
      cellTexts: ['Name:', 'Ada | Lovelace', 'Phone:', '(555) 010-0199'],
      nearText: 'Name: | Ada | Lovelace | Phone: | (555) 010-0199',
    };
    const obs: Observation = {
      seq: 1,
      location: 'https://web-sample.interface-hiring.com/members/101555',
      title: 'MEMBER RECORD',
      elements: [row],
      visibleText: 'Name: Ada | Lovelace Phone: (555) 010-0199',
      at: new Date().toISOString(),
    };
    expect(classifyObservation(obs, classification, redactor)).toBe(2);
    const written = redactor.apply(JSON.stringify(obs));
    expect(written).not.toContain('Lovelace');
    expect(written).not.toContain('010-0199');
  });

  it('reports a classified label with no value cell instead of skipping it silently', () => {
    // A truncated row, or a label that ends its row: there is nothing to
    // register, and an evidence stream that says nothing here is
    // indistinguishable from one where no regulated data was on screen.
    const gaps: { label: string; rowId?: string }[] = [];
    const obs: Observation = {
      seq: 1,
      location: 'https://web-sample.interface-hiring.com/members/101555',
      title: 'MEMBER RECORD',
      elements: [
        {
          ref: 0,
          role: 'cell',
          name: 'Address:',
          framePath: [],
          interactive: false,
          rowId: 't0r4',
          cellTexts: ['Address:'],
          nearText: 'Address:',
        },
      ],
      visibleText: 'Address:',
      at: new Date().toISOString(),
    };
    expect(classifyObservation(obs, classification, new Redactor(), (g) => gaps.push(g))).toBe(0);
    expect(gaps).toEqual([{ label: 'Address:', rowId: 't0r4' }]);
  });

  it('the MockCore profile classifies the balance its confirmation screen labels', () => {
    // Same shape, static label: the opening balance on that app's receipt is a
    // label:value pair, not a column, so a column-only classification missed it.
    const mockcore = loadProfile('profiles/mockcore-teller.profile.json');
    const redactor = new Redactor();
    const obs: Observation = {
      seq: 1,
      location: 'http://localhost:4173/members/12345/subaccounts/confirmation',
      title: 'Confirmation',
      elements: [
        {
          ref: 0,
          role: 'cell',
          name: '$50.00',
          framePath: [],
          interactive: false,
          rowId: 't0r5',
          cellTexts: ['Opening Balance', '$50.00'],
          nearText: 'Opening Balance | $50.00',
        },
      ],
      visibleText: 'Opening Balance $50.00',
      at: new Date().toISOString(),
    };
    expect(classifyObservation(obs, mockcore.dataClassification, redactor)).toBe(1);
    expect(redactor.apply('the drawer posted $50.00 today')).not.toContain('$50.00');
  });

  it('rejects a profile whose labelPattern is not a compilable regex', () => {
    // An uncompilable pattern must fail at load, where the message names the
    // profile, rather than throwing mid-run out of the classification sweep.
    const broken = structuredClone(meridian) as { dataClassification: { financial: { labelPatterns?: string[] } } };
    broken.dataClassification.financial.labelPatterns = ['^([0-9'];
    expect(() => AppProfileSchema.parse(broken)).toThrow(/regular expression/);
  });
});
