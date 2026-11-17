export const PAGES = [
  { path: '/', w: 30 }, { path: '/pricing', w: 14 }, { path: '/products', w: 16 }, { path: '/products/aurora-lamp', w: 9 }, { path: '/products/nimbus-chair', w: 7 },
  { path: '/cart', w: 8 }, { path: '/checkout', w: 5 }, { path: '/blog/launch-week', w: 4 }, { path: '/docs/getting-started', w: 6 }, { path: '/login', w: 5 }, { path: '/account', w: 3 },
];
export const CLICKS = [
  { selector: '#signup-cta', text: 'Start free trial', track: 'signup-cta', tag: 'button', path: '/', w: 22, rage: 0.01 },
  { selector: 'button.add-to-cart', text: 'Add to cart', track: 'add-to-cart', tag: 'button', path: '/products/aurora-lamp', w: 18, rage: 0.02 },
  { selector: 'nav a[href="/pricing"]', text: 'Pricing', track: null, tag: 'a', path: '/', w: 14, rage: 0 },
  { selector: '#checkout-btn', text: 'Checkout', track: 'checkout', tag: 'button', path: '/cart', w: 10, rage: 0.06 },
  { selector: '.hero .btn-primary', text: 'Get started', track: null, tag: 'a', path: '/', w: 12, rage: 0.005 },
  { selector: 'a.docs-link', text: 'Read the docs', track: null, tag: 'a', path: '/docs/getting-started', w: 7, rage: 0 },
  { selector: 'button.newsletter-submit', text: 'Subscribe', track: 'newsletter', tag: 'button', path: '/blog/launch-week', w: 5, rage: 0.01 },
  { selector: '#theme-toggle', text: 'Toggle theme', track: null, tag: 'button', path: '/', w: 3, rage: 0 },
  { selector: '.promo-banner button', text: 'Claim offer', track: 'promo-claim', tag: 'button', path: '/', w: 6, rage: 0.22 },
  { selector: 'input#coupon + button', text: 'Apply', track: null, tag: 'button', path: '/checkout', w: 3, rage: 0.12 },
  { selector: 'footer a.twitter', text: null, track: null, tag: 'a', path: '/', w: 2, rage: 0 },
  // one buy button whose caption carries each product's price: alias it to see it as one row
  { selector: 'main > div.product > button.buy', text: 'Buy now – $129', track: null, tag: 'button', path: '/products/aurora-lamp', w: 6, rage: 0 },
  { selector: 'main > div.product > button.buy', text: 'Buy now – $349', track: null, tag: 'button', path: '/products/nimbus-chair', w: 4, rage: 0.01 },
  { selector: 'main > div.product > button.buy', text: 'Buy now – $39', track: null, tag: 'button', path: '/products/halo-mug', w: 3, rage: 0 },
];
export const ERRORS = [
  { fp: 'e1a9c3f07b2d', msg: "TypeError: Cannot read properties of undefined (reading 'price')", kind: 'error', source: '/assets/app-3f9a1c.js', url: '/cart', w: 30,
    stack: "TypeError: Cannot read properties of undefined (reading 'price')\n    at computeTotal (https://shop.acme.dev/assets/app-3f9a1c.js:1204:18)\n    at Array.reduce (<anonymous>)\n    at CartSummary (https://shop.acme.dev/assets/app-3f9a1c.js:1198:9)\n    at renderWithHooks (https://shop.acme.dev/node_modules/react-dom/cjs/react-dom.production.js:14985:18)\n    at updateFunctionComponent (https://shop.acme.dev/node_modules/react-dom/cjs/react-dom.production.js:17356:20)" },
  { fp: '7bd20e41c9a8', msg: 'Unhandled promise rejection: NetworkError when attempting to fetch resource', kind: 'rejection', source: '/assets/app-3f9a1c.js', url: '/checkout', w: 18,
    stack: 'Error: NetworkError when attempting to fetch resource\n    at fetchJson (https://shop.acme.dev/assets/app-3f9a1c.js:455:11)\n    at async submitOrder (https://shop.acme.dev/assets/app-3f9a1c.js:932:20)' },
  { fp: '3c55d9a2e610', msg: 'ResizeObserver loop completed with undelivered notifications.', kind: 'error', source: null, url: '/products', w: 14, stack: null },
  { fp: 'a04f7712bb3e', msg: 'Failed to load resource: https://cdn.acme.dev/img/hero@2x.webp', kind: 'resource', source: 'https://cdn.acme.dev/img/hero@2x.webp', url: '/', w: 9, stack: null },
  { fp: '5e8d13c0f9a7', msg: "ReferenceError: gtag is not defined", kind: 'error', source: '/assets/vendor-91ac.js', url: '/blog/launch-week', w: 6,
    stack: 'ReferenceError: gtag is not defined\n    at trackConversion (https://shop.acme.dev/assets/vendor-91ac.js:88:5)\n    at HTMLButtonElement.onClick (https://shop.acme.dev/assets/app-3f9a1c.js:2210:7)' },
  { fp: 'd912ab04e377', msg: 'checkout_failed: card declined (manual)', kind: 'manual', source: '/assets/app-3f9a1c.js', url: '/checkout', w: 4, stack: null },
];
export const HTTP_ERRORS = [
  { method: 'GET', route: '/api/products/:id', status: 500, w: 20, url: '/api/products/8841?include=stock', ms: 840 },
  { method: 'POST', route: '/api/checkout', status: 502, w: 14, url: '/api/checkout', ms: 4200 },
  { method: 'GET', route: '/api/cart', status: 401, w: 22, url: '/api/cart', ms: 95 },
  { method: 'POST', route: '/api/login', status: 429, w: 9, url: '/api/login', ms: 60 },
  { method: 'GET', route: '/api/search', status: 504, w: 7, url: '/api/search?q=lamp', ms: 10000 },
  { method: 'GET', route: 'https://cdn.acme.dev/img/:id', status: 0, w: 5, url: 'https://cdn.acme.dev/img/hero@2x.webp', ms: 0 },
  { method: 'PUT', route: '/api/cart/items/:id', status: 409, w: 4, url: '/api/cart/items/221', ms: 130 },
];
export const BROWSERS = [{ k: 'Chrome', w: 56 }, { k: 'Safari', w: 22 }, { k: 'Firefox', w: 9 }, { k: 'Edge', w: 8 }, { k: 'Samsung Internet', w: 3 }, { k: 'Opera', w: 2 }];
export const OSES = [{ k: 'Windows', w: 34 }, { k: 'macOS', w: 24 }, { k: 'iOS', w: 17 }, { k: 'Android', w: 16 }, { k: 'Linux', w: 8 }, { k: 'ChromeOS', w: 1 }];
export const DEVICES = [{ k: 'desktop', w: 58 }, { k: 'mobile', w: 37 }, { k: 'tablet', w: 5 }];
export const REFERRERS = [{ k: '(direct)', w: 38 }, { k: 'google.com', w: 29 }, { k: 'news.ycombinator.com', w: 11 }, { k: 't.co', w: 8 }, { k: 'github.com', w: 6 }, { k: 'reddit.com', w: 5 }, { k: 'linkedin.com', w: 3 }];
export const CUSTOM = ['checkout_completed', 'search', 'newsletter_signup', 'coupon_applied', 'video_played'];
export const SERVICES = ['api-gateway', 'auth-service', 'catalog-service', 'cart-service', 'payment-service', 'postgres'];

