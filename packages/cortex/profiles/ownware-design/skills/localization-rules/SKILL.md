---
name: localization-rules
description: 'RTL flipping, CJK type stacks, variable-length copy (German +30%, Japanese -50%), locale-aware Intl.DateTimeFormat / Intl.NumberFormat / Intl.PluralRules, cultural-color cautions. Use when the artifact will be shipped in more than one locale — multi-language landing pages, dashboards with international users, email blasts in multiple languages. Pairs with /typography-system (CJK fonts) and /copy-refiner (translation-safe phrasing). Skip for single-locale work.'
trigger: /localization-rules
---

# Localization Rules — RTL, CJK, plurals, dates, and cultural colour

## Overview

"Add German" is not a translation task; it's a layout task. German labels are ~30% longer than English; Japanese is ~50% shorter; Arabic flips the entire layout right-to-left. Hard-coded `text-align: left`, fixed-width buttons, and `new Date().toLocaleDateString()` without a locale argument all break the moment the site ships outside `en-US`.

This skill is the recipe for designing UI that survives RTL, CJK, and variable-length translation without a rewrite. Pairs with `/typography-system` (CJK type stacks) and `/copy-refiner` (translation-safe phrasing). Skip for single-locale projects — the discipline costs more than it returns.

---

## Critical Constraints — read these first, every time

1. **`text-align: start | end`, never `left | right`.** `start` follows the writing direction; in RTL, `start` is right-aligned, `end` is left-aligned. Hard-coded `left`/`right` breaks Arabic, Hebrew, Persian, Urdu.
2. **`margin-inline-*` / `padding-inline-*`, never `margin-left` / `padding-right`.** Logical properties flip with `dir="rtl"`. Physical properties don't.
3. **Containers flex, not fix.** Buttons, badges, tooltips — anything with translated copy — uses `width: auto` and a `min-width`, not a fixed width. German runs +30%; a fixed 120px button truncates at the M.
4. **CJK type needs a CJK fallback stack.** System-stack Latin fonts have no CJK glyphs; the browser substitutes one per glyph, producing visual chaos. Source Han Sans / Noto Sans CJK / per-OS system CJK fallback is the safe path.
5. **`Intl.*` for every date, number, currency, plural.** Never `'Sat, Nov 1, 2026'` hardcoded. Never `'$1,234.56'` hardcoded. Never `count + ' items'` hardcoded. The `Intl` API knows the locale conventions; you don't.
6. **Direction-aware icons.** Navigation chevrons (back, forward, indent) flip in RTL. Clocks, search magnifiers, semantic logos do not flip. Audit every icon for "is this directional?"
7. **Cultural-colour cautions.** Red = error in Western markets, luck and celebration in Chinese-speaking markets. White = mourning in some East Asian contexts, weddings in Western. Don't assume your colour system carries the same semantics globally — use icons + words alongside colour for any state communication.

---

## RTL — what flips and what doesn't

Set `dir="rtl"` on `<html>` for Arabic / Hebrew / Persian / Urdu locales. The browser flips most layout primitives automatically when you use logical properties.

### Flips automatically (with logical properties)

- Text direction (LTR ↔ RTL)
- Block layout (paragraphs, lists, headings)
- Flexbox row direction
- Grid column flow
- `margin-inline-start` / `margin-inline-end`
- `padding-inline-start` / `padding-inline-end`
- `border-inline-start` / `border-inline-end`
- `inset-inline-start` / `inset-inline-end`
- `text-align: start` / `text-align: end`

### Does NOT flip — handle manually

- Numerals stay LTR even in RTL text ("123" reads left-to-right inside "صفحة 123")
- Phone numbers, URLs, code blocks (`<bdi>` wraps them to preserve direction)
- Clocks (analog clock still rotates clockwise)
- Progress bars (start = filled-end is start, but check brand voice — "elapsed time" left-to-right reads naturally even in RTL)
- Directional icons that aren't navigation (search 🔍, eye 👁, lock 🔒 — same)
- Brand logos with text (Pepsi stays "Pepsi", not "ispeP")

### Icons that MUST flip in RTL

- Back / forward chevrons (`<`, `>`)
- Indent / outdent
- Send / reply (paper plane points forward)
- Bullet arrows in lists
- "Next" / "Previous" carousels

```css
[dir="rtl"] .icon-chevron-right { transform: scaleX(-1); }
[dir="rtl"] .icon-send          { transform: scaleX(-1); }
```

---

## CJK type stack

Chinese, Japanese, and Korean glyphs live in their own font files. System-stack Western fonts (`-apple-system`, `system-ui`) have CJK fallback on macOS / iOS but inconsistent fallback on Windows and Android. Add explicit CJK fonts to the stack:

