export const DEFAULT_DENY = [
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'docs.google.com',
  'drive.google.com', 'notion.so', 'atlassian.net', 'slack.com', 'sharepoint.com',
  'localhost', '127.0.0.1'
];

const PRIVATE_IP = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

export function isDenied(host, list) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (PRIVATE_IP.test(h) || h.startsWith('[') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  for (const raw of list || []) {
    const entry = String(raw ?? '').trim().toLowerCase();
    if (!entry) continue;
    if (h === entry || h.endsWith('.' + entry)) return true;
  }
  return false;
}
