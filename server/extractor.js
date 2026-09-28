import { setTimeout as delay } from 'node:timers/promises';
import { capture } from './process.js';
import { AppError } from './errors.js';
import { VIDEO_ID } from './input.js';
import { log, safeDiagnostic } from './log.js';

const AUTH_CHALLENGE = /sign in|log in|login required|private video|confirm (?:you(?:'|’)re|you are) not a bot|not a bot|unusual traffic|verify (?:that )?you(?:'|’)re|verification required|cookies? (?:are )?required/i;
const NOT_LIVE = /not currently live|not live|live event will begin|premieres in|offline/i;
const UNAVAILABLE = /video unavailable|removed|not available|copyright|members.only/i;

export class Extractor {
  constructor(config) {
    this.config = config;
    this.inflight = new Map();
    this.cache = new Map();
  }

  async extract(url, { signal, onChild } = {}) {
    const c = this.config;
    const deadline = Date.now() + c.extractTimeoutMs;
    let cookieAttempted = false;

    // First make a clean, cookie-free request. web_safari is useful for YouTube live HLS,
    // for which yt-dlp's current PO-token guidance says a GVS token is generally unnecessary.
    for (let attempt = 0; ; attempt++) {
      let args = [
        '--ignore-config', '--no-playlist', '--no-warnings', '--skip-download',
        '--dump-single-json', '--no-check-formats', '--socket-timeout', '8',
        '--retries', '1', '--extractor-retries', '2', '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=web_safari,web',
      ];
      if (cookieAttempted && c.cookies) args.push('--cookies', c.cookies);
      args.push('--', url);
      try {
        const raw = await capture(c.ytDlp, args, {
          timeoutMs: Math.max(1, deadline - Date.now()), signal, onChild,
        });
        const info = JSON.parse(raw);
        if (!VIDEO_ID.test(info.id || '')) throw new AppError('NOT_LIVE', 422);
        if (info.live_status !== 'is_live') throw new AppError('NOT_LIVE', 422);
        return info;
      } catch (e) {
        const detail = String(e.diagnostic || e.message || '');
        if (e instanceof AppError && e.code !== 'UPSTREAM_ERROR') throw e;
        if (e.diagnostic) {
          log('warn', 'extraction_failed', {
            attempt,
            cookiesUsed: cookieAttempted,
            detail: cookieAttempted ? '[redacted after cookie-authenticated request]' : safeDiagnostic(detail),
          });
          if (NOT_LIVE.test(detail)) throw new AppError('NOT_LIVE', 422);
          if (AUTH_CHALLENGE.test(detail)) {
            if (!cookieAttempted && c.cookies) {
              cookieAttempted = true;
              log('info', 'cookie_fallback', { available: true, reason: 'youtube_auth_challenge' });
              continue;
            }
            if (!cookieAttempted && c.cookieConfigured && c.cookieValid === false)
              throw new AppError('COOKIE_CONFIG_INVALID', 422);
            if (!cookieAttempted)
              throw new AppError('COOKIE_REQUIRED', 422);
            throw new AppError('SOURCE_UNAVAILABLE', 422);
          }
          if (UNAVAILABLE.test(detail)) throw new AppError('SOURCE_UNAVAILABLE', 422);
        }
        if (e instanceof SyntaxError) throw new AppError('UPSTREAM_ERROR', 502);
        const wait = c.retryBaseMs * 2 ** attempt;
        if (e.code !== 'UPSTREAM_ERROR' || attempt >= c.extractRetries || Date.now() + wait >= deadline)
          throw e;
        await delay(wait, undefined, { signal }).catch(() => { throw new AppError('STOPPED', 409); });
      }
    }
  }

  async channel(url, signal) {
    const now = Date.now();
    for (const [k, v] of this.cache) if (v.until < now) this.cache.delete(k);
    if (this.cache.has(url)) return this.cache.get(url).info;
    if (this.inflight.has(url)) return this.inflight.get(url);
    if (this.inflight.size >= this.config.maxResolvers) throw new AppError('CAPACITY', 503);
    const promise = this.extract(url, { signal })
      .then((info) => {
        if (this.cache.size >= this.config.maxCache) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(url, {
          info: { id: info.id, title: info.title, live_status: info.live_status },
          until: Date.now() + this.config.resolveCacheMs,
        });
        return info;
      })
      .catch((e) => {
        if (e.code === 'NOT_LIVE') throw new AppError('CHANNEL_NOT_LIVE', 422);
        throw e;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }
}
