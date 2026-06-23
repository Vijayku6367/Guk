// api/bypass.js  –  Vercel serverless function
// Complete rewrite of paywall bypass for Node.js + Vercel.
// Uses native fetch (Node 18+), socks-proxy-agent for Tor, and built-in URL parser.
// Environment variables: TOR_PROXY (default socks5h://127.0.0.1:9050), MAX_RETRIES, TIMEOUT_MS

import { SocksProxyAgent } from 'socks-proxy-agent';
import * as cheerio from 'cheerio';   // for HTML parsing

// ========== CONFIGURATION FROM ENV ==========
const TOR_PROXY = process.env.TOR_PROXY || 'socks5h://127.0.0.1:9050';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS) || 120000; // 120 sec
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ========== HELPER: FETCH WITH RETRY AND TOR PROXY ==========
async function fetchWithTor(url, options = {}, retries = MAX_RETRIES) {
  const agent = new SocksProxyAgent(TOR_PROXY);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const defaultOptions = {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://www.google.com/',
    },
    agent: agent,
    signal: controller.signal,
    compress: true,
    redirect: 'follow',
  };

  const finalOptions = { ...defaultOptions, ...options };
  // If options.headers exist, merge
  if (options.headers) {
    finalOptions.headers = { ...defaultOptions.headers, ...options.headers };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, finalOptions);
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt === retries) throw error;
      // Exponential backoff: 2^attempt * 1000 ms
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ========== PAYWALL DETECTION AND BYPASS LOGIC ==========
function detectPaywall(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().toLowerCase();
  if (bodyText.includes('subscribe') || bodyText.includes('paywall') || bodyText.includes('membership')) {
    return 'generic';
  }
  // Check for Stripe, MemberPress, etc.
  if (html.includes('stripe') || html.includes('chargebee')) return 'stripe';
  if (html.includes('wp-login') || html.includes('/membership/')) return 'wordpress';
  return 'none';
}

async function bypassGeneric(url) {
  // Try AMP, print, or ?format=full
  const variants = [
    url + (url.includes('?') ? '&amp=1' : '?amp=1'),
    url + (url.includes('?') ? '&print=1' : '?print=1'),
    url + (url.includes('?') ? '&format=full' : '?format=full'),
  ];
  for (const variant of variants) {
    try {
      const result = await fetchWithTor(variant);
      // Check if content is still truncated
      if (result.text.length > 1000 && !result.text.includes('Subscribe to continue')) {
        return result.text;
      }
    } catch (e) { /* continue */ }
  }
  // Fallback: try to remove overlay via regex (simple)
  // We'll just return the original HTML with any overlay div removed using cheerio
  const original = await fetchWithTor(url);
  const $ = cheerio.load(original.text);
  $('.paywall-overlay, .gate, .premium-lock, .membership-overlay').remove();
  return $.html();
}

async function bypassStripe(url) {
  // This is a placeholder – in serverless you cannot run interactive payment.
  // We'll try to extract the content by accessing the REST API or preview.
  // Often Stripe sites use a JSON endpoint for content.
  // Attempt to fetch /wp-json or /api/content
  const base = new URL(url);
  const apiCandidates = [
    `${base.origin}/wp-json/wp/v2/posts?slug=${base.pathname.split('/').pop()}`,
    `${base.origin}/api/content?path=${base.pathname}`,
  ];
  for (const apiUrl of apiCandidates) {
    try {
      const result = await fetchWithTor(apiUrl, { headers: { 'Accept': 'application/json' } });
      const json = JSON.parse(result.text);
      if (json.content && json.content.rendered) return json.content.rendered;
      if (json.body) return json.body;
    } catch (e) { /* ignore */ }
  }
  // Fallback: return original with overlay removal
  const html = await fetchWithTor(url);
  const $ = cheerio.load(html.text);
  $('.stripe-payment, .payment-overlay').remove();
  return $.html();
}

async function bypassWordpress(url) {
  // Try to fetch via REST API with ?rest_route=
  const base = new URL(url);
  const postId = base.searchParams.get('p') || base.pathname.match(/\/(\d+)\/?$/)?.[1];
  if (postId) {
    const apiUrl = `${base.origin}/wp-json/wp/v2/posts/${postId}`;
    try {
      const result = await fetchWithTor(apiUrl, { headers: { 'Accept': 'application/json' } });
      const json = JSON.parse(result.text);
      if (json.content && json.content.rendered) {
        return json.content.rendered;
      }
    } catch (e) { /* fall through */ }
  }
  // Try ?preview=true
  const previewUrl = url + (url.includes('?') ? '&preview=true' : '?preview=true');
  try {
    const result = await fetchWithTor(previewUrl);
    // Check if it returns full post
    if (result.text.length > 500 && !result.text.includes('preview')) {
      return result.text;
    }
  } catch (e) { /* ignore */ }
  // Last resort: remove membership wrappers
  const html = await fetchWithTor(url);
  const $ = cheerio.load(html.text);
  $('.memberpress-lock, .rcp-restrict, .membership-content').remove();
  return $.html();
}

// ========== MAIN HANDLER ==========
export default async function handler(req, res) {
  // Only allow GET requests with ?url= parameter
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }
  // Basic URL validation (allow http/https and onion)
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Invalid URL protocol' });
  }

  try {
    // First, fetch the page to detect paywall type
    const initial = await fetchWithTor(targetUrl);
    const paywallType = detectPaywall(initial.text);
    let bypassedHtml = '';

    switch (paywallType) {
      case 'generic':
        bypassedHtml = await bypassGeneric(targetUrl);
        break;
      case 'stripe':
        bypassedHtml = await bypassStripe(targetUrl);
        break;
      case 'wordpress':
        bypassedHtml = await bypassWordpress(targetUrl);
        break;
      default:
        // No paywall detected – return original content
        bypassedHtml = initial.text;
        break;
    }

    // Extract plain text (remove scripts/styles) for cleaner output
    const $ = cheerio.load(bypassedHtml);
    $('script, style, noscript').remove();
    const textContent = $('body').text().replace(/\s+/g, ' ').trim();
    // Limit response size to 1MB (Vercel limit)
    const truncated = textContent.slice(0, 1000000);

    res.status(200).json({
      success: true,
      paywallType,
      content: truncated,
      contentLength: truncated.length,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}
