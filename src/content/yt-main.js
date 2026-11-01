// MAIN-world script (YouTube only). Answers {__slop: nonce, type: 'get-player'} requests from
// the isolated content script with the four player fields, never the full player response.
import { MSG_NS, extractPlayerInfo } from '../lib/youtube.js';

function onMessage(event) {
  try {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== 'get-player') return;
    const nonce = data[MSG_NS];
    if (typeof nonce !== 'string' || !nonce) return;
    const player = document.getElementById('movie_player');
    const pr = (typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null) ?? window.ytInitialPlayerResponse;
    const info = extractPlayerInfo(pr);
    if (!info) return;
    window.postMessage({ [MSG_NS]: nonce, type: 'player', ...info }, window.location.origin);
  } catch {
    // Reply nothing; the isolated side times out and falls back.
  }
}

window.addEventListener('message', onMessage);
