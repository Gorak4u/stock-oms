import { createHash as nodeCreateHash } from 'node:crypto';
import { createHash as shimCreateHash } from '../src/shims/nodeCrypto.browser';

/**
 * The browser demo swaps `node:crypto` for a hand-written SHA-256. If the two
 * ever disagree, the audit chain shown in the browser would be a different
 * function from the one production verifies — so equivalence is asserted, not
 * assumed.
 */
describe('browser crypto shim', () => {
  const cases = [
    '',
    'a',
    'abc',
    'hello world',
    // 55, 56 and 64 bytes bracket the SHA-256 padding boundary, where a
    // length-encoding mistake shows up and nowhere else.
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(57),
    'x'.repeat(63),
    'x'.repeat(64),
    'x'.repeat(65),
    'x'.repeat(1000),
    '{"symbol":"NSE:RELIANCE","quantity":100,"side":"BUY"}',
    'नमस्ते ₹1,23,456.78', // multi-byte UTF-8
    '🚀📈',
  ];

  it.each(cases.map((value, i) => [i, value] as const))(
    'matches node:crypto for case %i',
    (_index, value) => {
      const expected = nodeCreateHash('sha256').update(value).digest('hex');
      expect(shimCreateHash('sha256').update(value).digest('hex')).toBe(expected);
    },
  );

  it('matches the published SHA-256 test vector for "abc"', () => {
    expect(shimCreateHash('sha256').update('abc').digest('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the published vector for the empty string', () => {
    expect(shimCreateHash('sha256').update('').digest('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('handles chained updates the same way node does', () => {
    const expected = nodeCreateHash('sha256').update('foo').update('bar').digest('hex');
    expect(shimCreateHash('sha256').update('foo').update('bar').digest('hex')).toBe(expected);
  });

  it('rejects algorithms and encodings it does not implement', () => {
    expect(() => shimCreateHash('md5')).toThrow(/sha256 only/);
    expect(() => shimCreateHash('sha256').update('x').digest('base64' as 'hex')).toThrow(
      /hex only/,
    );
  });
});
