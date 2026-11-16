import { readFileSync } from 'node:fs';

// The default mount; AGENTAGE_STORE_URL_FILE overrides it.
export const STORE_URL_FILE = '/run/secrets/store-url';

export interface Connection {
  url: string;
  username: string;
  password: string;
  database: string;
}

const FORM = 'store-url is not http://user:password@host:port/database';

// The estate's clickhouse form, http://logs:{pw}@logs_store:8123/logs; an error never quotes it.
export const parseStoreUrl = (text: string): Connection => {
  const url = URL.parse(text.trim());
  if (!url || !/^https?:$/.test(url.protocol) || !url.username) throw new Error(FORM);
  return {
    url: url.origin,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || 'default',
  };
};

const readText = (file: string) => readFileSync(file, 'utf8');

// A missing or empty file names the file, never a value.
export const readConnection = (read = readText, env = process.env): Connection => {
  const file = env.AGENTAGE_STORE_URL_FILE || STORE_URL_FILE;
  let text = '';
  try {
    text = read(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!text.trim()) throw new Error(`${file} has no value: the store is not mounted`);
  return parseStoreUrl(text);
};
