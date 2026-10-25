import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceDetail, deviceLabel } from './device.ts';

// [user-agent reale, tipo atteso, "tipo, browser" atteso]
const CASI: [string, string, string, string][] = [
  ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iPhone', 'iPhone, Safari'],
  ['iPhone Chrome', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1', 'iPhone', 'iPhone, Chrome'],
  ['iPhone Firefox', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15', 'iPhone', 'iPhone, Firefox'],
  ['iPhone app dalla Home', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iPhone', 'iPhone, app installata'],
  ['iPad (app dalla Home)', 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'iPad', 'iPad, app installata'],
  ['iPad "sito desktop" (si presenta come Mac)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'computer', 'computer, Safari'],
  ['Android telefono Chrome', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'telefono Android', 'telefono Android, Chrome'],
  ['Android tablet Chrome', 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'tablet Android', 'tablet Android, Chrome'],
  ['Android Firefox', 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0', 'telefono Android', 'telefono Android, Firefox'],
  ['Android Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'telefono Android', 'telefono Android, Samsung Internet'],
  ['Windows Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 'computer', 'computer, Edge'],
  ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'computer', 'computer, Chrome'],
  ['Mac Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'computer', 'computer, Safari'],
  ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'computer', 'computer, Firefox'],
  ['Chromebook', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'computer', 'computer, Chrome'],
  ['sconosciuto / vuoto', '', 'altro dispositivo', 'altro dispositivo'],
  ['strumento da riga di comando', 'curl/8.7.1', 'altro dispositivo', 'altro dispositivo'],
];

for (const [nome, ua, tipo, dettaglio] of CASI) {
  test(`dispositivo riconosciuto: ${nome}`, () => {
    assert.equal(deviceLabel(ua), tipo);
    assert.equal(deviceDetail(ua), dettaglio);
  });
}
