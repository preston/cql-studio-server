// Author: Preston Lee

/**
 * Rate limiter service for controlling request rates
 * Implements token bucket algorithm for rate limiting
 */
export class RateLimiter {
  private tokens: Map<string, number>;
  private maxTokens: Map<string, number>;
  private lastRefill: Map<string, number>;
  private refillRate: Map<string, number>;

  constructor() {
    this.tokens = new Map();
    this.maxTokens = new Map();
    this.lastRefill = new Map();
    this.refillRate = new Map();
  }

  /**
   * Configure rate limiter for a specific operation
   */
  configure(operation: string, maxRequests: number, windowMs: number): void {
    this.maxTokens.set(operation, maxRequests);
    this.tokens.set(operation, maxRequests);
    this.refillRate.set(operation, maxRequests / (windowMs / 1000)); // tokens per second
    this.lastRefill.set(operation, Date.now());
  }

  /**
   * Check if a request is allowed and consume a token if available
   */
  async acquire(operation: string): Promise<void> {
    const maxTokens = this.maxTokens.get(operation);
    const refillRate = this.refillRate.get(operation);

    if (!maxTokens || !refillRate) {
      throw new Error(`Rate limiter not configured for operation: ${operation}`);
    }

    // Refill tokens based on time elapsed
    const now = Date.now();
    const lastRefill = this.lastRefill.get(operation) || now;
    const elapsed = now - lastRefill;
    
    if (elapsed > 0) {
      const currentTokens = this.tokens.get(operation) || 0;
      const tokensToAdd = (elapsed / 1000) * refillRate;
      const newTokens = Math.min(maxTokens, currentTokens + tokensToAdd);
      this.tokens.set(operation, newTokens);
      this.lastRefill.set(operation, now);
    }

    // Check if we have tokens available
    const currentTokens = this.tokens.get(operation) || 0;
    
    if (currentTokens < 1) {
      // Calculate wait time needed
      const waitTime = Math.ceil((1 - currentTokens) / refillRate * 1000);
      await this.wait(waitTime);
      
      // Refill and try again
      const newTokens = Math.min(maxTokens, refillRate);
      this.tokens.set(operation, newTokens - 1);
      this.lastRefill.set(operation, Date.now());
    } else {
      // Consume a token
      this.tokens.set(operation, currentTokens - 1);
    }
  }

  /**
   * Wait for a specified number of milliseconds
   */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get remaining tokens for an operation
   */
  getRemainingTokens(operation: string): number {
    const tokens = this.tokens.get(operation) || 0;
    return Math.max(0, Math.floor(tokens));
  }
}