```css
:root {
  --font-body:
    "Inter", -apple-system, "Segoe UI", "Roboto",
    /* Simplified Chinese */
    "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC",
    /* Traditional Chinese */
    "PingFang TC", "Microsoft JhengHei", "Source Han Sans TC", "Noto Sans TC",
    /* Japanese */
    "Hiragino Kaku Gothic ProN", "Yu Gothic", "Source Han Sans JP", "Noto Sans JP",
    /* Korean */
    "Apple SD Gothic Neo", "Malgun Gothic", "Source Han Sans KR", "Noto Sans KR",
    sans-serif;
}
```

For body type, prefer **Sans** CJK (`Source Han Sans` / `Noto Sans CJK`) — they read at small sizes. For display, **Source Han Serif** / **Noto Serif CJK** carries the magazine feel. Don't mix — pick one CJK family and stick.

CJK line-height runs higher than Latin — use `line-height: 1.7` on CJK body type vs 1.5 on Latin.

---

## Variable-length copy

| Language    | Length factor vs. English | Worked example                                 |
| ----------- | ------------------------- | ---------------------------------------------- |
| English     | 1.0×                      | "Cancel"                                       |
| German      | 1.3×                      | "Abbrechen"                                    |
| French      | 1.2×                      | "Annuler"                                      |
| Spanish     | 1.2×                      | "Cancelar"                                     |
| Russian     | 1.15×                     | "Отмена"                                       |
| Japanese    | 0.6×                      | "キャンセル" or shorter "中止"                  |
| Chinese     | 0.5×                      | "取消"                                         |
| Korean      | 0.7×                      | "취소"                                         |
| Arabic      | 1.05× + RTL flip          | "إلغاء"                                        |

Design containers to flex. A button row that fits 3 buttons at 120px each in English needs to flex to 156px in German — or wrap. Either is fine; truncation is not.

```css
.btn {
  /* DON'T: width: 120px; */
  /* DO: */
  min-width: 88px;       /* fits English + Chinese */
  padding-inline: 14px;  /* grows for German */
  white-space: nowrap;   /* but never truncate */
}

.btn-row {
  display: flex; flex-wrap: wrap; gap: 8px;
  /* wraps on overflow rather than truncating */
}
```

---

## Date, number, currency, plural — the Intl path

```js
// Date — locale-aware
new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date)
// → "Nov 1, 2026"
new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(date)
// → "01.11.2026"
new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(date)
// → "2026/11/01"
new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium" }).format(date)
// → "٠١‏/١١‏/٢٠٢٦"  (Eastern Arabic numerals, RTL)

// Number — locale-aware separator
new Intl.NumberFormat("en-US").format(1234567.89)  // "1,234,567.89"
new Intl.NumberFormat("de-DE").format(1234567.89)  // "1.234.567,89"
new Intl.NumberFormat("fr-FR").format(1234567.89)  // "1 234 567,89"

// Currency
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(19)
// → "$19.00"
new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(19)
// → "￥19"

// Plural — English has 2 forms, Russian has 3, Arabic has 6
const pr = new Intl.PluralRules("en-US");
pr.select(0) // "other"  → "0 items"
pr.select(1) // "one"    → "1 item"
pr.select(2) // "other"  → "2 items"

const ru = new Intl.PluralRules("ru-RU");
ru.select(1)  // "one"   → "1 элемент"
ru.select(2)  // "few"   → "2 элемента"
ru.select(5)  // "many"  → "5 элементов"
```

For full-message pluralization, ICU MessageFormat (via `messageformat`, `intl-messageformat`) handles `{count, plural, one {item} other {items}}` syntax. Don't roll your own conditional — the moment you hit Polish or Arabic, your `if (count === 1)` logic breaks.

---

## Cultural colour — what semantics travel

| Colour | Western default     | Notable other meanings                                  |
| ------ | ------------------- | ------------------------------------------------------- |
| Red    | Error, danger, stop | Luck, celebration, prosperity (Chinese speaking, parts of India)  |
| White  | Purity, weddings    | Mourning (parts of East Asia, parts of India)           |
| Green  | Success, money      | Islamic association in many Arab/Persian regions; political party colour in others |
| Yellow | Warning, caution    | Royalty / sacred (parts of Southeast Asia); cowardice (Western slang) |
| Black  | Formal, mourning    | Power, fashion, sophistication (cross-cultural mostly aligned) |
| Purple | Royalty, luxury     | Mourning (Catholic Latin America, Thailand)             |

Rule of thumb: don't communicate state with colour alone. Pair the red error with an icon + the word "Error". The icon is universal; the word is translated; the colour is decoration.

---

## Concrete examples

