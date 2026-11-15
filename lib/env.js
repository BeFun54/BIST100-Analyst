'use strict';

/**
 * Minimal .env yukleyici (npm bagimliligi yok).
 *
 * Proje kokundeki .env dosyasini okur ve process.env'e aktarir.
 * Zaten tanimli olan ortam degiskenlerini EZMEZ (gercek sistem
 * degiskenleri .env'den onceliklidir). .env yoksa sessizce gecer.
 */

const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const target = file || path.join(__dirname, '..', '.env');
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return; // .env yoksa sorun degil
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Tirnaklari temizle (orn. AI_API_KEY="nvapi-...")
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnv();

module.exports = { loadEnv };
