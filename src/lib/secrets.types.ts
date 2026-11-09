// The store's connection, http://user:password@host:8123, mounted as the secret store-url.
declare module '@agentage/extension' {
  interface Secrets {
    storeUrl: string;
  }
}

export {};
