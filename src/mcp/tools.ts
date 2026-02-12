// Author: Preston Lee

import { WebSearchService } from '../services/web-search/index.js';
import { SearXNGService } from '../services/searxng.service.js';

export interface MCPTool {
  name: string;
  description: string;
  /** User-facing message shown while the tool is executing */
  statusMessage?: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export class ToolExecutor {
  private webSearchService: WebSearchService;
  private searxngService: SearXNGService;

  constructor() {
    this.webSearchService = new WebSearchService();
    this.searxngService = new SearXNGService();
  }

  /**
   * Get all available MCP tools
   * Matches DuckDuckGo MCP Server tool definitions
   */
  async getAvailableTools(): Promise<MCPTool[]> {
    return [
      {
        name: 'fetch_content',
        description: 'Fetches and parses content from a webpage and returns a single formatted string for LLM context. Use this when you need to inject page content directly into your response or context. Includes intelligent text extraction, rate limiting (20 requests per minute), and removes ads and irrelevant content. Return value: a single string with title, URL, and body text (newline-separated). Supports HTML and plain text URLs.',
        statusMessage: 'Fetching content...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The webpage URL to fetch content from (HTTP or HTTPS)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'fetch_url',
        description: 'Download and parse web content from a URL and return structured metadata plus text. Use this when you need individual fields (title, url, snippet length, hasMoreContent) or to check if content was truncated. Returns an object: { url, title, contentLength, textContent (max 10000 chars), hasMoreContent }. Rate limiting: 20 requests per minute. Supports HTML and plain text.',
        statusMessage: 'Fetching URL...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to fetch and parse (HTTP or HTTPS)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'searxng_search',
        description: 'Perform an anonymous web search via a user-configured SearXNG instance (no API key required). Returns an object: { query, resultsCount, results: [{ title, url, snippet }] }. Use when you need structured search results to process or filter. Requires searxng_base_url from the user. Rate limited (30 requests per minute). Optional: categories, language, time_range, safesearch, max_results (1–50).',
        statusMessage: 'Searching web (SearXNG)...',
        parameters: {
          type: 'object',
          properties: {
            searxng_base_url: {
              type: 'string',
              description: 'Base URL of the SearXNG instance (e.g. https://search.example.org). No trailing slash.'
            },
            query: {
              type: 'string',
              description: 'The search query string'
            },
            format: {
              type: 'string',
              description: 'SearXNG output format. Use json (default); this server parses and returns structured results only for json.',
              enum: ['json', 'csv', 'rss']
            },
            categories: {
              type: 'string',
              description: 'Comma-separated categories (e.g. general, science)'
            },
            language: {
              type: 'string',
              description: 'Language code (e.g. en-US)'
            },
            pageno: {
              type: 'number',
              description: 'Page number (default: 1)'
            },
            time_range: {
              type: 'string',
              description: 'Filter by time: day, week, month, year'
            },
            safesearch: {
              type: 'number',
              description: 'SafeSearch level: 0=off, 1=moderate, 2=strict'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10, max: 50)'
            }
          },
          required: ['searxng_base_url', 'query']
        }
      },
      {
        name: 'searxng_search_formatted',
        description: 'Perform an anonymous web search via a SearXNG instance and return a single formatted string for LLM context (no API key required). Use when you want to inject search results directly into your response. Return value: a single string with numbered entries (title, URL, description per result). Requires searxng_base_url. Rate limited (30 requests per minute). Same optional parameters as searxng_search (categories, language, time_range, safesearch, max_results 1–50).',
        statusMessage: 'Searching web (SearXNG)...',
        parameters: {
          type: 'object',
          properties: {
            searxng_base_url: {
              type: 'string',
              description: 'Base URL of the SearXNG instance (e.g. https://search.example.org). No trailing slash.'
            },
            query: {
              type: 'string',
              description: 'The search query string'
            },
            categories: {
              type: 'string',
              description: 'Comma-separated categories (e.g. general, science)'
            },
            language: {
              type: 'string',
              description: 'Language code (e.g. en-US)'
            },
            pageno: {
              type: 'number',
              description: 'Page number (default: 1)'
            },
            time_range: {
              type: 'string',
              description: 'Filter by time: day, week, month, year'
            },
            safesearch: {
              type: 'number',
              description: 'SafeSearch level: 0=off, 1=moderate, 2=strict'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10, max: 50)'
            }
          },
          required: ['searxng_base_url', 'query']
        }
      },
      {
        name: 'searxng_search_then_fetch',
        description: 'Run a SearXNG search and then fetch full page content for the top results in one call. Use when you need both search and full text of the first few results. Returns an array of { url, title, snippet, content } (content is formatted body text). Consumes 1 search + N fetch rate limit tokens (N = max_results_to_fetch, default 3, max 5). Requires searxng_base_url and query.',
        statusMessage: 'Searching and fetching...',
        parameters: {
          type: 'object',
          properties: {
            searxng_base_url: {
              type: 'string',
              description: 'Base URL of the SearXNG instance (e.g. https://search.example.org). No trailing slash.'
            },
            query: {
              type: 'string',
              description: 'The search query string'
            },
            max_results_to_fetch: {
              type: 'number',
              description: 'Number of search results to fetch full content for (default: 3, max: 5)'
            },
            categories: { type: 'string', description: 'Comma-separated categories (e.g. general, science)' },
            language: { type: 'string', description: 'Language code (e.g. en-US)' },
            time_range: { type: 'string', description: 'Filter by time: day, week, month, year' },
            safesearch: { type: 'number', description: 'SafeSearch level: 0=off, 1=moderate, 2=strict' }
          },
          required: ['searxng_base_url', 'query']
        }
      },
      {
        name: 'searxng_search_then_fetch_formatted',
        description: 'Run a SearXNG search and fetch full content for the top results, then return a single formatted string for LLM context. Same as searxng_search_then_fetch but returns one string with all results concatenated. Use for "search and read" in one step. max_results_to_fetch default 3, max 5.',
        statusMessage: 'Searching and fetching...',
        parameters: {
          type: 'object',
          properties: {
            searxng_base_url: {
              type: 'string',
              description: 'Base URL of the SearXNG instance (e.g. https://search.example.org). No trailing slash.'
            },
            query: {
              type: 'string',
              description: 'The search query string'
            },
            max_results_to_fetch: {
              type: 'number',
              description: 'Number of search results to fetch full content for (default: 3, max: 5)'
            },
            categories: { type: 'string', description: 'Comma-separated categories (e.g. general, science)' },
            language: { type: 'string', description: 'Language code (e.g. en-US)' },
            time_range: { type: 'string', description: 'Filter by time: day, week, month, year' },
            safesearch: { type: 'number', description: 'SafeSearch level: 0=off, 1=moderate, 2=strict' }
          },
          required: ['searxng_base_url', 'query']
        }
      },
      {
        name: 'batch_fetch',
        description: 'Fetch multiple URLs in one call and return structured results for each. Use when you already have a list of URLs (e.g. from searxng_search). Returns array of { url, title, contentLength, textContent (max 10000 chars), hasMoreContent }. Max 10 URLs per call. Each URL consumes one fetch rate limit token (20/min).',
        statusMessage: 'Fetching URLs...',
        parameters: {
          type: 'object',
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of URLs to fetch (max 10). Each must be HTTP or HTTPS.'
            }
          },
          required: ['urls']
        }
      },
      {
        name: 'fetch_metadata',
        description: 'Lightweight fetch: get final URL (after redirects), status code, content-type, and optional title/description/image from HTML meta tags (Open Graph, Twitter Card). Use to check if a link is valid, get preview card data, or decide whether to run fetch_content. Does not download full body (reads only first 150KB for meta). Rate limited (20/min, same as fetch).',
        statusMessage: 'Fetching metadata...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to fetch metadata for (HTTP or HTTPS)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'fetch_feed',
        description: 'Fetch and parse an RSS or Atom feed. Returns feed title, link, description, and list of entries (title, link, summary, date). Use for blogs, news, and "what\'s new" discovery. Rate limited (20/min, same as fetch).',
        statusMessage: 'Fetching feed...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The feed URL (RSS or Atom, HTTP or HTTPS)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'fetch_content_as_markdown',
        description: 'Fetch a webpage and return its main content as Markdown (headings, lists, links preserved). Use when you want structured Markdown instead of plain text. Return value: single string with title, URL, and Markdown body. Rate limited (20/min, same as fetch).',
        statusMessage: 'Fetching as Markdown...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The webpage URL to fetch (HTTP or HTTPS)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'extract_links',
        description: 'Fetch a page and return all outbound links. Use for discovery or crawling. Returns array of { href, text }. Optionally restrict to same domain only. Rate limited (20/min).',
        statusMessage: 'Extracting links...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The page URL to extract links from (HTTP or HTTPS)'
            },
            same_domain_only: {
              type: 'boolean',
              description: 'If true, only return links whose host matches the page host (default: false)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'fetch_sitemap',
        description: 'Fetch and parse a sitemap.xml (or sitemap index). Returns either urlset (list of page URLs with optional lastmod, changefreq, priority) or sitemapindex (list of child sitemap URLs). Use expand_index to follow an index and aggregate URLs from up to 10 child sitemaps. Rate limited (20/min; expanding an index consumes 1 + N tokens).',
        statusMessage: 'Fetching sitemap...',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The sitemap URL (e.g. https://example.com/sitemap.xml)'
            },
            expand_index: {
              type: 'boolean',
              description: 'If true and the sitemap is an index, fetch each child sitemap (max 10) and return all URLs (default: false)'
            }
          },
          required: ['url']
        }
      },
      {
        name: 'get_rate_limit_status',
        description: 'Return remaining rate limit tokens for fetch and search. Use to decide whether to batch requests or wait. No parameters. Does not consume any tokens.',
        statusMessage: 'Checking rate limits...',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    ];
  }

  async executeTool(toolName: string, params: any): Promise<any> {
    const paramsForLog = this.sanitizeParamsForLog(params);
    console.log(`[MCP] Tool invoked: ${toolName}`, JSON.stringify(paramsForLog));

    const start = Date.now();
    try {
      const result = await this.executeToolInternal(toolName, params);
      const duration = Date.now() - start;
      console.log(`[MCP] Tool completed: ${toolName} (${duration}ms)`);
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[MCP] Tool failed: ${toolName} (${duration}ms) - ${message}`);
      throw err;
    }
  }

  /** Truncate/sanitize params for logging to avoid huge payloads. */
  private sanitizeParamsForLog(params: any): Record<string, unknown> {
    if (params == null || typeof params !== 'object') return {};
    const out: Record<string, unknown> = {};
    const maxStr = 200;
    const maxArray = 5;
    for (const [k, v] of Object.entries(params)) {
      if (v == null) out[k] = v;
      else if (typeof v === 'string') out[k] = v.length <= maxStr ? v : v.slice(0, maxStr) + '...';
      else if (Array.isArray(v)) out[k] = v.length <= maxArray ? v : `[${v.length} items]`;
      else if (typeof v === 'object') out[k] = '[object]';
      else out[k] = v;
    }
    return out;
  }

  private async executeToolInternal(toolName: string, params: any): Promise<any> {
    switch (toolName) {
      case 'fetch_content':
        return await this.executeFetchContent(params);
      case 'fetch_url':
        return await this.executeFetchUrl(params);
      case 'searxng_search':
        return await this.executeSearXNGSearch(params);
      case 'searxng_search_formatted':
        return await this.executeSearXNGSearchFormatted(params);
      case 'searxng_search_then_fetch':
        return await this.executeSearXNGSearchThenFetch(params);
      case 'searxng_search_then_fetch_formatted':
        return await this.executeSearXNGSearchThenFetchFormatted(params);
      case 'batch_fetch':
        return await this.executeBatchFetch(params);
      case 'fetch_metadata':
        return await this.executeFetchMetadata(params);
      case 'fetch_feed':
        return await this.executeFetchFeed(params);
      case 'fetch_content_as_markdown':
        return await this.executeFetchContentAsMarkdown(params);
      case 'extract_links':
        return await this.executeExtractLinks(params);
      case 'fetch_sitemap':
        return await this.executeFetchSitemap(params);
      case 'get_rate_limit_status':
        return await this.executeGetRateLimitStatus(params);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async executeFetchContent(params: any): Promise<string> {
    const { url } = params;
    if (!url || typeof url !== 'string') throw new Error('URL parameter is required and must be a string');
    return await this.webSearchService.fetchUrlFormatted(url);
  }

  private async executeFetchUrl(params: any): Promise<any> {
    const { url } = params;
    if (!url || typeof url !== 'string') throw new Error('URL parameter is required and must be a string');
    const result = await this.webSearchService.fetchUrl(url);
    return {
      url: result.url,
      title: result.title,
      contentLength: result.textContent.length,
      textContent: result.textContent.substring(0, 10000),
      hasMoreContent: result.textContent.length > 10000
    };
  }

  private async executeSearXNGSearch(params: any): Promise<any> {
    const { searxng_base_url, query, format, categories, language, pageno, time_range, safesearch, max_results = 10 } = params;
    if (!query || typeof query !== 'string') throw new Error('query is required and must be a string');
    if (!searxng_base_url || typeof searxng_base_url !== 'string' || !searxng_base_url.trim()) throw new Error('searxng_base_url is required and must be a non-empty string');
    const results = await this.searxngService.search({
      searxng_base_url: searxng_base_url.trim(),
      query: query.trim(),
      format: format || 'json',
      categories,
      language,
      pageno,
      time_range,
      safesearch,
      max_results
    });
    return {
      query,
      resultsCount: results.length,
      results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet || r.content || '' }))
    };
  }

  private async executeSearXNGSearchFormatted(params: any): Promise<string> {
    const { searxng_base_url, query, categories, language, pageno, time_range, safesearch, max_results = 10 } = params;
    if (!query || typeof query !== 'string') throw new Error('query is required and must be a string');
    if (!searxng_base_url || typeof searxng_base_url !== 'string' || !searxng_base_url.trim()) throw new Error('searxng_base_url is required and must be a non-empty string');
    return await this.searxngService.searchFormatted({
      searxng_base_url: searxng_base_url.trim(),
      query: query.trim(),
      format: 'json',
      categories,
      language,
      pageno,
      time_range,
      safesearch,
      max_results
    });
  }

  private async executeSearXNGSearchThenFetch(params: any): Promise<any[]> {
    const { searxng_base_url, query, max_results_to_fetch = 3, categories, language, time_range, safesearch } = params;
    if (!query || typeof query !== 'string') throw new Error('query is required and must be a string');
    if (!searxng_base_url || typeof searxng_base_url !== 'string' || !searxng_base_url.trim()) throw new Error('searxng_base_url is required and must be a non-empty string');
    const toFetch = Math.min(5, Math.max(1, Number(max_results_to_fetch) || 3));
    const results = await this.searxngService.search({
      searxng_base_url: searxng_base_url.trim(),
      query: query.trim(),
      format: 'json',
      categories,
      language,
      pageno: 1,
      time_range,
      safesearch,
      max_results: toFetch
    });
    const out: Array<{ url: string; title: string; snippet: string; content: string }> = [];
    for (const r of results) {
      if (!r.url) continue;
      try {
        const content = await this.webSearchService.fetchUrlFormatted(r.url);
        out.push({ url: r.url, title: r.title || 'No title', snippet: (r.snippet || r.content || '').substring(0, 500), content });
      } catch (err) {
        out.push({ url: r.url, title: r.title || 'No title', snippet: (r.snippet || r.content || '').substring(0, 500), content: `[Failed to fetch: ${err instanceof Error ? err.message : String(err)}]` });
      }
    }
    return out;
  }

  private async executeSearXNGSearchThenFetchFormatted(params: any): Promise<string> {
    const items = await this.executeSearXNGSearchThenFetch(params);
    return items.map((item, i) => `--- Result ${i + 1}: ${item.title} ---\nURL: ${item.url}\n\n${item.content}`).join('\n\n');
  }

  private async executeBatchFetch(params: any): Promise<any[]> {
    const { urls } = params;
    if (!Array.isArray(urls) || urls.length === 0) throw new Error('urls is required and must be a non-empty array of URL strings');
    const list = urls.slice(0, 10).filter((u: unknown) => typeof u === 'string' && (u as string).trim());
    if (list.length === 0) throw new Error('urls must contain at least one non-empty URL string');
    const out: any[] = [];
    for (const url of list) {
      try {
        const result = await this.webSearchService.fetchUrl(url);
        out.push({
          url: result.url,
          title: result.title,
          contentLength: result.textContent.length,
          textContent: result.textContent.substring(0, 10000),
          hasMoreContent: result.textContent.length > 10000
        });
      } catch (err) {
        out.push({ url: (url as string).trim(), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  private async executeFetchMetadata(params: any): Promise<any> {
    const { url } = params;
    if (!url || typeof url !== 'string') throw new Error('url is required and must be a string');
    return await this.webSearchService.fetchMetadata(url);
  }

  private async executeFetchFeed(params: any): Promise<any> {
    const { url } = params;
    if (!url || typeof url !== 'string') throw new Error('url is required and must be a string');
    return await this.webSearchService.fetchFeed(url);
  }

  private async executeFetchContentAsMarkdown(params: any): Promise<string> {
    const { url } = params;
    if (!url || typeof url !== 'string') throw new Error('url is required and must be a string');
    return await this.webSearchService.fetchUrlAsMarkdown(url);
  }

  private async executeExtractLinks(params: any): Promise<any[]> {
    const { url, same_domain_only } = params;
    if (!url || typeof url !== 'string') throw new Error('url is required and must be a string');
    return await this.webSearchService.extractLinks(url, Boolean(same_domain_only));
  }

  private async executeFetchSitemap(params: any): Promise<any> {
    const { url, expand_index } = params;
    if (!url || typeof url !== 'string') throw new Error('url is required and must be a string');
    return await this.webSearchService.fetchSitemap(url, Boolean(expand_index));
  }

  private async executeGetRateLimitStatus(_params: any): Promise<any> {
    return {
      fetch_remaining: this.webSearchService.getRemainingFetchTokens(),
      searxng_remaining: this.searxngService.getRemainingSearchTokens()
    };
  }
}
