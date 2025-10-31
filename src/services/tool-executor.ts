// Author: Preston Lee

import { WebSearchService } from './web-search.service.js';

export interface MCPTool {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export class ToolExecutor {
  private webSearchService: WebSearchService;

  constructor() {
    this.webSearchService = new WebSearchService();
  }

  /**
   * Get all available MCP tools
   * Matches DuckDuckGo MCP Server tool definitions
   */
  async getAvailableTools(): Promise<MCPTool[]> {
    return [
      {
        name: 'search',
        description: 'Performs a web search using Brave Search API and returns formatted results. Requires brave_api_key parameter to be provided by the MCP client. Includes rate limiting (30 requests per minute). Results are formatted for optimal LLM consumption.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query string to execute'
            },
            brave_api_key: {
              type: 'string',
              description: 'The Brave Search API key (required). Get your free API key at: https://brave.com/search/api'
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10, max: 20)',
              default: 10
            }
          },
          required: ['query', 'brave_api_key']
        }
      },
      {
        name: 'fetch_content',
        description: 'Fetches and parses content from a webpage. Includes intelligent text extraction, rate limiting (20 requests per minute), and removes ads and irrelevant content. Returns cleaned and formatted text content optimized for LLM consumption.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The webpage URL to fetch content from'
            }
          },
          required: ['url']
        }
      },
      // Keep legacy tool names for backward compatibility
      {
        name: 'web_search',
        description: 'Perform a web search using Brave Search API. Requires brave_api_key parameter to be provided by the MCP client. Returns search results with titles, URLs, and snippets. Includes rate limiting (30 requests per minute).',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query to execute'
            },
            brave_api_key: {
              type: 'string',
              description: 'The Brave Search API key (required). Get your free API key at: https://brave.com/search/api'
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10, max: 20)',
              default: 10
            }
          },
          required: ['query', 'brave_api_key']
        }
      },
      {
        name: 'fetch_url',
        description: 'Download and parse web content from a URL. Extracts text content from HTML pages with intelligent parsing. Supports HTML and plain text content types. Includes rate limiting (20 requests per minute).',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'The URL to fetch and parse'
            }
          },
          required: ['url']
        }
      }
    ];
  }

  /**
   * Execute a tool by name
   * Supports both new tool names (search, fetch_content) and legacy names (web_search, fetch_url)
   */
  async executeTool(toolName: string, params: any): Promise<any> {
    switch (toolName) {
      case 'search':
        return await this.executeSearch(params);
      
      case 'fetch_content':
        return await this.executeFetchContent(params);
      
      case 'web_search':
        return await this.executeWebSearch(params);
      
      case 'fetch_url':
        return await this.executeFetchUrl(params);
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Execute search tool (new MCP-compatible name)
   * Returns formatted string for LLM consumption, matching Python MCP server behavior
   */
  private async executeSearch(params: any): Promise<string> {
    const { query, brave_api_key, max_results = 10 } = params;
    
    if (!query || typeof query !== 'string') {
      throw new Error('Query parameter is required and must be a string');
    }

    if (!brave_api_key || typeof brave_api_key !== 'string') {
      throw new Error('brave_api_key parameter is required and must be a string');
    }

    return await this.webSearchService.searchWebFormatted(query, brave_api_key, max_results);
  }

  /**
   * Execute fetch content tool (new MCP-compatible name)
   * Returns formatted string for LLM consumption, matching Python MCP server behavior
   */
  private async executeFetchContent(params: any): Promise<string> {
    const { url } = params;
    
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

    return await this.webSearchService.fetchUrlFormatted(url);
  }

  /**
   * Execute web search tool (legacy name for backward compatibility)
   */
  private async executeWebSearch(params: any): Promise<any> {
    const { query, brave_api_key, maxResults = 10 } = params;
    
    if (!query || typeof query !== 'string') {
      throw new Error('Query parameter is required and must be a string');
    }

    if (!brave_api_key || typeof brave_api_key !== 'string') {
      throw new Error('brave_api_key parameter is required and must be a string');
    }

    const results = await this.webSearchService.searchWeb(query, brave_api_key, maxResults);
    
    return {
      query,
      resultsCount: results.length,
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet
      }))
    };
  }

  /**
   * Execute URL fetch tool (legacy name for backward compatibility)
   */
  private async executeFetchUrl(params: any): Promise<any> {
    const { url } = params;
    
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

    const result = await this.webSearchService.fetchUrl(url);
    
    return {
      url: result.url,
      title: result.title,
      contentLength: result.textContent.length,
      textContent: result.textContent.substring(0, 10000), // Limit response size
      hasMoreContent: result.textContent.length > 10000
    };
  }
}

