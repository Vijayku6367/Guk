import axios from 'axios';
import * as cheerio from 'cheerio';

// Tor gateway – public tor2web type, Vercel se allowed
const GATEWAY = 'https://onion.ws/';  // change to onion.ly, onion.sh, etc if needed

// Function to fetch onion page through gateway
async function fetchOnion(onion) {
  const cleanOnion = onion.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = GATEWAY + cleanOnion;
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    // don't follow redirects automatically if it redirects to payment
    maxRedirects: 0,
    validateStatus: (status) => status < 400,
  }).catch(async (err) => {
    // if maxRedirects exceeded, manually follow once
    if (err.response && err.response.status >= 300 && err.response.status < 400) {
      const location = err.response.headers.location;
      if (location) {
        // follow manually with gateway
        const newUrl = location.startsWith('http') ? location : GATEWAY + location.replace(/^\//, '');
        return axios.get(newUrl, { timeout: 15000 });
      }
    }
    throw err;
  });
  return response.data;
}

// Bypass method 1: direct video/audio/media tags
function extractMediaFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const sources = [];
  // video src
  $('video source').each((i, el) => {
    const src = $(el).attr('src');
    if (src) sources.push({ url: makeAbsolute(src, baseUrl), type: $(el).attr('type') || 'video/mp4' });
  });
  // video direct src
  $('video[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src) sources.push({ url: makeAbsolute(src, baseUrl), type: 'video/mp4' });
  });
  // iframe with known embed (like tube sites)
  $('iframe').each((i, el) => {
    const src = $(el).attr('src');
    if (src && (src.includes('stream') || src.includes('embed'))) {
      sources.push({ url: makeAbsolute(src, baseUrl), type: 'iframe' });
    }
  });
  // object / embed
  $('object param[name=movie]').each((i, el) => {
    const val = $(el).attr('value');
    if (val) sources.push({ url: makeAbsolute(val, baseUrl), type: 'application/x-shockwave-flash' });
  });
  // direct links to common extensions
  $('a[href$=".mp4"], a[href$=".webm"], a[href$=".m3u8"], a[href$=".mpd"]').each((i, el) => {
    sources.push({ url: makeAbsolute($(el).attr('href'), baseUrl), type: 'unknown' });
  });
  return sources;
}

function makeAbsolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Attempt to set a payment cookie and reload
async function bypassCookieTrick(onion, html) {
  // If site checks cookie 'paid' or 'premium', we inject it
  const cookiesToTry = [
    'paid=1; premium=1; membership=active; access=all; subscriber=1; token=bypass; session=permanent; loggedin=true; has_paid=true; unlock=ok; pp_sub=1',
  ];
  // We'll just try to fetch content page with cookies set, without payment redirect
  // Not guaranteed but works on many weak paywalls.
  const cleanOnion = onion.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const baseUrl = GATEWAY + cleanOnion;
  for (let cookieStr of cookiesToTry) {
    try {
      const resp = await axios.get(baseUrl, {
        headers: {
          Cookie: cookieStr,
          'User-Agent': 'Mozilla/5.0',
        },
        timeout: 10000,
        maxRedirects: 2,
      });
      // check if still redirects to payment page
      if (resp.data && !/(payment|subscribe|premium|unlock|order)/i.test(resp.data)) {
        const media = extractMediaFromHtml(resp.data, baseUrl);
        if (media.length > 0) return media;
      }
    } catch (e) { /* ignore */ }
  }
  return [];
}

// Check if there is a known payment callback URL that can be triggered
async function fakePaymentCallback(onion) {
  // Some sites use a third-party payment processor that sends a callback to a specific URL
  // We try common patterns
  const callbacks = [
    '/payment/success',
    '/pay/complete',
    '/order/confirm',
    '/callback.php?status=ok',
    '/api/payment/verify',
    '/ipn/success',
    '/return/success',
  ];
  const cleanOnion = onion.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const base = GATEWAY + cleanOnion;
  for (let cb of callbacks) {
    try {
      const target = base + cb;
      const resp = await axios.get(target, { timeout: 10000, maxRedirects: 2 });
      if (resp.status === 200 && resp.data && !/(payment|error)/i.test(resp.data)) {
        const media = extractMediaFromHtml(resp.data, base);
        if (media.length > 0) return media;
      }
    } catch (e) { /* */ }
  }
  return [];
}

// Check for unprotected HLS/m3u8 or MPEG-DASH in page or linked resources
async function deepScanForStreams(html, baseUrl) {
  const $ = cheerio.load(html);
  // Look for JavaScript variables containing video URL patterns
  const scripts = $('script').map((i, el) => $(el).html()).get().join('\n');
  const regex = /(https?:\/\/[^"'\s]+\.(m3u8|mpd|mp4|webm))/gi;
  let match;
  const found = [];
  while ((match = regex.exec(scripts)) !== null) {
    found.push({ url: match[1], type: match[1].endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/mp4' });
  }
  return found;
}

export default async function handler(req, res) {
  const { onion } = req.query;
  if (!onion) {
    return res.status(400).json({ error: 'Onion link do' });
  }

  let onionClean = onion.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const gatewayBase = GATEWAY + onionClean;

  try {
    // Step 1: fetch page normally
    let html = await fetchOnion(onionClean);
    
    // Step 2: search direct media
    let media = extractMediaFromHtml(html, gatewayBase);
    if (media.length > 0) {
      return res.json({ type: media[0].type || 'video/mp4', url: media[0].url });
    }

    // Step 3: attempt cookie bypass
    media = await bypassCookieTrick(onionClean, html);
    if (media.length > 0) {
      return res.json({ type: media[0].type || 'video/mp4', url: media[0].url });
    }

    // Step 4: fake payment callback
    media = await fakePaymentCallback(onionClean);
    if (media.length > 0) {
      return res.json({ type: media[0].type || 'video/mp4', url: media[0].url });
    }

    // Step 5: deep JS scan for streams
    media = await deepScanForStreams(html, gatewayBase);
    if (media.length > 0) {
      return res.json({ type: media[0].type, url: media[0].url });
    }

    // If nothing found, try with alternate gateways
    const altGateways = ['https://onion.ly/', 'https://onion.sh/', 'https://onion.ws/']; // cycle if needed
    for (let altGate of altGateways) {
      try {
        const altBase = altGate + onionClean;
        const altResp = await axios.get(altBase, { timeout: 12000 });
        media = extractMediaFromHtml(altResp.data, altBase);
        if (media.length > 0) {
          return res.json({ type: media[0].type || 'video/mp4', url: media[0].url });
        }
        media = await deepScanForStreams(altResp.data, altBase);
        if (media.length > 0) {
          return res.json({ type: media[0].type, url: media[0].url });
        }
      } catch (e) {}
    }

    return res.json({ error: 'Bypass ke liye koi direct media nahi mila. Site strong paywall use karti hai.' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Site fetch nahi ho paayi, Tor gateway down ya invalid onion.' });
  }
}
