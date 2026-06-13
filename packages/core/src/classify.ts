import { COUNTRY_ALIASES, type EventType } from './constants.js';

/**
 * Heuristic classification of a market title into a canonical EventType + team.
 * High-recall and deterministic; the engine can override with venue metadata.
 */
export function classifyEventType(title: string): EventType {
  const t = title.toLowerCase();
  if (/golden boot|top scorer|top goalscorer/.test(t)) return 'golden_boot';
  if (/\bwin(?:s|ner)?\b.*world cup|world cup.*winner|win the (?:2026 )?world cup/.test(t))
    return 'tournament_winner';
  if (/group [a-l]\b.*win|win.*group [a-l]\b|group [a-l] winner/.test(t)) return 'group_winner';
  if (/(reach|advance|qualif|make).*(final|semifinal|quarterfinal|round of|stage|knockout)/.test(t))
    return 'reach_stage';
  if (/total goals.*tournament|tournament.*total goals/.test(t)) return 'tournament_total_goals';
  if (/total goals|over\/under|o\/u/.test(t)) return 'match_total_goals';
  if (/\bvs\b|\bv\.\b| v |to beat|to win.*match/.test(t)) return 'match_result';
  if (/most goals.*team|team.*most goals/.test(t)) return 'top_scorer_team';
  return 'other';
}

/** Return canonical country slug present in the title, if any. */
export function extractTeam(title: string): string | null {
  const t = title.toLowerCase();
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.some((a) => new RegExp(`\\b${escapeRe(a)}\\b`).test(t))) return canonical;
  }
  return null;
}

/**
 * Build a cross-platform canonical key so the same logical market on different
 * venues can be linked for arbitrage. Stable & order-independent for matchups.
 */
export function buildCanonicalKey(eventType: EventType, team: string | null, title: string): string {
  const base = 'wc2026';
  switch (eventType) {
    case 'tournament_winner':
      return `${base}:winner`;
    case 'golden_boot':
      return `${base}:golden_boot`;
    case 'tournament_total_goals':
      return `${base}:total_goals`;
    case 'group_winner': {
      const g = title.toLowerCase().match(/group ([a-l])/)?.[1];
      return `${base}:group:${g ?? 'x'}`;
    }
    case 'reach_stage': {
      const stage =
        title.toLowerCase().match(/(final|semifinal|quarterfinal|round of \d+|knockout)/)?.[1] ??
        'stage';
      return `${base}:${team ?? 'team'}:${stage.replace(/\s+/g, '_')}`;
    }
    case 'match_result': {
      const teams = Object.entries(COUNTRY_ALIASES)
        .filter(([, aliases]) => aliases.some((a) => new RegExp(`\\b${escapeRe(a)}\\b`).test(title.toLowerCase())))
        .map(([c]) => c)
        .sort();
      return `${base}:match:${teams.join('_v_') || 'unknown'}`;
    }
    default:
      return `${base}:other:${team ?? 'na'}`;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
