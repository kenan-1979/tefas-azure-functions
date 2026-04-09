const { TableClient } = require('@azure/data-tables');
const { v4: uuidv4 } = require('uuid');

const TABLE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE_NAME = 'TefasAlarms';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json; charset=utf-8',
};

/**
 * AlarmCRUD — Alarm yönetimi REST API
 *
 * GET    /api/AlarmCRUD?kullanici=xxx           → Kullanıcının alarmlarını listele
 * POST   /api/AlarmCRUD                          → Yeni alarm oluştur
 * PUT    /api/AlarmCRUD?id=xxx                   → Alarm güncelle
 * DELETE /api/AlarmCRUD?id=xxx&kullanici=xxx     → Alarm sil
 *
 * Alarm şeması:
 * {
 *   kullanici: "user@domain.com",
 *   fonKodu: "SKZ",
 *   tip: "PARA_CIKISI" | "YATIRIMCI_AZALMA" | "FON_DEGER_AZALMA" | "FIYAT_DEGISIM" | "PORTFOY_DEGISIM",
 *   esikDeger: 10,          // M TL veya % bağlama göre
 *   yon: "ASAGI" | "YUKARI" | "HER_IKISI",
 *   varlikKodu: "HS",       // PORTFOY_DEGISIM için
 *   teamsWebhook: "https://...",
 *   webhookUrl: "https://...",
 *   aktif: true
 * }
 */
module.exports = async function (context, req) {
    if (req.method === 'OPTIONS') {
        context.res = { status: 204, headers: CORS, body: '' };
        return;
    }

    const client = TableClient.fromConnectionString(TABLE_CONNECTION, TABLE_NAME);

    try {
        // Tablo yoksa oluştur
        await client.createTable().catch(() => {});

        switch (req.method) {
            case 'GET': {
                const kullanici = req.query.kullanici || 'default';
                const alarmlar = [];
                for await (const entity of client.listEntities({
                    queryOptions: { filter: `PartitionKey eq '${kullanici}'` }
                })) {
                    alarmlar.push(entityToAlarm(entity));
                }
                context.res = { status: 200, headers: CORS, body: JSON.stringify({ alarmlar }) };
                break;
            }

            case 'POST': {
                const body = req.body || {};
                if (!body.fonKodu || !body.tip) {
                    context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'fonKodu ve tip zorunlu' }) };
                    return;
                }
                const id = uuidv4();
                const kullanici = body.kullanici || 'default';
                await client.createEntity({
                    partitionKey: kullanici,
                    rowKey: id,
                    fonKodu:      body.fonKodu.toUpperCase(),
                    tip:          body.tip,
                    esikDeger:    String(body.esikDeger || 0),
                    yon:          body.yon || 'ASAGI',
                    varlikKodu:   body.varlikKodu || '',
                    teamsWebhook: body.teamsWebhook || '',
                    webhookUrl:   body.webhookUrl || '',
                    email:        body.email || '',
                    aktif:        true,
                    olusturma:    new Date().toISOString(),
                    aciklama:     body.aciklama || '',
                });
                context.res = { status: 201, headers: CORS, body: JSON.stringify({ id, mesaj: 'Alarm oluşturuldu' }) };
                break;
            }

            case 'PUT': {
                const id = req.query.id;
                const body = req.body || {};
                if (!id) { context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'id zorunlu' }) }; return; }
                const kullanici = body.kullanici || req.query.kullanici || 'default';
                const updates = {};
                if (body.esikDeger !== undefined) updates.esikDeger = String(body.esikDeger);
                if (body.yon       !== undefined) updates.yon = body.yon;
                if (body.aktif     !== undefined) updates.aktif = body.aktif;
                if (body.teamsWebhook) updates.teamsWebhook = body.teamsWebhook;
                if (body.webhookUrl)   updates.webhookUrl = body.webhookUrl;
                if (body.aciklama)     updates.aciklama = body.aciklama;
                await client.updateEntity({ partitionKey: kullanici, rowKey: id, ...updates }, 'Merge');
                context.res = { status: 200, headers: CORS, body: JSON.stringify({ mesaj: 'Alarm güncellendi' }) };
                break;
            }

            case 'DELETE': {
                const id = req.query.id;
                const kullanici = req.query.kullanici || 'default';
                if (!id) { context.res = { status: 400, headers: CORS, body: JSON.stringify({ error: 'id zorunlu' }) }; return; }
                await client.deleteEntity(kullanici, id);
                context.res = { status: 200, headers: CORS, body: JSON.stringify({ mesaj: 'Alarm silindi' }) };
                break;
            }

            default:
                context.res = { status: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
        }
    } catch (e) {
        context.log.error('AlarmCRUD hatası:', e.message);
        context.res = { status: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
};

function entityToAlarm(e) {
    return {
        id:          e.rowKey,
        kullanici:   e.partitionKey,
        fonKodu:     e.fonKodu,
        tip:         e.tip,
        esikDeger:   parseFloat(e.esikDeger) || 0,
        yon:         e.yon,
        varlikKodu:  e.varlikKodu,
        teamsWebhook: e.teamsWebhook,
        webhookUrl:  e.webhookUrl,
        email:       e.email,
        aktif:       e.aktif !== false,
        olusturma:   e.olusturma,
        aciklama:    e.aciklama || '',
    };
}
