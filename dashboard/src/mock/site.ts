import type { ProjectSite } from '../api/contract';

/** Mock /site routes: the demo project has a storefront homepage; other projects have no public site yet. */
export function mockSite(pid: string): ProjectSite {
  if (pid !== 'prj_demo') return { origin: null, icon: null, image: null };
  const now = new Date();
  const icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e4572e"/><path d="M9 23 16 8l7 15M11.5 18h9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>');
  return { origin: 'https://shop.acme.example', icon, image: { day: now.toISOString().slice(0, 10), takenAt: now.toISOString() } };
}

/** A drawn stand-in for the screenshot (the real one is a JPEG taken by ScreenshotFunction). */
export function mockSiteImage(): { image: string } {
  const tiles = [0, 1, 2, 3].map((i) => {
    const x = 60 + i * 175;
    const hue = [18, 200, 140, 280][i];
    return `<rect x="${x}" y="300" width="155" height="120" rx="10" fill="hsl(${hue} 70% 85%)"/>
      <rect x="${x}" y="432" width="110" height="10" rx="5" fill="#2b2b33"/><rect x="${x}" y="450" width="60" height="9" rx="4" fill="#8a8a96"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
    <rect width="800" height="500" fill="#fbf8f3"/>
    <rect width="800" height="56" fill="#ffffff"/><rect y="55" width="800" height="1" fill="#e7e2da"/>
    <circle cx="74" cy="28" r="12" fill="#e4572e"/><rect x="94" y="21" width="90" height="14" rx="4" fill="#1d1d24"/>
    ${[0, 1, 2, 3].map((i) => `<rect x="${430 + i * 70}" y="23" width="50" height="10" rx="5" fill="#6b6b78"/>`).join('')}
    <rect x="60" y="96" width="380" height="30" rx="6" fill="#1d1d24"/><rect x="60" y="136" width="300" height="30" rx="6" fill="#1d1d24"/>
    <rect x="60" y="184" width="330" height="12" rx="6" fill="#8a8a96"/><rect x="60" y="204" width="260" height="12" rx="6" fill="#8a8a96"/>
    <rect x="60" y="236" width="128" height="38" rx="19" fill="#e4572e"/>
    <rect x="480" y="86" width="260" height="190" rx="16" fill="#f3d9c9"/><circle cx="610" cy="181" r="58" fill="#e4572e" opacity=".75"/>
    ${tiles}
  </svg>`;
  return { image: 'data:image/svg+xml;base64,' + btoa(svg) };
}
