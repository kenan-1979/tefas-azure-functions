const axios = require('axios');
const NodeCache = require('node-cache');

// ─── In-Memory Cache (TTL: 600 sn = 10 dk) ────────────────────────────────
// Azure Function'da process ömrü boyunca yaşar.
// Daha kalıcı cache için Azure Cache for Redis bağlantısı eklenebilir.
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const TEFAS_BASE = 'https://www.tefas.gov.tr/api/DB';

// CORS başlıkları — SPFx ve Power BI için
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Content-Type': 'application/json; charset=utf-8',
};

/**
 * TEFAS Proxy Azure Function
 *
 * Desteklenen endpoint'ler (query param: endpoint):
 *   - portfolio   → BindPortfolioDistribution (varlık dağılımı)
 *   - history     → BindHistoryInfo (fiyat geçmişi)
 *   - fundlist    → BindFundList (fon listesi arama)
 *   - fundinfo    → BindFundInfo (fon detayı)
 *
 * Query parametreler:
 *   - endpoint  : yukarıdaki tip
 *   - fonkod    : fon kodu (SKZ, AFT ...)
 *   - fontip    : YAT | EMK (varsayılan: YAT)
 *   - bastarih  : DD.MM.YYYY
 *   - bittarih  : DD.MM.YYYY
 *   - query     : fundlist araması için serbest metin
 *
 * Örnek: GET /api/TefasProxy?endpoint=portfolio&fonkod=SKZ&bastarih=01.03.2026&bittarih=07.04.2026
 */
