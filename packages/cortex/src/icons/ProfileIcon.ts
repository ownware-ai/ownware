/**
 * ProfileIcon — macOS-style squircle tile with a gradient fill and a Lucide glyph.
 *
 * This is the visual identity for a Cortex profile. A profile stores only two
 * values — { glyph, gradient } — and this module composes the tile at render time.
 */

import { GLYPHS, type GlyphName } from './glyphs.js';

export type ProfileGradient = 'violet' | 'teal' | 'rose' | 'mix' | 'slate';

export interface ProfileIconOptions {
  glyph: GlyphName;
  gradient?: ProfileGradient;
  /** Tile edge length in px. Corner radius auto-scales at 22% (Apple squircle). */
  size?: number;
}

/** Brand gradient stops — violet/teal/rose/mix match --cx-* tokens. */
const GRADIENTS: Record<ProfileGradient, string> = {
  violet: 'linear-gradient(135deg, #9B82FD 0%, #5A3AD8 100%)',
  teal:   'linear-gradient(135deg, #33DFBE 0%, #00A888 100%)',
  rose:   'linear-gradient(135deg, #FF7288 0%, #B91E3E 100%)',
  mix:    'linear-gradient(135deg, #9B82FD 0%, #00D4AA 55%, #F14060 100%)',
  slate:  'linear-gradient(135deg, #334155 0%, #0F1018 100%)',
};

/**
 * Return the raw SVG glyph markup for a name. Use this to compose your own
 * tile shape. For the standard squircle tile, use `profileIconHTML()` instead.
 */
export function glyphSVG(name: GlyphName, strokeWidth = 2): string {
  const body = GLYPHS[name];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/**
 * Return a complete HTML string for the profile icon tile.
 * Drop-in — no external CSS required.
 */
export function profileIconHTML(opts: ProfileIconOptions): string {
  const { glyph, gradient = 'violet', size = 56 } = opts;
  const radius = Math.round(size * 0.22); // Apple HIG squircle ratio
  const glyphSize = Math.round(size * 0.5);
  const fill = GRADIENTS[gradient];

  const styles = [
    `width:${size}px`,
    `height:${size}px`,
    `border-radius:${radius}px`,
    `background:${fill}`,
    `box-shadow:inset 0 1px 0 rgba(255,255,255,0.25),inset 0 -1px 0 rgba(0,0,0,0.15),0 4px 12px rgba(0,0,0,0.25),0 1px 3px rgba(0,0,0,0.15)`,
    `display:grid`,
    `place-items:center`,
    `color:#fff`,
    `flex-shrink:0`,
  ].join(';');

  const glyphStyles = `width:${glyphSize}px;height:${glyphSize}px`;
  const inner = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="${glyphStyles}">${GLYPHS[glyph]}</svg>`;

  return `<div class="profile-icon" style="${styles}" data-glyph="${glyph}" data-gradient="${gradient}">${inner}</div>`;
}

/**
 * Auto-pick a glyph + gradient from a free-text profile description.
 * Used by the creator agent when building a new profile.
 */
export function suggestIcon(description: string): { glyph: GlyphName; gradient: ProfileGradient } {
  const t = description.toLowerCase();

  // Keyword → (glyph, gradient) — first match wins
  const rules: Array<[RegExp, GlyphName, ProfileGradient]> = [
    [/market|campaign|brand|promot|announce/, 'megaphone', 'rose'],
    [/legal|contract|compliance|clause|redline/, 'scale', 'rose'],
    [/security|auditor|compliance|policy/, 'shield-check', 'rose'],
    [/lawyer|attorney/, 'scale', 'rose'],
    [/code|developer|programmer|engineer|refactor/, 'code', 'violet'],
    [/test|qa|spec/, 'flask-conical', 'violet'],
    [/devops|deploy|ci\b|cd\b|infra/, 'wrench', 'violet'],
    [/release|version|changelog|package/, 'package', 'violet'],
    [/architect|system design|diagram/, 'compass', 'violet'],
    [/bug|debug|triage|issue/, 'bug', 'rose'],
    [/research|investigate|study|survey/, 'microscope', 'teal'],
    [/search|competitor|scout|literature/, 'file-search', 'teal'],
    [/writer|writing|copy|blog|draft|editor/, 'pen-line', 'violet'],
    [/document|docs|guide|manual|reference/, 'book-open', 'teal'],
    [/analy|metric|report|dashboard|kpi/, 'bar-chart-3', 'teal'],
    [/data|database|query|sql|etl/, 'database', 'teal'],
    [/forecast|trend|growth/, 'trending-up', 'teal'],
    [/finance|budget|accounting|invoice|expense|tax/, 'dollar-sign', 'teal'],
    [/design|brand|visual|illustration/, 'palette', 'rose'],
    [/image|photo|graphic|mock/, 'image', 'rose'],
    [/brush|paint|illustrat/, 'brush', 'rose'],
    [/project|manager|task|status/, 'clipboard-list', 'slate'],
    [/schedule|calendar|meeting|appointment/, 'calendar', 'slate'],
    [/workflow|automat|pipeline/, 'workflow', 'violet'],
    [/recruit|hiring|interview|candidate/, 'user-check', 'teal'],
    [/team|people|hr\b|employee|onboard/, 'users', 'teal'],
    [/sales|deal|proposal|lead|pitch/, 'handshake', 'rose'],
    [/support|customer|success|ticket|help desk/, 'message-square', 'teal'],
    [/email|mail|newsletter|outreach/, 'mail', 'rose'],
    [/voice|podcast|audio|transcrib/, 'mic', 'rose'],
    [/notify|alert|remind/, 'bell', 'rose'],
    [/tutor|teach|learn|lesson|student|course/, 'graduation-cap', 'teal'],
    [/health|clinical|medic|patient|doctor/, 'stethoscope', 'teal'],
    [/global|international|translat|locale/, 'globe', 'mix'],
    [/ops|operations|admin|assist/, 'briefcase', 'slate'],
    [/idea|spark|creative|brainstorm/, 'sparkles', 'mix'],
    [/launch|ship|release/, 'rocket', 'violet'],
    [/goal|target|okr|focus/, 'target', 'rose'],
    [/fast|quick|instant|zap/, 'zap', 'mix'],
  ];

  for (const [pattern, glyph, gradient] of rules) {
    if (pattern.test(t)) return { glyph, gradient };
  }

  // Default
  return { glyph: 'sparkles', gradient: 'mix' };
}
