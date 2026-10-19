// Del-Discord v1 — personal source modules.

// Browsers clamp overflowing timer delays to a few milliseconds. Split long
// server cooldowns so an unusually large Retry-After never becomes an early retry.
export const sleep = ms => {
  const chunk = Math.min(ms, 2147483647);
  return new Promise(resolve => setTimeout(resolve, chunk)).then(() => ms > chunk ? sleep(ms - chunk) : undefined);
};

export const rand = (a, b) => {
  const range = b - a + 1;
  if (globalThis.crypto?.getRandomValues && Number.isSafeInteger(range) && range > 0 && range <= 0x100000000) {
    const values = new Uint32Array(1);
    const ceiling = Math.floor(0x100000000 / range) * range;
    do { crypto.getRandomValues(values); } while (values[0] >= ceiling);
    return a + values[0] % range;
  }
  return Math.floor(Math.random() * range) + a;
};

// Discord retry_after is seconds, including fractional seconds.
export const retryMs = value => {
  const seconds = Number(value);
  return value !== null && value !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1500;
};
