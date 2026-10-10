declare module 'playwright-core-atom' {
  import type { Browser } from 'playwright'
  const playwright: { chromium: { connectOverCDP(options: { endpointURL: string; timeout: number }): Promise<Browser> } }
  export default playwright
}