module.exports = async function (context, req) {

    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
        context.res = { status: 204, headers: CORS_HEADERS, body: '' };
        return;
    }

    const endpoint = (req.query.endpoint || '').toLowerCase();
    const fonkod   = (req.query.fonkod   || '').trim().toUpperCase();
    const fontip   = (req.query.fontip   || 'YAT').toUpperCase();
    const bastarih = req.query.bastarih  || '';
    const bittarih = req.query.bittarih  || '';
    const query    = req.query.query     || '';

    // ── Parametre doğrulama ──────────────────────────────────────────────
    if (!endpoint) {
        context.res = {
            status: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'endpoint parametresi zorunlu', gecerliEndpointler: ['portfolio','history','fundlist','fundinfo'] })
        };
        return;
    }

    // ── Cache key ────────────────────────────────────────────────────────
    const cacheKey = `tefas:${endpoint}:${fonkod}:${fontip}:${bastarih}:${bittarih}:${query}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
        context.log(`[CACHE HIT] ${cacheKey}`);
        context.res = {
            status: 200,
            headers: { ...CORS_HEADERS, 'X-Cache': 'HIT', 'X-Cache-Key': cacheKey },
            body: JSON.stringify({ ...cached, _cache: 'HIT' })
        };
        return;
    }

    // ── TEFAS'a istek ────────────────────────────────────────────────────
    let tefasUrl = '';
    let params   = {};

    switch (endpoint) {
        case 'portfolio':
            if (!fonkod)   { context.res = err(400, 'fonkod zorunlu'); return; }
            if (!bastarih) { context.res = err(400, 'bastarih zorunlu'); return; }
            if (!bittarih) { context.res = err(400, 'bittarih zorunlu'); return; }
            tefasUrl = `${TEFAS_BASE}/BindPortfolioDistribution`;
            params   = { fontip, fonkod, bastarih, bittarih };
            break;

        case 'history':
            if (!fonkod)   { context.res = err(400, 'fonkod zorunlu'); return; }
            if (!bastarih) { context.res = err(400, 'bastarih zorunlu'); return; }
            if (!bittarih) { context.res = err(400, 'bittarih zorunlu'); return; }
            tefasUrl = `${TEFAS_BASE}/BindHistoryInfo`;
            params   = { fontip, fonkod, bastarih, bittarih };
            break;

        case 'fundlist':
            tefasUrl = `${TEFAS_BASE}/BindFundList`;
            params   = { fontip, ad: query };
            break;

        case 'fundinfo':
            if (!fonkod) { context.res = err(400, 'fonkod zorunlu'); return; }
            tefasUrl = `${TEFAS_BASE}/BindFundInfo`;
            params   = { fontip, fonkod };
            break;

        default:
            context.res = err(400, `Bilinmeyen endpoint: ${endpoint}`);
            return;
    }

    try {
        context.log(`[TEFAS REQUEST] ${tefasUrl} params=${JSON.stringify(params)}`);

        const response = await axios.get(tefasUrl, {
            params,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TEFASDashboard/1.0)',
                'Referer': 'https://www.tefas.gov.tr/',
                'X-Requested-With': 'XMLHttpRequest',
            }
        });

        const data = response.data;

        // Normalleştir: her endpoint için tutarlı { data: [...] } formatı
        const normalized = normalizeResponse(endpoint, data);

        // Cache'e yaz
        cache.set(cacheKey, normalized);
        context.log(`[CACHE SET] ${cacheKey} — ${(normalized.data || []).length} kayıt`);

        context.res = {
            status: 200,
            headers: { ...CORS_HEADERS, 'X-Cache': 'MISS' },
            body: JSON.stringify({ ...normalized, _cache: 'MISS' })
        };

    } catch (e) {
        context.log.error(`[TEFAS ERROR] ${e.message}`);
        context.res = {
            status: 502,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: 'TEFAS isteği başarısız',
                mesaj: e.message,
                tefasUrl,
            })
        };
    }
};

// ── Yanıt normalleştirici ────────────────────────────────────────────────────
function normalizeResponse(endpoint, raw) {
    const rows = raw.data || raw.Data || raw || [];

    switch (endpoint) {
        case 'portfolio':
            return {
                data: (Array.isArray(rows) ? rows : []).map(r => ({
                    tarih:          parseTefasDate(r.TARIH || r.tarih || ''),
                    varlikKodu:     (r.VARLIK_TIP_KOD || r.varlik_tip_kod || '').trim().toUpperCase(),
                    varlikAdi:      r.VARLIK_TIP_ADI  || r.varlik_tip_adi  || '',
                    agirlik:        toFloat(r.NET_PAY || r.net_pay),
                    fonBuyuklugu:   toFloat(r.PORTFOY_DEGERI || r.portfoy_degeri),
                    yatirimci:      toInt  (r.YATIRIMCI_SAYISI || r.yatirimci_sayisi),
                    gunlukNakit:    toFloat(r.TEDAVUL_TUTARI || r.tedavul_tutari),
                }))
            };

        case 'history':
            return {
                data: (Array.isArray(rows) ? rows : []).map(r => ({
                    tarih:    parseTefasDate(r.TARIH || r.tarih || ''),
                    fiyat:    toFloat(r.FIYAT || r.fiyat || r.BIRIM_PAY_DEGERI || r.birim_pay_degeri),
                    buyukluk: toFloat(r.PORTFOY_BUYUKLUGU || r.portfoy_buyuklugu),
                }))
            };

        case 'fundlist':
            return {
                data: (Array.isArray(rows) ? rows : []).map(r => ({
                    fonKodu:  (r.FONKODU  || r.fonkodu  || r.KOD || '').trim().toUpperCase(),
                    fonAdi:   r.FONADI   || r.fonadi   || r.AD  || '',
                    fonTip:   r.FONTIP   || r.fontip   || '',
                    yonetici: r.YONETICI || r.yonetici || '',
                }))
            };

        case 'fundinfo':
            return {
                data: Array.isArray(rows) ? rows : [rows],
            };

        default:
            return { data: Array.isArray(rows) ? rows : [] };
    }
}

// ── Yardımcılar ──────────────────────────────────────────────────────────────
function parseTefasDate(raw) {
    if (!raw) return '';
    const dot = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (dot) return `${dot[3]}-${dot[2]}-${dot[1]}`;
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const ms = raw.match(/\/Date\((\d+)\)\//);
    if (ms) return new Date(parseInt(ms[1])).toISOString().substring(0, 10);
    return raw;
}
function toFloat(v) { return parseFloat(v) || 0; }
function toInt(v)   { return parseInt(v, 10) || 0; }
function err(status, mesaj) {
    return { status, headers: CORS_HEADERS, body: JSON.stringify({ error: mesaj }) };
}
