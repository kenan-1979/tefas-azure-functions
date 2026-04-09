const axios = require('axios');
const { TableClient } = require('@azure/data-tables');

/**
 * AlarmChecker — Azure Function Timer Trigger
 * Her gün saat 19:00 TR saatinde çalışır (UTC 16:00)
 * Cron: "0 0 16 * * *"
 *
 * Alarmları Azure Table Storage'dan okur, TEFAS'tan günlük veri çeker,
 * tetiklenen alarmlar için bildirim gönderir (webhook / email / Teams).
 *
 * Alarm tipleri:
 *   - PARA_CIKISI        : Günlük nakit çıkışı eşik değerini aşarsa
 *   - YATIRIMCI_AZALMA   : Yatırımcı sayısı % X düşerse
 *   - FON_DEGER_AZALMA   : Fon büyüklüğü % X düşerse
 *   - FIYAT_DEGISIM      : Birim pay fiyatı % X değişirse
 *   - PORTFOY_DEGISIM    : Belirli varlık sınıfının ağırlığı eşiği aşarsa
 */

const PROXY_BASE_URL = process.env.TEFAS_PROXY_URL || 'https://<YOUR_FUNC_APP>.azurewebsites.net/api/TefasProxy';
const TABLE_CONNECTION = process.env.AZURE_STORAGE_CONNECTION_STRING;
const ALARMS_TABLE = 'TefasAlarms';
const ALARM_LOG_TABLE = 'TefasAlarmLogs';

module.exports = async function (context, myTimer) {
    context.log('AlarmChecker başlatıldı:', new Date().toISOString());

    if (!TABLE_CONNECTION) {
        context.log.error('AZURE_STORAGE_CONNECTION_STRING tanımlı değil');
        return;
    }

    try {
        // 1. Aktif alarmları çek
        const alarmlar = await getAktifAlarmlar();
        context.log(`${alarmlar.length} aktif alarm bulundu`);

        if (alarmlar.length === 0) return;

        // 2. Benzersiz fon kodlarını topla
        const fonKodlari = [...new Set(alarmlar.map(a => a.fonKodu))];

        // 3. Her fon için bugünkü veriyi çek
        const fonVerileri = {};
        const bugun = new Date();
        const dun   = new Date(bugun.getTime() - 2 * 86400000); // 2 gün geri (hafta sonu için)
        const bit   = formatTefasDate(bugun);
        const bas   = formatTefasDate(dun);

        for (const kod of fonKodlari) {
            try {
                const [portfolioRes, historyRes] = await Promise.all([
                    axios.get(`${PROXY_BASE_URL}?endpoint=portfolio&fonkod=${kod}&bastarih=${bas}&bittarih=${bit}`),
                    axios.get(`${PROXY_BASE_URL}?endpoint=history&fonkod=${kod}&bastarih=${bas}&bittarih=${bit}`),
                ]);
                fonVerileri[kod] = {
                    portfolio: portfolioRes.data.data || [],
                    history:   historyRes.data.data   || [],
                };
            } catch (e) {
                context.log.warn(`${kod} verisi alınamadı: ${e.message}`);
                fonVerileri[kod] = { portfolio: [], history: [] };
            }
        }

        // 4. Her alarmu kontrol et
        const tetiklenenler = [];
        for (const alarm of alarmlar) {
            const veri = fonVerileri[alarm.fonKodu];
            if (!veri) continue;

            const sonuc = checkAlarm(alarm, veri);
            if (sonuc.tetiklendi) {
                tetiklenenler.push({ alarm, sonuc });
                await logAlarm(alarm, sonuc);
            }
        }

        context.log(`${tetiklenenler.length} alarm tetiklendi`);

        // 5. Bildirimleri gönder
        for (const { alarm, sonuc } of tetiklenenler) {
            await sendNotification(alarm, sonuc, context);
        }

    } catch (e) {
        context.log.error('AlarmChecker hatası:', e.message);
    }
};

