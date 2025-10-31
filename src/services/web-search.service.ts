// Author: Preston Lee

import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { RateLimiter } from './rate-limiter.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchResult {
  url: string;
  title: string;
  content: string;
  textContent: string;
}

export class WebSearchService {
  private rateLimiter: RateLimiter;

  constructor(rateLimiter?: RateLimiter) {
    this.rateLimiter = rateLimiter || new RateLimiter();
    
    // Configure default rate limits (conservative defaults)
    // For search: Will be automatically updated from Brave API response headers (X-RateLimit-Limit)
    // The first API call will configure the actual rate limits based on your API plan
    this.rateLimiter.configure('search', 1, 1000); // Default: 1 req/second (safe default, will be updated)
    this.rateLimiter.configure('fetch', 20, 60000); // 20 req/min for URL fetching
  }


  /**
   * Clean and validate URLs (for fetchUrl method)
   */
  private cleanUrl(url: string): string {
    if (!url) return url;
    try {
      // Basic URL validation and cleaning
      const urlObj = new URL(url);
      return urlObj.href;
    } catch (error) {
      // If URL parsing fails, return original
      return url;
    }
  }

  /**
   * Format search results for LLM consumption
   */
  private formatSearchResultsForLLM(results: SearchResult[]): string {
    if (results.length === 0) {
      return 'No search results found.';
    }

    const formatted = results.map((result, index) => {
      return `[${index + 1}] ${result.title}
URL: ${result.url}
Description: ${result.snippet}`;
    }).join('\n\n');

    return formatted;
  }
  /**
   * Perform a web search using Brave Search API
   * @param query - The search query string
   * @param braveApiKey - The Brave Search API key (required, provided by MCP client)
   * @param maxResults - Maximum number of results to return (default: 10)
   */
  async searchWeb(query: string, braveApiKey: string, maxResults: number = 10): Promise<SearchResult[]> {
    // Validate that Brave API key is provided
    if (!braveApiKey || typeof braveApiKey !== 'string' || braveApiKey.trim().length === 0) {
      throw new Error(
        'Web search requires brave_api_key parameter to be provided. ' +
        'The API key must be included in the tool call parameters. ' +
        'Get your free API key at: https://brave.com/search/api'
      );
    }

    // Apply rate limiting
    await this.rateLimiter.acquire('search');

    const max = Math.min(maxResults, 20);
    console.log(`[WebSearch] Searching for: "${query}" (max results: ${max})`);
    
    // Use Brave Search API
    return await this.searchBrave(query, braveApiKey, max);
  }

  /**
   * Parse Brave API rate limit headers and update rate limiter configuration
   * Format: X-RateLimit-Limit: "1, 15000" (per-second, per-month)
   *         X-RateLimit-Remaining: "1, 1000" (remaining per-second, remaining per-month)
   *         X-RateLimit-Reset: "1, 1419704" (seconds until reset)
   */
  private updateRateLimiterFromBraveHeaders(response: { headers: { get: (name: string) => string | null } }): void {
    try {
      const limitHeader = response.headers.get('X-RateLimit-Limit');
      const remainingHeader = response.headers.get('X-RateLimit-Remaining');
      const resetHeader = response.headers.get('X-RateLimit-Reset');
      
      if (limitHeader) {
        // Parse comma-separated values - first value is per-second limit
        const limits = limitHeader.split(',').map(v => parseInt(v.trim(), 10));
        const perSecondLimit = limits[0];
        const perMonthLimit = limits.length > 1 ? limits[1] : null;
        
        if (perSecondLimit && perSecondLimit > 0) {
          // Update rate limiter: perSecondLimit requests per 1000ms window
          this.rateLimiter.configure('search', perSecondLimit, 1000);
          console.log(`[WebSearch] Rate limiter updated from Brave API: ${perSecondLimit} requests/second`);
          
          if (perMonthLimit) {
            console.log(`[WebSearch] Monthly limit: ${perMonthLimit} requests`);
          }
        }
      }
      
      if (remainingHeader) {
        const remaining = remainingHeader.split(',').map(v => parseInt(v.trim(), 10));
        console.log(`[WebSearch] Rate limit remaining: ${remaining[0]} per-second, ${remaining.length > 1 ? remaining[1] : 'N/A'} per-month`);
      }
      
      if (resetHeader) {
        const resets = resetHeader.split(',').map(v => parseInt(v.trim(), 10));
        console.log(`[WebSearch] Rate limit resets in: ${resets[0]} seconds (per-second), ${resets.length > 1 ? Math.floor(resets[1] / 86400) : 'N/A'} days (per-month)`);
      }
    } catch (error) {
      // If header parsing fails, log but don't throw - use existing rate limiter config
      console.warn('[WebSearch] Could not parse Brave API rate limit headers, using default rate limits:', error);
    }
  }

