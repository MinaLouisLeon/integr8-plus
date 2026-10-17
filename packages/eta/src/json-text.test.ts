import { describe, expect, it } from 'vitest';
import {
  arr,
  JsonTextError,
  num,
  obj,
  parseJsonText,
  property,
  str,
  stringValue,
  withoutProperty,
  withProperty,
  writeJsonText,
} from './json-text.js';

describe('JSON that keeps its text', () => {
  it('keeps every number lexeme and property order through a round trip', () => {
    const text = '{"b":1.10,"a":100.00000,"c":-0.5,"d":1e2,"e":[0,2.50],"f":{"z":true,"y":null}}';
    expect(writeJsonText(parseJsonText(text))).toBe(text);
  });

  it('keeps string escapes exactly as written', () => {
    const text = '{"s":"a\\"b\\\\c\\u0041\\/","t":"عربي"}';
    const value = parseJsonText(text);
    expect(writeJsonText(value)).toBe(text);
    expect(stringValue(property(value, 's'))).toBe('a"b\\cA/');
  });

  it('ignores whitespace and a leading BOM, and writes compactly', () => {
    expect(writeJsonText(parseJsonText('\uFEFF { "a" : [ 1 , 2 ] }\n'))).toBe('{"a":[1,2]}');
  });

  it('refuses what is not strict JSON', () => {
    for (const bad of [
      '{"a":1,"a":2}',
      '{"a":01}',
      '{"a":.5}',
      '[1,]',
      '{"a":"\\x"}',
      '"a\nb"',
      '{"a":1} x',
      "{'a':1}",
    ]) {
      expect(() => parseJsonText(bad), bad).toThrow(JsonTextError);
    }
  });

  it('builds documents and refuses a number that is not a JSON number', () => {
    const value = obj([
      ['n', num('12.50')],
      ['s', str('say "hi"')],
      ['skip', undefined],
      ['l', arr([num('1')])],
    ]);
    expect(writeJsonText(value)).toBe('{"n":12.50,"s":"say \\"hi\\"","l":[1]}');
    expect(() => num('1.')).toThrow(TypeError);
    expect(() => num('NaN')).toThrow(TypeError);
    expect(() =>
      obj([
        ['a', num('1')],
        ['a', num('2')],
      ]),
    ).toThrow(TypeError);
  });

  it('replaces and removes properties without disturbing the others', () => {
    const value = parseJsonText('{"a":1,"b":2,"c":3}');
    expect(writeJsonText(withProperty(value, 'b', num('2.0')))).toBe('{"a":1,"b":2.0,"c":3}');
    expect(writeJsonText(withProperty(value, 'd', num('4')))).toBe('{"a":1,"b":2,"c":3,"d":4}');
    expect(writeJsonText(withoutProperty(value, 'a'))).toBe('{"b":2,"c":3}');
  });
});
