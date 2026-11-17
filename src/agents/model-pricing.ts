export type TokenPrices = {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
};
// Standard USD prices per million tokens: https://developers.openai.com/api/docs/pricing
export const openaiPrices: Record<
  string,
  { short: TokenPrices; long: TokenPrices }
> = {
  "gpt-6.1-sol": {
    short: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
    long: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
  },
  "gpt-6.1-terra": {
    short: { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
    long: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 7.5 },
  },
  "gpt-6-sol": {
    short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 },
  },
  "gpt-6-luna": {
    short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
    long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  "gpt-5.6-luna": {
    short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  "gpt-5.6-terra": {
    short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
  },
};

// Standard USD prices per million tokens: https://platform.claude.com/docs/en/about-claude/pricing
export const anthropicPrices: Record<string, TokenPrices> = {
  "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  "claude-sonnet-5-5": {
    input: 2,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 10,
  },
};
