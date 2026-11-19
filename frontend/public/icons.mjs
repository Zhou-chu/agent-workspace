const svg = 'http://www.w3.org/2000/svg';
const paths = {
  home: 'M3 4h8v7H3zM14 4h7v4h-7zM3 14h8v6H3zM14 11h7v9h-7z',
  chat: 'M21 11.5a7.5 7.5 0 0 1-7.5 7.5H9l-5 3v-5a7.5 7.5 0 0 1 4.5-13.5h5a7.5 7.5 0 0 1 7.5 8Z',
  tasks: 'M9 6h11M9 12h11M9 18h11M3 6h2M3 12h2M3 18h2',
  agents: 'M4 7h16v10H4zM8 20h8m-4-3v3M8 11h1m6 0h1',
  settings: 'M4 7h5m4 0h7M4 12h10m4 0h2M4 17h3m4 0h9M9 5v4m5 1v4m-7 1v4',
  decisions: 'M7 12l3 3 6-6M4 4h16v16H4z',
  hash: 'M10 3L7 21M17 3l-3 18M4 9h17M3 15h17',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M19 12H5m6-6-6 6 6 6',
  refresh: 'M20 7v5h-5M19.5 12a7.5 7.5 0 1 0-1.5 4.5',
  people: 'M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m2-6h1a3 3 0 0 1 3 3v3M12 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm5-3a3 3 0 0 1 0 6',
  send: 'M12 19V5m-5 5 5-5 5 5',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v2a2 2 0 0 0 4 0v-2a8 8 0 1 0-3 6.2',
  reply: 'M10 7l-5 5 5 5m-5-5h10a4 4 0 0 1 4 4v2',
  thread: 'M5 5h14v11H9l-4 4V5Zm4 4h6m-6 3h4',
};

export function icon(name) {
  const element = document.createElementNS(svg, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) element.setAttribute(key, value);
  element.classList.add('icon');
  const path = document.createElementNS(svg, 'path');
  path.setAttribute('d', paths[name] ?? paths.home);
  element.append(path);
  return element;
}
