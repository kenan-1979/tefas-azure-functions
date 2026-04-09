const axios = require('axios');
const ExcelJS = require('exceljs');

const PROXY_BASE_URL = process.env.TEFAS_PROXY_URL || 'https://<YOUR_FUNC_APP>.azurewebsites.net/api/TefasProxy';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * ExcelExport — TEFAS verisini Excel olarak döner
 * GET /api/ExcelExport?fonkod=SKZ&bastarih=01.03.2026&bittarih=07.04.2026
 */
module.exports = async function (context, req) {
    if (req.method === 'OPTIONS') {
        context.res = { status: 204, headers: CORS, body: '' };
        return;
    }

    const fonkod   = (req.query.fonkod || '').toUpperCase();
    const bastarih = req.query.bastarih || '';
    const bittarih = req.query.bittarih || '';

    if (!fonkod || !bastarih || !bittarih) {
        context.res = {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'fonkod, bastarih, bittarih zorunlu' })
        };
        return;
    }

    try {
        // Veriyi çek
        const [portRes, histRes] = await Promise.all([
            axios.get(`${PROXY_BASE_URL}?endpoint=portfolio&fonkod=${fonkod}&bastarih=${bastarih}&bittarih=${bittarih}`),
            axios.get(`${PROXY_BASE_URL}?endpoint=history&fonkod=${fonkod}&bastarih=${bastarih}&bittarih=${bittarih}`),
        ]);

        const portfolio = portRes.data.data || [];
        const history   = histRes.data.data || [];

        // Excel oluştur
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'TEFAS Dashboard';
        workbook.created = new Date();

        // ── Sayfa 1: Özet ──────────────────────────────────────────────
        const ozet = workbook.addWorksheet('Özet');
        ozet.columns = [
            { header: 'Tarih',              key: 'tarih',        width: 14 },
            { header: 'Fiyat (TL)',         key: 'fiyat',        width: 14, style: { numFmt: '0.0000' } },
            { header: 'Günlük %',           key: 'gunlukPct',    width: 12, style: { numFmt: '0.00%' } },
            { header: 'Fon Büyüklüğü (M TL)',key: 'buyukluk',   width: 20, style: { numFmt: '#,##0.000' } },
            { header: 'Yatırımcı Sayısı',  key: 'yatirimci',    width: 18, style: { numFmt: '#,##0' } },
            { header: 'Nakit Giriş/Çıkış (M TL)', key: 'nakit',width: 24, style: { numFmt: '#,##0.000' } },
        ];
        styleHeader(ozet);

        // Tarihe göre günlük özet oluştur
        const tarihMap = {};
        portfolio.forEach(r => {
            if (!tarihMap[r.tarih]) {
                tarihMap[r.tarih] = {
                    tarih:     r.tarih,
                    buyukluk:  r.fonBuyuklugu / 1_000_000,
                    yatirimci: r.yatirimci,
                    nakit:     r.gunlukNakit  / 1_000_000,
                };
            }
        });
        history.forEach(r => {
            if (!tarihMap[r.tarih]) tarihMap[r.tarih] = { tarih: r.tarih };
            tarihMap[r.tarih].fiyat = r.fiyat;
        });

        const ozetRows = Object.values(tarihMap).sort((a, b) => a.tarih.localeCompare(b.tarih));
        ozetRows.forEach((row, i) => {
            const onceki = i > 0 ? ozetRows[i - 1] : null;
            const gunlukPct = onceki && onceki.fiyat && row.fiyat
                ? (row.fiyat - onceki.fiyat) / onceki.fiyat
                : null;
            ozet.addRow({ ...row, gunlukPct });
        });

        // Koşullu renk — nakit sütunu
        ozetRows.forEach((row, i) => {
            const excelRow = ozet.getRow(i + 2); // header = 1
            const nakitCell = excelRow.getCell('nakit');
            if (row.nakit < 0) {
                nakitCell.font = { color: { argb: 'FFF85149' } };
            } else if (row.nakit > 0) {
                nakitCell.font = { color: { argb: 'FF3FB950' } };
            }
        });

        // ── Sayfa 2: Varlık Dağılımı ──────────────────────────────────
        const varlik = workbook.addWorksheet('Varlık Dağılımı');
        varlik.columns = [
            { header: 'Tarih',        key: 'tarih',       width: 14 },
            { header: 'Varlık Kodu', key: 'varlikKodu',   width: 14 },
            { header: 'Varlık Adı',  key: 'varlikAdi',    width: 30 },
            { header: 'Ağırlık (%)', key: 'agirlik',      width: 14, style: { numFmt: '0.00' } },
        ];
        styleHeader(varlik);
        portfolio.forEach(r => {
            varlik.addRow({
                tarih:      r.tarih,
                varlikKodu: r.varlikKodu,
                varlikAdi:  r.varlikAdi,
                agirlik:    r.agirlik,
            });
        });

        // ── Sayfa 3: Fiyat Geçmişi ────────────────────────────────────
        const fiyatSheet = workbook.addWorksheet('Fiyat Geçmişi');
        fiyatSheet.columns = [
            { header: 'Tarih',         key: 'tarih',    width: 14 },
            { header: 'Kapanış Fiyatı',key: 'fiyat',    width: 16, style: { numFmt: '0.0000' } },
            { header: 'Büyüklük (M TL)',key: 'buyukluk',width: 18, style: { numFmt: '#,##0.000' } },
        ];
        styleHeader(fiyatSheet);
        history.forEach(r => {
            fiyatSheet.addRow({ tarih: r.tarih, fiyat: r.fiyat, buyukluk: r.buyukluk / 1_000_000 });
        });

        // ── Meta bilgi ────────────────────────────────────────────────
        const meta = workbook.addWorksheet('Bilgi');
        meta.addRow(['Fon Kodu', fonkod]);
        meta.addRow(['Başlangıç', bastarih]);
        meta.addRow(['Bitiş', bittarih]);
        meta.addRow(['Oluşturulma', new Date().toLocaleString('tr-TR')]);
        meta.addRow(['Kaynak', 'TEFAS - www.tefas.gov.tr']);

        // Buffer olarak döndür
        const buffer = await workbook.xlsx.writeBuffer();

        context.res = {
            status: 200,
            headers: {
                ...CORS,
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${fonkod}_${bastarih}_${bittarih}.xlsx"`,
            },
            isRaw: true,
            body: Buffer.from(buffer),
        };

    } catch (e) {
        context.log.error('ExcelExport hatası:', e.message);
        context.res = {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: e.message }),
        };
    }
};

function styleHeader(sheet) {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFE6EDF3' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6FEB' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
}
