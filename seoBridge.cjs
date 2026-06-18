'use strict';
/**
 * SEO Bridge — connects this service to the SEO Traffic Engine.
 * Provides Amazon affiliate links and eBay product search.
 */
const https = require('https');
const http = require('http');
const { URLSearchParams } = require('url');

const SEO_ENGINE = process.env.SEO_ENGINE_URL || 'https://seo-traffic-engine-production.up.railway.app';
const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || 'bullpower-21';
const EBAY_APP_ID = process.env.EBAY_APP_ID || '';

function fetchJSON(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const lib = url.protocol === 'https:' ? https : http;
        const body = options.body ? JSON.stringify(options.body) : null;
        const reqOpts = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...(body && { 'Content-Length': Buffer.byteLength(body) }) },
            timeout: 8000,
        };
        const req = lib.request(reqOpts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('SEO timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function getAmazonProducts(keyword, limit = 5) {
    const url = `https://www.amazon.de/s?k=${encodeURIComponent(keyword)}&tag=${AMAZON_TAG}`;
    return [{ title: `Amazon: ${keyword}`, url, source: 'amazon', price: '' }];
}

async function getEbayProducts(keyword, limit = 5) {
    if (EBAY_APP_ID) {
        try {
            const params = new URLSearchParams({
                'OPERATION-NAME': 'findItemsByKeywords',
                'SERVICE-VERSION': '1.0.0',
                'SECURITY-APPNAME': EBAY_APP_ID,
                'RESPONSE-DATA-FORMAT': 'JSON',
                'keywords': keyword,
                'paginationInput.entriesPerPage': String(limit),
            });
            const data = await fetchJSON(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
            const items = data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];
            return items.slice(0, limit).map(i => ({
                title: i.title?.[0] || keyword,
                url: i.viewItemURL?.[0] || '',
                price: i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || '',
                source: 'ebay',
            }));
        } catch (e) {
            console.warn('[SEOBridge] eBay API error:', e.message);
        }
    }
    return [{ title: `eBay: ${keyword}`, url: `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(keyword)}`, source: 'ebay', price: '' }];
}

async function getMarketplaceProducts(keyword, source = 'all', limit = 5) {
    const result = { keyword, amazon: [], ebay: [] };
    if (source === 'amazon' || source === 'all') result.amazon = await getAmazonProducts(keyword, limit);
    if (source === 'ebay' || source === 'all') result.ebay = await getEbayProducts(keyword, limit);
    return result;
}

async function pushKeyword(keyword) {
    try {
        await fetchJSON(`${SEO_ENGINE}/api/trigger/articles`, { method: 'POST', body: { keyword } });
        return true;
    } catch (e) {
        console.warn('[SEOBridge] push keyword failed:', e.message);
        return false;
    }
}

async function getSeoStats() {
    try { return await fetchJSON(`${SEO_ENGINE}/stats`); }
    catch { return {}; }
}

function addExpressRoutes(app, projectKeywords = []) {
    app.get('/api/seo/products', async (req, res) => {
        const keyword = req.query.keyword || projectKeywords[0] || 'shopify automation';
        const source = req.query.source || 'all';
        try {
            const products = await getMarketplaceProducts(keyword, source);
            res.json({ keyword, ...products });
        } catch (e) {
            res.json({ keyword, amazon: [], ebay: [], error: e.message });
        }
    });
    app.get('/api/seo/status', async (req, res) => {
        try {
            const stats = await getSeoStats();
            res.json({ seo_engine: SEO_ENGINE, stats, keywords: projectKeywords.slice(0, 10) });
        } catch (e) {
            res.json({ seo_engine: SEO_ENGINE, error: e.message });
        }
    });
}

function startBackgroundSync(keywords = [], intervalHours = 6) {
    const sync = async () => {
        for (const kw of keywords.slice(0, 5)) {
            await pushKeyword(kw);
        }
        console.log(`[SEOBridge] Synced ${keywords.length} keywords`);
    };
    setTimeout(sync, 120000);
    setInterval(sync, intervalHours * 3600 * 1000);
}

module.exports = { getAmazonProducts, getEbayProducts, getMarketplaceProducts, pushKeyword, getSeoStats, addExpressRoutes, startBackgroundSync };