// [country, region, city, lat, lon] with traffic weight w
export const PLACES = [
  { c: 'US', r: 'California', city: 'San Francisco', lat: 37.8, lon: -122.4, w: 9 }, { c: 'US', r: 'New York', city: 'New York', lat: 40.7, lon: -74, w: 10 },
  { c: 'US', r: 'Texas', city: 'Austin', lat: 30.3, lon: -97.7, w: 4 }, { c: 'US', r: 'Washington', city: 'Seattle', lat: 47.6, lon: -122.3, w: 4 },
  { c: 'US', r: 'Illinois', city: 'Chicago', lat: 41.9, lon: -87.6, w: 4 }, { c: 'CA', r: 'Ontario', city: 'Toronto', lat: 43.7, lon: -79.4, w: 4 },
  { c: 'BR', r: 'São Paulo', city: 'São Paulo', lat: -23.6, lon: -46.6, w: 4 }, { c: 'MX', r: 'CDMX', city: 'Mexico City', lat: 19.4, lon: -99.1, w: 2 },
  { c: 'GB', r: 'England', city: 'London', lat: 51.5, lon: -0.1, w: 9 }, { c: 'DE', r: 'Berlin', city: 'Berlin', lat: 52.5, lon: 13.4, w: 6 },
  { c: 'SE', r: 'Stockholm County', city: 'Stockholm', lat: 59.3, lon: 18.1, w: 6 }, { c: 'FR', r: 'Île-de-France', city: 'Paris', lat: 48.9, lon: 2.4, w: 5 },
  { c: 'NL', r: 'North Holland', city: 'Amsterdam', lat: 52.4, lon: 4.9, w: 4 }, { c: 'ES', r: 'Madrid', city: 'Madrid', lat: 40.4, lon: -3.7, w: 3 },
  { c: 'IN', r: 'Karnataka', city: 'Bengaluru', lat: 13, lon: 77.6, w: 6 }, { c: 'JP', r: 'Tokyo', city: 'Tokyo', lat: 35.7, lon: 139.7, w: 5 },
  { c: 'SG', r: 'Singapore', city: 'Singapore', lat: 1.4, lon: 103.8, w: 3 }, { c: 'AU', r: 'New South Wales', city: 'Sydney', lat: -33.9, lon: 151.2, w: 4 },
  { c: 'ZA', r: 'Gauteng', city: 'Johannesburg', lat: -26.2, lon: 28, w: 2 }, { c: 'NG', r: 'Lagos', city: 'Lagos', lat: 6.5, lon: 3.4, w: 2 },
  { c: 'KR', r: 'Seoul', city: 'Seoul', lat: 37.6, lon: 127, w: 2 },
];
