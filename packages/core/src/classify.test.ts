import { describe, expect, it } from 'vitest';
import { buildCanonicalKey, classifyEventType, extractTeam } from './classify.js';

describe('classifyEventType', () => {
  it('detects tournament winner', () => {
    expect(classifyEventType('Who will win the 2026 World Cup?')).toBe('tournament_winner');
  });
  it('detects golden boot', () => {
    expect(classifyEventType('Golden Boot Winner 2026')).toBe('golden_boot');
  });
  it('detects reach-stage markets', () => {
    expect(classifyEventType('Will England reach the semifinals?')).toBe('reach_stage');
  });
  it('detects group winner', () => {
    expect(classifyEventType('Group A winner')).toBe('group_winner');
  });
  it('detects match result', () => {
    expect(classifyEventType('Brazil vs Argentina')).toBe('match_result');
    expect(classifyEventType('France to beat Morocco')).toBe('match_result');
  });
  it('detects single-game winner markets (Polymarket per-match phrasing)', () => {
    // The high-volume per-game markets and their event-title-prefixed form.
    expect(classifyEventType('Will Belgium win on 2026-06-15?')).toBe('match_result');
    expect(classifyEventType('Belgium vs. Egypt: Will Egypt win on 2026-06-15?')).toBe('match_result');
    expect(classifyEventType('Will Belgium vs. Egypt end in a draw?')).toBe('match_result');
  });
  it('detects per-match goal scorer', () => {
    expect(classifyEventType('Mbappé anytime goalscorer vs England')).toBe('match_scorer');
    expect(classifyEventType('Will Messi score a goal?')).toBe('match_scorer');
  });
  it('keeps tournament Golden Boot separate from match scorer', () => {
    expect(classifyEventType('World Cup top goalscorer')).toBe('golden_boot');
  });
  it('falls back to other', () => {
    expect(classifyEventType('Some unrelated market')).toBe('other');
  });
});

describe('extractTeam', () => {
  it('finds canonical country by alias', () => {
    expect(extractTeam('Will Brasil win it all?')).toBe('brazil');
    expect(extractTeam('Three Lions to reach the final')).toBe('england');
    expect(extractTeam('Les Bleus golden boot')).toBe('france');
  });
  it('returns null when no team present', () => {
    expect(extractTeam('Total goals in the tournament')).toBeNull();
  });
});

describe('buildCanonicalKey', () => {
  it('is stable for the winner market across venues', () => {
    const a = buildCanonicalKey('tournament_winner', null, 'Who wins the World Cup?');
    const b = buildCanonicalKey('tournament_winner', 'brazil', 'Will Brazil win the World Cup?');
    expect(a).toBe('wc2026:winner');
    expect(b).toBe('wc2026:winner');
  });
  it('encodes team + stage for reach-stage', () => {
    expect(buildCanonicalKey('reach_stage', 'england', 'Will England reach the semifinal?')).toBe(
      'wc2026:england:semifinal',
    );
  });
  it('is order-independent for matchups', () => {
    const x = buildCanonicalKey('match_result', null, 'Brazil vs Argentina');
    const y = buildCanonicalKey('match_result', null, 'Argentina vs Brazil');
    expect(x).toBe(y);
  });
});
