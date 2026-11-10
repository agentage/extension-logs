import { describe, expect, it } from 'vitest';
import { parseStoreUrl, readConnection, STORE_URL_FILE } from './connection.js';

const missing = () => {
  throw Object.assign(new Error('no file'), { code: 'ENOENT' });
};

describe('the store connection', () => {
  it("parses the estate's form: user, password, database", () => {
    expect(parseStoreUrl('http://logs:p%40ss@logs_store:8123/logs\n')).toEqual({
      url: 'http://logs_store:8123',
      username: 'logs',
      password: 'p@ss',
      database: 'logs',
    });
  });

  it('defaults the database when the URL has no path', () => {
    expect(parseStoreUrl('http://default:ci@localhost:8123').database).toBe('default');
  });

  it.each(['not a url', 'postgres://u:p@h:5432/d', 'http://h:8123/logs'])(
    'refuses %s without quoting it',
    (text) => expect(() => parseStoreUrl(text)).toThrow(/^store-url is not http:/)
  );

  it('reads the file the estate mounts', () => {
    const read = (file: string) => (file === STORE_URL_FILE ? 'http://a:b@c:8123/d' : '');
    expect(readConnection(read)).toMatchObject({ username: 'a', database: 'd' });
  });

  it('names the file when it is missing or empty', () => {
    const why = `${STORE_URL_FILE} has no value: the store is not mounted`;
    expect(() => readConnection(missing)).toThrow(why);
    expect(() => readConnection(() => ' \n')).toThrow(why);
  });

  it('passes any other read error through', () => {
    const denied = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(() => readConnection(denied)).toThrow('EACCES');
  });
});