  /**
   * Search using Brave Search API
   */
  private async searchBrave(query: string, braveApiKey: string, maxResults: number): Promise<SearchResult[]> {
    console.log('[WebSearch] Using Brave Search API...');
    
    const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('count', maxResults.toString());
    searchUrl.searchParams.set('safesearch', 'moderate');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    try {
      const response = await fetch(searchUrl.toString(), {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': braveApiKey
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Update rate limiter based on API response headers
      this.updateRateLimiterFromBraveHeaders(response);
      
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Brave API authentication failed (${response.status}). Please check your brave_api_key parameter.`);
        }
        
        // Handle rate limit exceeded (429)
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const resetHeader = response.headers.get('X-RateLimit-Reset');
          
          let waitTime: number | null = null;
          let errorMessage = 'Brave API rate limit exceeded.';
          
          // Check Retry-After header (seconds to wait)
          if (retryAfter) {
            waitTime = parseInt(retryAfter, 10);
            errorMessage += ` Retry after ${waitTime} seconds.`;
          } 
          // Fallback to X-RateLimit-Reset header
          else if (resetHeader) {
            const resets = resetHeader.split(',').map(v => parseInt(v.trim(), 10));
            waitTime = resets[0]; // Per-second reset time
            errorMessage += ` Rate limit resets in ${waitTime} seconds.`;
          }
          
          // Log detailed rate limit information
          const remainingHeader = response.headers.get('X-RateLimit-Remaining');
          if (remainingHeader) {
            const remaining = remainingHeader.split(',').map(v => parseInt(v.trim(), 10));
            errorMessage += ` Remaining: ${remaining[0]} per-second, ${remaining.length > 1 ? remaining[1] : 'N/A'} per-month.`;
          }
          
          throw new Error(errorMessage);
        }
        
        throw new Error(`Brave API returned status ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json() as any;
      
      if (!data.web || !data.web.results || data.web.results.length === 0) {
        console.log(`[WebSearch] No results found for query: "${query}"`);
        return [];
      }
      
      // Map Brave's result format to our SearchResult interface
      const results: SearchResult[] = data.web.results
        .slice(0, maxResults)
        .map((result: any) => ({
          title: result.title?.substring(0, 500) || 'No title',
          url: result.url || '',
          snippet: (result.description || 'No description available').substring(0, 500)
        }))
        .filter((result: SearchResult) => result.url && result.title); // Filter out invalid results
      
      console.log(`[WebSearch] Brave found ${results.length} results`);
      return results;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Brave Search API request timed out');
      }
      throw error;
    }
  }



  /**
   * Get formatted search results for LLM consumption
   * @param query - The search query string
   * @param braveApiKey - The Brave Search API key (required, provided by MCP client)
   * @param maxResults - Maximum number of results to return (default: 10)
   */
  async searchWebFormatted(query: string, braveApiKey: string, maxResults: number = 10): Promise<string> {
    const results = await this.searchWeb(query, braveApiKey, maxResults);
    return this.formatSearchResultsForLLM(results);
  }

  /**
   * Fetch and parse content from a URL
   * Includes rate limiting and intelligent text extraction
   */
  async fetchUrl(url: string): Promise<FetchResult> {
    // Apply rate limiting
    await this.rateLimiter.acquire('fetch');

    try {
      // Clean and validate URL
      const cleanUrl = this.cleanUrl(url);
      new URL(cleanUrl); // Throws if invalid

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // Increased to 15s
      
      let response;
      try {
        response = await fetch(cleanUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          signal: controller.signal,
          redirect: 'follow' // Follow redirects automatically
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const finalUrl = response.url || cleanUrl;
        
        // Only process HTML and text content
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
          return {
            url: finalUrl,
            title: 'Non-text content',
            content: '',
            textContent: `Content type ${contentType} is not supported. Only HTML and plain text are supported.`
          };
        }

        const html = await response.text();
        
        if (contentType.includes('text/plain')) {
          // Truncate plain text to 50k chars
          const truncated = html.substring(0, 50000);
          return {
            url: finalUrl,
            title: finalUrl.split('/').pop() || finalUrl,
            content: truncated,
            textContent: truncated
          };
        }

        // Parse HTML with cheerio
        const $ = cheerio.load(html);
        
        // Remove unwanted elements
        $('script, style, noscript, nav, header, footer, aside, .advertisement, .ads, [class*="ad-"], [class*="advertisement"], [id*="ad-"], [id*="advertisement"]').remove();
        
        // Remove comments
        $.root().find('*').contents().filter(function() {
          return this.nodeType === 8; // Comment node
        }).remove();
        
        // Get title - try multiple sources
        const title = $('title').text().trim() || 
                      $('h1').first().text().trim() || 
                      $('meta[property="og:title"]').attr('content') ||
                      $('meta[name="twitter:title"]').attr('content') ||
                      finalUrl.split('/').pop()?.split('?')[0] || 
                      finalUrl;
        
        // Extract main content - try multiple strategies
        let mainContent = $('main, article, [role="main"]').first();
        
        if (mainContent.length === 0) {
          // Try finding content by common class names
          mainContent = $('.content, .main-content, .post-content, .entry-content, .article-content').first();
        }
        
        if (mainContent.length === 0) {
          // Fallback to body but remove nav/header/footer
          mainContent = $('body');
          mainContent.find('nav, header, footer').remove();
        }
        
        // Get text content with better formatting
        let textContent = mainContent.text()
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0 && line.length > 2) // Filter very short lines
          .filter(line => !line.match(/^(cookie|privacy|terms|skip|menu|search|login|register)$/i)) // Filter common navigation text
          .join('\n')
          .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with double
          .trim();

        // Truncate to 50k characters, but try to preserve sentence boundaries
        if (textContent.length > 50000) {
          const truncated = textContent.substring(0, 50000);
          const lastSentence = truncated.lastIndexOf('.');
          const lastParagraph = truncated.lastIndexOf('\n\n');
          const cutPoint = Math.max(lastSentence, lastParagraph);
          textContent = truncated.substring(0, cutPoint > 40000 ? cutPoint : 50000) + '\n\n[Content truncated...]';
        }

        return {
          url: finalUrl,
          title: title.substring(0, 500), // Limit title length
          content: mainContent.html() || '',
          textContent: textContent
        };
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('URL fetch request timed out after 15 seconds');
        }
        throw error;
      }
    } catch (error: any) {
      console.error('URL fetch error:', error);
      if (error instanceof TypeError && error.message.includes('Invalid URL')) {
        throw new Error(`Invalid URL: ${url}`);
      }
      if (error.message.includes('rate limit')) {
        throw new Error('Rate limit exceeded. Please wait before trying again.');
      }
      throw new Error(`Failed to fetch URL: ${error.message}`);
    }
  }

  /**
   * Get formatted content for LLM consumption
   */
  async fetchUrlFormatted(url: string): Promise<string> {
    const result = await this.fetchUrl(url);
    return `Title: ${result.title}\nURL: ${result.url}\n\n${result.textContent}`;
  }
}