// ── Alarm Kontrol Mantığı ────────────────────────────────────────────────────
function checkAlarm(alarm, veri) {
    const { portfolio, history } = veri;

    // En son ve bir önceki veri noktası
    const son = portfolio[portfolio.length - 1];
    const onceki = portfolio.length > 1 ? portfolio[portfolio.length - 2] : null;
    const sonFiyat = history[history.length - 1];
    const oncekiFiyat = history.length > 1 ? history[history.length - 2] : null;

    if (!son) return { tetiklendi: false };

    switch (alarm.tip) {
        case 'PARA_CIKISI': {
            // gunlukNakit negatif ve mutlak değer eşiği aşıyorsa
            const nakit = son.gunlukNakit || 0;
            const esik  = parseFloat(alarm.esikDeger) || 0;
            if (nakit < 0 && Math.abs(nakit) >= esik) {
                return {
                    tetiklendi: true,
                    mesaj: `💸 ${alarm.fonKodu}: Günlük para çıkışı ${formatPara(nakit)} M TL (eşik: ${formatPara(-esik)} M TL)`,
                    deger: nakit,
                    esik,
                };
            }
            break;
        }

        case 'YATIRIMCI_AZALMA': {
            if (!onceki) return { tetiklendi: false };
            const deg = ((son.yatirimci - onceki.yatirimci) / onceki.yatirimci) * 100;
            const esik = parseFloat(alarm.esikDeger) || 0;
            if (deg <= -esik) {
                return {
                    tetiklendi: true,
                    mesaj: `👥 ${alarm.fonKodu}: Yatırımcı sayısı %${Math.abs(deg).toFixed(2)} düştü (${onceki.yatirimci} → ${son.yatirimci})`,
                    deger: deg,
                    esik,
                };
            }
            break;
        }

        case 'FON_DEGER_AZALMA': {
            if (!onceki) return { tetiklendi: false };
            const deg = ((son.fonBuyuklugu - onceki.fonBuyuklugu) / onceki.fonBuyuklugu) * 100;
            const esik = parseFloat(alarm.esikDeger) || 0;
            if (deg <= -esik) {
                return {
                    tetiklendi: true,
                    mesaj: `📉 ${alarm.fonKodu}: Fon değeri %${Math.abs(deg).toFixed(2)} düştü`,
                    deger: deg,
                    esik,
                };
            }
            break;
        }

        case 'FIYAT_DEGISIM': {
            if (!sonFiyat || !oncekiFiyat) return { tetiklendi: false };
            const deg = ((sonFiyat.fiyat - oncekiFiyat.fiyat) / oncekiFiyat.fiyat) * 100;
            const esik = parseFloat(alarm.esikDeger) || 0;
            const mutlakDeg = Math.abs(deg);
            const yon = alarm.yon || 'HER_IKISI'; // ASAGI | YUKARI | HER_IKISI
            const tetikle = yon === 'HER_IKISI' ? mutlakDeg >= esik
                          : yon === 'ASAGI'     ? deg <= -esik
                          : deg >= esik;
            if (tetikle) {
                return {
                    tetiklendi: true,
                    mesaj: `💹 ${alarm.fonKodu}: Fiyat ${deg >= 0 ? '+' : ''}${deg.toFixed(3)}% (${oncekiFiyat.fiyat.toFixed(4)} → ${sonFiyat.fiyat.toFixed(4)} TL)`,
                    deger: deg,
                    esik,
                };
            }
            break;
        }

        case 'PORTFOY_DEGISIM': {
            // Belirli varlık sınıfının ağırlığı eşiği aşarsa
            const varlikKodu = (alarm.varlikKodu || '').toUpperCase();
            const varlikRow = portfolio.find(r => r.varlikKodu === varlikKodu);
            const agirlik = varlikRow ? varlikRow.agirlik : 0;
            const esik = parseFloat(alarm.esikDeger) || 0;
            const yon = alarm.yon || 'ASAGI'; // ASAGI | YUKARI
            const tetikle = yon === 'ASAGI' ? agirlik <= esik : agirlik >= esik;
            if (tetikle) {
                return {
                    tetiklendi: true,
                    mesaj: `📊 ${alarm.fonKodu}: ${varlikKodu} ağırlığı %${agirlik.toFixed(2)} (eşik: %${esik})`,
                    deger: agirlik,
                    esik,
                };
            }
            break;
        }
    }

    return { tetiklendi: false };
}

// ── Azure Table Storage ──────────────────────────────────────────────────────
async function getAktifAlarmlar() {
    const client = TableClient.fromConnectionString(TABLE_CONNECTION, ALARMS_TABLE);
    const alarmlar = [];
    for await (const entity of client.listEntities()) {
        if (entity.aktif !== false) {
            alarmlar.push({
                id:          entity.rowKey,
                fonKodu:     entity.fonKodu,
                tip:         entity.tip,
                esikDeger:   entity.esikDeger,
                yon:         entity.yon,
                varlikKodu:  entity.varlikKodu,
                webhookUrl:  entity.webhookUrl,
                email:       entity.email,
                teamsWebhook: entity.teamsWebhook,
                kullanici:   entity.partitionKey,
            });
        }
    }
    return alarmlar;
}

async function logAlarm(alarm, sonuc) {
    try {
        const client = TableClient.fromConnectionString(TABLE_CONNECTION, ALARM_LOG_TABLE);
        await client.createEntity({
            partitionKey: alarm.fonKodu,
            rowKey:       `${Date.now()}_${alarm.id}`,
            alarmId:      alarm.id,
            tip:          alarm.tip,
            mesaj:        sonuc.mesaj,
            deger:        String(sonuc.deger),
            tarih:        new Date().toISOString(),
        });
    } catch (e) {
        // Log başarısız olursa alarm akışını durdurma
    }
}

// ── Bildirim Gönderme ────────────────────────────────────────────────────────
async function sendNotification(alarm, sonuc, context) {
    const mesaj = sonuc.mesaj;

    // Teams Webhook
    if (alarm.teamsWebhook) {
        try {
            await axios.post(alarm.teamsWebhook, {
                '@type': 'MessageCard',
                '@context': 'http://schema.org/extensions',
                themeColor: 'FF0000',
                summary: 'TEFAS Alarm',
                sections: [{
                    activityTitle: '🚨 TEFAS Fon Alarmı',
                    activityText: mesaj,
                    facts: [
                        { name: 'Fon', value: alarm.fonKodu },
                        { name: 'Alarm Tipi', value: alarm.tip },
                        { name: 'Tetiklenme', value: new Date().toLocaleString('tr-TR') },
                    ]
                }]
            });
            context.log(`Teams bildirimi gönderildi: ${alarm.fonKodu}`);
        } catch (e) {
            context.log.warn(`Teams bildirimi başarısız: ${e.message}`);
        }
    }

    // Generic Webhook (Slack, vb.)
    if (alarm.webhookUrl) {
        try {
            await axios.post(alarm.webhookUrl, { text: mesaj, alarm, sonuc });
        } catch (e) {
            context.log.warn(`Webhook bildirimi başarısız: ${e.message}`);
        }
    }
}

// ── Yardımcılar ──────────────────────────────────────────────────────────────
function formatTefasDate(d) {
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}
function formatPara(v) {
    return (v / 1_000_000).toFixed(2);
}