### Example 1 — a button + a date + a count rendered across 4 locales

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>Localization demo</title>
  <style>
    :root {
      --bg:#fafafa; --surface:#fff; --fg:#111; --muted:#6b6b6b;
      --accent:#2f6feb; --accent-fg:#fff; --border:#e5e5e5;
      --font-body:"Inter",-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",
                  "Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;
    }
    *,*::before,*::after { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg);
           font:15px/1.6 var(--font-body); padding:32px; }
    .locale {
      background:var(--surface); border:1px solid var(--border);
      padding:20px 24px; margin:0 0 16px; border-radius:8px;
    }
    .locale h3 { margin:0 0 12px; font-size:13px;
                 color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; }
    .row {
      display:flex; flex-wrap:wrap; gap:12px; align-items:center;
      margin-inline:0;       /* logical, flips in RTL */
    }
    .btn {
      min-width:88px; min-height:44px;
      padding-block:10px; padding-inline:16px;
      background:var(--accent); color:var(--accent-fg);
      border:0; border-radius:6px;
      font:inherit; font-weight:600;
      white-space:nowrap;
    }
    .count { font-variant-numeric: tabular-nums; }
    [dir="rtl"] body { font-family: "Geeza Pro","SF Arabic", var(--font-body); }
    [dir="rtl"] .row { line-height:1.8; }   /* Arabic needs more breathing room */
  </style>
</head>
<body>
  <section class="locale" lang="en-US" dir="ltr">
    <h3>en-US — English (United States)</h3>
    <div class="row">
      <button class="btn">Cancel order</button>
      <span class="date">Nov 1, 2026</span>
      <span class="count">3 items</span>
    </div>
  </section>

  <section class="locale" lang="de-DE" dir="ltr">
    <h3>de-DE — Deutsch (Deutschland)</h3>
    <div class="row">
      <button class="btn">Bestellung stornieren</button>
      <span class="date">01.11.2026</span>
      <span class="count">3 Artikel</span>
    </div>
  </section>

  <section class="locale" lang="ja-JP" dir="ltr">
    <h3>ja-JP — 日本語(日本)</h3>
    <div class="row">
      <button class="btn">注文をキャンセル</button>
      <span class="date">2026年11月1日</span>
      <span class="count">3点</span>
    </div>
  </section>

  <section class="locale" lang="ar-SA" dir="rtl">
    <h3>ar-SA — العربية (السعودية)</h3>
    <div class="row">
      <button class="btn">إلغاء الطلب</button>
      <span class="date">١ نوفمبر ٢٠٢٦</span>
      <span class="count">٣ عناصر</span>
    </div>
  </section>
</body>
</html>
```

Same structure, four locales. German button is widest — the row flexes. Japanese is tightest — no truncation, no awkward padding. Arabic flips entirely via `dir="rtl"` on the section; logical properties carry the rest. Dates and counts are locale-formatted (in production, by `Intl.*`).

### Example 2 — pluralization in three languages

```js
import IntlMessageFormat from "intl-messageformat";

const messages = {
  "en-US": "{count, plural, =0 {No items} one {1 item} other {# items}}",
  "ru-RU": "{count, plural, =0 {Нет элементов} one {# элемент} few {# элемента} many {# элементов} other {# элементов}}",
  "ar-SA": "{count, plural, =0 {لا توجد عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}",
};

function format(locale, count) {
  return new IntlMessageFormat(messages[locale], locale).format({ count });
}

format("en-US", 0);   // "No items"
format("en-US", 1);   // "1 item"
format("en-US", 5);   // "5 items"

format("ru-RU", 1);   // "1 элемент"
format("ru-RU", 2);   // "2 элемента"
format("ru-RU", 5);   // "5 элементов"

format("ar-SA", 0);   // "لا توجد عناصر"
format("ar-SA", 2);   // "عنصران"      (dual — Arabic-specific category)
format("ar-SA", 11);  // "11 عنصرًا"   (many)
```

English has 2 plural categories. Russian has 4. Arabic has 6 (including a dual). The Intl ruleset knows the categories; the message template names them; the count fills in. A naive `count === 1 ? "item" : "items"` ships wrong text in every Slavic and Semitic language.

---

## Anti-patterns

- **`text-align: left`.** Stop. `text-align: start` flips with `dir="rtl"`; `left` doesn't.
- **`margin-left: 16px`.** Stop. `margin-inline-start: 16px`. Logical properties cost the same to write and survive RTL.
- **Fixed-width buttons.** Stop. `min-width` + `padding-inline`, not `width`. German labels grow past your fixed value; Chinese labels float lonely inside it.
- **`new Date().toLocaleDateString()` without a locale.** Stop. That uses the *browser's* locale, which is not necessarily the *user's* selected locale. Pass it explicitly: `toLocaleDateString(currentLocale)`.
- **`count === 1 ? "item" : "items"`.** Stop. Two-form ternary works for English only. Use `Intl.PluralRules` or ICU MessageFormat.
- **Latin-only font stack on a CJK locale.** Stop. The browser substitutes per-glyph and your layout gets visual chaos. Add explicit CJK fonts to the stack.
- **Communicating state with colour alone.** Stop. Add the icon + the word. Cultural-colour semantics travel poorly; the icon and the translated word travel everywhere.
- **Mirroring icons that shouldn't mirror.** Stop. Clocks, search magnifiers, padlocks, brand marks do not flip in RTL. Navigation chevrons do.
