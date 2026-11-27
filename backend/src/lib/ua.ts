export interface UaInfo {
  browser: string | null;
  os: string | null;
  device: 'desktop' | 'mobile' | 'tablet' | null;
}

/** Deliberately tiny UA classifier: good enough for breakdown charts, not for fingerprinting. */
export function parseUserAgent(ua: string): UaInfo {
  if (!ua) return { browser: null, os: null, device: null };

  const browser =
    /bot|crawl|spider|slurp|headless/i.test(ua) ? 'Bot'
    : /^wgo-flutter\//.test(ua) ? 'Flutter app' // the Flutter SDK (flutter/lib/src/device.dart)
    : /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Other';

  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Other';

  const device = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet' : /Mobi|iPhone|iPod/.test(ua) ? 'mobile' : 'desktop';

  return { browser, os, device };
}
