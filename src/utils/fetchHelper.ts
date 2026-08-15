export const nativeFetch: typeof fetch = (...args) => window.fetch(...args);
